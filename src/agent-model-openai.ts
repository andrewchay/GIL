/**
 * OpenAI 兼容模型接入（chat/completions）。
 *
 * 设计边界：
 * - 模型只收到 instruction、domain、可用 action 列表和宿主固定的合同策略，
 *   **收不到任何事实、身份、Grant 或能力对象**——这由 SDK 的 propose 输入形状保证。
 * - 本类只负责"调用端点 + 解析出 JSON"。候选是否合法由 SDK 的 validateDraft
 *   与 actionClaims 哈希比对判定；被拒是特性，不是故障。
 * - API key 只出现在请求头；任何错误消息不得包含它。
 * - v1 不做重试：网络错误与限速直接 fail-fast，由调用方决定是否重试。
 */
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import type { Claim } from './agent-semantics.ts';
import type { ModelProvider } from './agent-sdk.ts';

export const MODEL_PROVIDER_PROFILE = 'gil-model-openai-0.1';

export interface OpenAIModelConfig {
  /** 例如 https://api.openai.com/v1 。非 loopback 地址必须使用 https。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 宿主固定的主张合同，键为 `domain:action`。进入提示词供模型回显。 */
  claimContracts?: Readonly<Record<string, Claim>>;
  /** 宿主固定的必需审阅，键为 action。进入提示词。 */
  actionReviews?: Readonly<Record<string, readonly string[]>>;
  timeoutMs?: number;
  maxTokens?: number;
}

const SYSTEM_PROMPT = [
  'You propose ONE structured action contract for an agent workflow.',
  'Reply with a single JSON object and nothing else: no markdown fences, no prose, no explanations.',
  'Required shape:',
  '{"domain":string,"goal":string,"action":string,"purpose":string,"fields":string[],"recipient":string|null,"destination":string,',
  ' "claim":{"kind":"Descriptive"|"Associational"|"Causal"|"Predictive"|"Normative","fact":string,"causalDesign":string|null,',
  '  "uncertainty":"None"|"ScenarioEnvelope"|"ConfidenceInterval","uncertaintyMethod":"None"|"Envelope"|"Statistical",',
  '  "requiresIndependentSources":boolean},"requiredReviews":string[]}',
  'Rules:',
  '- Use only the domain and one of the allowed actions given by the user.',
  '- If a mandatedClaimContracts entry exists for your chosen action, copy its claim object verbatim into "claim".',
  '- requiredReviews must include every review listed for the chosen action; you may not remove them.',
  '- "goal" is one sentence describing intent; it does not loosen any rule.',
  '- Output only the JSON object.',
].join('\n');

const fail = (code: string, message: string): never => { throw new GilError(code, message); };

function text(value: unknown, label: string, code = 'INVALID_MODEL_INPUT'): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
    fail(code, `${label} must be a non-empty string of at most 4096 characters`);
  }
  return value;
}

/** 剥掉 ``` 围栏；失败时尝试截取首尾大括号之间的片段。 */
export function parseModelJson(content: string): unknown {
  let text = content.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  try { return JSON.parse(text); } catch { /* 继续尝试子串提取 */ }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 放弃 */ }
  }
  return fail('MODEL_RESPONSE_INVALID', 'Completion does not contain a JSON object');
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens?: number;
  private readonly claimContracts: Readonly<Record<string, Claim>>;
  private readonly actionReviews: Readonly<Record<string, readonly string[]>>;

  constructor(config: OpenAIModelConfig) {
    hashValue(config); // 在反射之前拒绝 Proxy/getter/危险键
    if (!config || typeof config !== 'object') fail('INVALID_MODEL_CONFIG', 'Expected a config object');
    const key = text(config.apiKey, 'apiKey', 'INVALID_MODEL_CONFIG');
    const model = text(config.model, 'model', 'INVALID_MODEL_CONFIG');
    let url: URL;
    try { url = new URL(text(config.baseUrl, 'baseUrl', 'INVALID_MODEL_CONFIG')); } catch {
      fail('INVALID_MODEL_CONFIG', 'baseUrl must be an absolute URL');
    }
    if (url!.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url!.hostname)) {
      fail('INVALID_MODEL_CONFIG', 'http is only allowed for loopback hosts; use https');
    }
    if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 300000)) {
      fail('INVALID_MODEL_CONFIG', 'timeoutMs must be a safe integer between 100 and 300000');
    }
    if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)) {
      fail('INVALID_MODEL_CONFIG', 'maxTokens must be a positive safe integer');
    }
    if (config.claimContracts !== undefined) hashValue(config.claimContracts);
    if (config.actionReviews !== undefined) hashValue(config.actionReviews);
    this.baseUrl = url!.toString().replace(/\/+$/, '');
    this.apiKey = key;
    this.model = model;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxTokens = config.maxTokens;
    this.claimContracts = config.claimContracts ? structuredClone(config.claimContracts) : {};
    this.actionReviews = config.actionReviews ? structuredClone(config.actionReviews) : {};
  }

  async propose(input: { instruction: string; domain: string; actions: string[] }): Promise<unknown> {
    hashValue(input);
    const instruction = text(input.instruction, 'instruction');
    const domain = text(input.domain, 'domain');
    if (!Array.isArray(input.actions) || input.actions.length === 0 ||
        !input.actions.every(action => typeof action === 'string' && action.trim().length > 0)) {
      fail('INVALID_MODEL_INPUT', 'actions must be a non-empty array of non-empty strings');
    }
    // 把宿主策略转成模型可见的约束：它必须回显主张合同、不得删必需审阅。
    const mandated = input.actions.map(action => {
      const claim = this.claimContracts[`${domain}:${action}`];
      return { action, ...(claim ? { claim } : {}), ...(this.actionReviews[action]?.length ? { requiredReviews: this.actionReviews[action] } : {}) };
    });
    const user = JSON.stringify({ instruction, domain, allowedActions: input.actions, mandatedClaimContracts: mandated }, null, 2);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
          temperature: 0,
          ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && /timed? ?out|aborted/i.test(`${error.name} ${error.message}`);
      fail('MODEL_UNAVAILABLE', timedOut ? `Model endpoint timed out after ${this.timeoutMs}ms` : 'Model endpoint unreachable');
    }
    if (!response!.ok) fail('MODEL_UNAVAILABLE', `Model endpoint returned HTTP ${response!.status}`);
    let payload: unknown;
    try { payload = await response!.json(); } catch { fail('MODEL_RESPONSE_INVALID', 'Endpoint returned a non-JSON body'); }
    const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) fail('MODEL_RESPONSE_INVALID', 'Completion has no message content');
    return parseModelJson(content);
  }
}
