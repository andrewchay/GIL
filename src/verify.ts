// 统一验证入口：一个可信面组合全部静态检查，输出带版本的结果对象。
//
// 为什么存在：判定此前散在 checker / rl-checker / agent-semantics 等处，
// 消费者各自拼装检查路径会重建多个不可审计的"伪内核"。
// verify 是唯一建议入口；每个 check 带名字，失败带结构化 code，逐项报告不短路。
//
// 边界（重要）：只覆盖静态面。delegation / assurance gate 依赖运行时可变状态
// （Grant 有效性、预算、受信时钟、凭证），不属于也不应属于本入口；
// 消费者不得把 verify 输出当作授权判定——见 docs/verify.md。
import { parse, parseEnvironment } from './parser.ts';
import { link, check } from './checker.ts';
import { contentHash } from './canonical.ts';
import { checkEnvironment } from './rl-checker.ts';
import { evaluateSnapshot, validateSnapshot } from './agent-semantics.ts';
import { AGENT_PROFILE, validateDraft } from './agent-sdk.ts';
import { GilError } from './ast.ts';
import type { Diagnostic, Spec, Ontology } from './ast.ts';
import type { Environment } from './rl-ast.ts';

/** 结果对象自身的格式版本，与被验对象的 profile 分离：改输出结构时升这里。 */
export const VERIFY_VERSION = 'gil-verify-0.1';

export interface CheckResult { name: string; ok: boolean; code?: string; details?: string }
export interface VerifyResult {
  ok: boolean;
  /** 被验对象的 profile。 */
  profile: string;
  verifyVersion: string;
  checks: CheckResult[];
  hashes: Record<string, string>;
}

function codeOf(error: unknown): string { return error instanceof GilError ? error.code : 'IO_OR_INPUT_ERROR'; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function diagnosticsDetails(diagnostics: readonly Diagnostic[]): string | undefined {
  return diagnostics.length ? JSON.stringify(diagnostics) : undefined;
}
function finish(profile: string, checks: CheckResult[], hashes: Record<string, string>): VerifyResult {
  return { ok: checks.length > 0 && checks.every(c => c.ok), profile, verifyVersion: VERIFY_VERSION, checks, hashes };
}

/** Core 静态面：parse → link → check。任何一步失败都成为具名 check，不吞异常。 */
export function verifyCore(specText: string, ontologyTexts: readonly string[]): VerifyResult {
  const checks: CheckResult[] = [];
  const hashes: Record<string, string> = {};
  let spec: Spec | null = null;
  const ontologies: Ontology[] = [];
  try {
    const doc = parse(specText);
    if (doc.kind !== 'spec') throw new GilError('VERIFY_INPUT', `Expected spec document, got ${doc.kind}`);
    spec = doc as Spec;
    checks.push({ name: 'parse-spec', ok: true });
    hashes.spec = contentHash(spec);
  } catch (error) {
    checks.push({ name: 'parse-spec', ok: false, code: codeOf(error), details: messageOf(error) });
  }
  for (const [index, text] of ontologyTexts.entries()) {
    try {
      const doc = parse(text);
      if (doc.kind !== 'ontology') throw new GilError('VERIFY_INPUT', `Expected ontology document #${index}, got ${doc.kind}`);
      ontologies.push(doc as Ontology);
      checks.push({ name: `parse-ontology-${index}`, ok: true });
      hashes[`ontology-${index}`] = contentHash(doc);
    } catch (error) {
      checks.push({ name: `parse-ontology-${index}`, ok: false, code: codeOf(error), details: messageOf(error) });
    }
  }
  if (spec !== null && ontologies.length === ontologyTexts.length) {
    try {
      const linked = link(spec, ontologies);
      checks.push({ name: 'link', ok: true });
      // link 已强制精确 name@version 匹配；这里把绑定结果显式报出来供审计读取。
      const bindings = spec.imports.filter(item => item.layer !== 'lexicon').map(item => {
        const resolved = ontologies.find(o => `${o.name}@${o.version}` === item.name);
        return { import: item.name, alias: item.alias, resolved: resolved ? `${resolved.name}@${resolved.version}` : null };
      });
      checks.push({ name: 'ontology-version-bindings', ok: bindings.every(b => b.resolved !== null),
        details: JSON.stringify(bindings) });
      const diagnostics: Diagnostic[] = check(linked);
      checks.push({ name: 'core-check', ok: diagnostics.length === 0, details: diagnosticsDetails(diagnostics) });
    } catch (error) {
      checks.push({ name: 'link', ok: false, code: codeOf(error), details: messageOf(error) });
    }
  }
  return finish('gil-core-clinical-0.1', checks, hashes);
}

/** RL 静态面：parseEnvironment → checkEnvironment（结构一致性，不推断转移语义）。 */
export function verifyRl(envText: string): VerifyResult {
  const checks: CheckResult[] = [];
  const hashes: Record<string, string> = {};
  try {
    const env: Environment = parseEnvironment(envText);
    checks.push({ name: 'parse-environment', ok: true });
    hashes.environment = contentHash(env);
    const diagnostics = checkEnvironment(env);
    checks.push({ name: 'rl-structure', ok: diagnostics.length === 0, details: diagnosticsDetails(diagnostics) });
  } catch (error) {
    checks.push({ name: 'parse-environment', ok: false, code: codeOf(error), details: messageOf(error) });
  }
  return finish('gil-rl-experimental', checks, hashes);
}

/** Agent 合同静态面：draft 结构 → 快照结构 → 判定 dry-run。 */
export interface AgentContractInput { draft: unknown; snapshot: unknown }
export function verifyAgentInput(value: unknown): AgentContractInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GilError('VERIFY_INPUT', 'Expected object with draft and snapshot');
  }
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 2 || !('draft' in r) || !('snapshot' in r)) {
    throw new GilError('VERIFY_INPUT', 'Contract file must have exactly draft and snapshot fields');
  }
  return { draft: r.draft, snapshot: r.snapshot };
}
export function verifyAgent(contract: AgentContractInput): VerifyResult {
  const checks: CheckResult[] = [];
  let draft: ReturnType<typeof validateDraft> | null = null;
  let snapshot: ReturnType<typeof validateSnapshot> | null = null;
  try {
    draft = validateDraft(contract.draft);
    checks.push({ name: 'draft-structure', ok: true });
  } catch (error) {
    checks.push({ name: 'draft-structure', ok: false, code: codeOf(error), details: messageOf(error) });
  }
  try {
    snapshot = validateSnapshot(contract.snapshot);
    checks.push({ name: 'snapshot-structure', ok: true });
  } catch (error) {
    checks.push({ name: 'snapshot-structure', ok: false, code: codeOf(error), details: messageOf(error) });
  }
  if (draft !== null && snapshot !== null) {
    try {
      // dry-run：报告判定可执行且结果可复现，不替业务宣布"正确"。
      const report = evaluateSnapshot(snapshot, draft.claim);
      checks.push({ name: 'snapshot-verdict', ok: true, details: JSON.stringify(report) });
    } catch (error) {
      checks.push({ name: 'snapshot-verdict', ok: false, code: codeOf(error), details: messageOf(error) });
    }
  }
  return finish(AGENT_PROFILE, checks, {});
}
