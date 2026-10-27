// Phase4 验证保障层：合成凭证 + 过程内注册表。
// 本文件不产生真实签名、真实认证或监管结论；所有 hash 均为合成输入的内容摘要。
// 签发权威只存在于进程内注册表（WeakMap），序列化后的 JSON 不携带任何权威。
import { types } from 'node:util';
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import type { Attestation, AttestationResult, AssuranceEvaluation, Challenge, ReviewInput } from './assurance-ast.ts';

export type { Attestation, AttestationResult, AssuranceEvaluation, Challenge, ReviewInput } from './assurance-ast.ts';

export const ASSURANCE_PROFILE = 'gil-assurance-attestation-0.1';
export const ATTESTATION_VERSION = '0.1';
export const CHALLENGE_VERSION = '0.1';

const METHODS: readonly Attestation['method'][] = ['HumanReview', 'DocumentCheck'];
const RESULTS: readonly AttestationResult[] = ['Pass', 'Fail', 'Unknown'];
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const ATTESTATION_KEYS = ['kind', 'version', 'id', 'result', 'verifierId', 'method', 'methodVersion',
  'specHash', 'targetHash', 'contextHash', 'coverage', 'assumptions', 'issuedAt', 'validUntil'];
const CHALLENGE_KEYS = ['kind', 'id', 'version', 'targetAttestationId', 'targetHash', 'reason', 'raisedBy', 'at'];
const ISSUE_KEYS = ['evidenceHash', 'targetHash', 'requirementHash', 'contextHash', 'coverage', 'assumptions', 'validUntil', 'result'];
const CONFIG_KEYS = ['now', 'verifierId', 'verifierRole', 'submitterId', 'specHash', 'method', 'methodVersion'];

export interface AssuranceConfig {
  now: () => number; verifierId: string; verifierRole: 'CRA'; submitterId: string;
  specHash: string; method: string; methodVersion: string;
}
export interface IssueInput {
  evidenceHash: string; targetHash?: string; requirementHash: string; contextHash: string;
  coverage: string[]; assumptions: string[]; validUntil: number; result: AttestationResult;
}
export interface CurrentBindings { targetHash: string; contextHash: string; specHash: string; evidenceHash: string }
export interface Revocation { attestationId: string; revoked: true; alreadyRevoked: boolean }
export interface ChallengeReceipt { id: string; targetAttestationId: string; alreadyRaised: boolean }
/** 只读审计视图：原始 result 保留可查，但只有 evaluate 的判定可作为通过依据。 */
export interface Inspection {
  hash: string; attestation: Attestation; evidenceHash: string; requirementHash: string;
  review: ReviewInput; revoked: boolean; revokedBy: string | null; revokedAt: number | null; challenges: Challenge[];
}
/** 过程内合成注册表能力。JSON 无法重建；伪造对象在 WeakMap 中查不到。 */
export interface Registry { readonly kind: 'assurance-registry' }

interface Config { now: () => number; verifierId: string; submitterId: string; specHash: string; method: Attestation['method']; methodVersion: string }
interface Stored {
  attestation: Attestation; hash: string; evidenceHash: string; requirementHash: string;
  revoked: boolean; revokedBy: string | null; revokedAt: number | null; challenges: Challenge[];
}
interface Internal { config: Config; records: Record<string, Stored>; order: string[]; version: number }
interface Cell { value: Internal; busy: boolean; lastTime: number; reentered: boolean }

const registries = new WeakMap<Registry, Cell>();

const fail = (code: string, message: string): never => { throw new GilError(code, message); };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 规范化副本：hashValue 在读取前拒绝 Proxy/getter/符号/危险键，随后才做结构化克隆。 */
function copy<T>(value: T): T { hashValue(value); return structuredClone(value) as T; }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** 只通过自有属性描述符读取，绝不触发 getter 或 Proxy trap。 */
function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (!record(value) || types.isProxy(value)) fail(code, 'Plain object required');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(code, 'Plain object required');
  if (Object.getOwnPropertySymbols(value).length) fail(code, 'Symbol properties are not allowed');
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (DANGEROUS.has(key)) fail(code, `Unsafe property ${key}`);
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code, `Accessor property ${key} is not data`);
    out[key] = descriptor.value;
  }
  return out;
}

function strings(value: unknown, code: string, label: string, required: boolean): string[] {
  if (types.isProxy(value) || !Array.isArray(value)) fail(code, `${label} must be a plain string array`);
  const clean = copy(value) as unknown[];
  if (required && !clean.length) fail(code, `${label} must not be empty`);
  if (!clean.every(text)) fail(code, `${label} must contain non-empty strings`);
  return clean as string[];
}

function cellFor(registry: Registry): Cell {
  // WeakMap 查询不触发伪造对象上的任何 trap。
  const cell = registries.get(registry);
  if (!cell) fail('UNTRUSTED_REGISTRY', 'Use createAssurance; serialized registries convey no authority');
  if (cell.busy) { cell.reentered = true; fail('REENTRANT_REGISTRY', 'Reentrant registry operations are not trusted'); }
  return cell;
}
function locked<T>(registry: Registry, fn: (cell: Cell) => T): T {
  const cell = cellFor(registry); cell.busy = true; cell.reentered = false;
  try { return fn(cell); } finally { cell.busy = false; }
}
function clock(cell: Cell): number {
  const time = cell.value.config.now();
  if (cell.reentered) fail('REENTRANT_REGISTRY', 'Clock attempted a reentrant registry operation');
  if (!finite(time) || time < cell.lastTime) fail('INVALID_CLOCK', 'Clock must return finite monotonic times');
  cell.lastTime = time;
  return time;
}
function commit(cell: Cell, changes: Partial<Internal>): void {
  cell.value = Object.freeze({ ...cell.value, ...changes });
}
function findHash(state: Internal, attestationId: string): string | undefined {
  for (const hash of state.order) {
    const stored = state.records[hash];
    if (stored && stored.attestation.id === attestationId) return hash;
  }
  return undefined;
}
function storedOf(state: Internal, hash: string): Stored {
  if (!text(hash) || !Object.hasOwn(state.records, hash)) fail('UNKNOWN_ATTESTATION', 'Use an attestation issued by this registry');
  return state.records[hash];
}

/**
 * 建立合成验证注册表。签发身份在配置期固定：必须声明为 CRA，且与证据提交者不同人。
 * 这是人员隔离的过程内模拟，不是真实身份系统或认证结果。
 */
export function createAssurance(config: AssuranceConfig): Registry {
  if (!record(config) || types.isProxy(config)) fail('INVALID_CONFIG', 'Plain assurance configuration required');
  const proto = Object.getPrototypeOf(config);
  if (proto !== Object.prototype && proto !== null) fail('INVALID_CONFIG', 'Plain assurance configuration required');
  if (Object.getOwnPropertySymbols(config).length) fail('INVALID_CONFIG', 'Symbols are not configuration');
  const data: Record<string, unknown> = Object.create(null);
  let now: (() => number) | undefined;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(config))) {
    if (DANGEROUS.has(key)) fail('INVALID_CONFIG', 'Unsafe configuration key');
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_CONFIG', 'Accessors are not configuration');
    if (key === 'now') {
      if (typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) fail('INVALID_CLOCK', 'Plain clock function required');
      now = descriptor.value;
    } else data[key] = descriptor.value;
  }
  if (!now) fail('INVALID_CLOCK', 'Provide a synthetic clock adapter');
  if (Object.keys(data).some(key => !CONFIG_KEYS.includes(key))) fail('INVALID_CONFIG', 'Unknown configuration key');
  if (!text(data.verifierId) || !text(data.submitterId) || !text(data.specHash) || !text(data.methodVersion)) {
    fail('INVALID_CONFIG', 'Issuer, submitter, spec hash and method version are required');
  }
  if (data.verifierRole !== 'CRA') fail('ISSUER_NOT_CRA', 'Only a synthetic CRA verifier may issue attestations');
  if (data.verifierId === data.submitterId) fail('PERSON_SEPARATION', 'Verifier must differ from the evidence submitter');
  if (!text(data.method) || !METHODS.includes(data.method as Attestation['method'])) {
    fail('INVALID_METHOD', 'Only HumanReview or DocumentCheck are inside this profile');
  }
  const fixed: Config = Object.freeze({
    now, verifierId: data.verifierId, submitterId: data.submitterId, specHash: data.specHash,
    method: data.method as Attestation['method'], methodVersion: data.methodVersion,
  });
  const registry: Registry = Object.freeze({ kind: 'assurance-registry' });
  const value: Internal = Object.freeze({ config: fixed, records: Object.freeze({}), order: Object.freeze([]) as string[], version: 0 });
  registries.set(registry, { value, busy: false, lastTime: -Number.MAX_VALUE, reentered: false });
  // 时钟适配器在能力受保护时验证；失败则丢弃半成品注册表。
  try { locked(registry, cell => { clock(cell); }); } catch (error) { registries.delete(registry); throw error; }
  return registry;
}

/**
 * 公开凭证字段的内容摘要。纯函数；但摘要只覆盖 Attestation 的公开字段。
 * evidenceHash / requirementHash 只存在于注册表内部绑定，不在共享接口形状里，
 * 因此外部 JSON 无法凭摘要重建签发权威，evaluate 也永远以注册表记录为准。
 */
export function attestationHash(attestation: Attestation): string {
  const out = plainRecord(attestation, 'INVALID_ATTESTATION');
  if (Object.keys(out).length !== ATTESTATION_KEYS.length || !ATTESTATION_KEYS.every(key => Object.hasOwn(out, key))) {
    fail('INVALID_ATTESTATION', 'Attestation fields must match the shared shape exactly');
  }
  if (out.kind !== 'attestation' || !text(out.version) || !text(out.id) || !text(out.verifierId) || !text(out.methodVersion)
    || !text(out.specHash) || !text(out.targetHash) || !text(out.contextHash)) {
    fail('INVALID_ATTESTATION', 'Attestation identity fields must be non-empty strings');
  }
  if (!RESULTS.includes(out.result as AttestationResult)) fail('INVALID_RESULT', 'Result must be Pass, Fail or Unknown');
  if (!METHODS.includes(out.method as Attestation['method'])) fail('INVALID_METHOD', 'Unsupported attestation method');
  if (!finite(out.issuedAt) || !finite(out.validUntil) || out.issuedAt >= out.validUntil) {
    fail('INVALID_VALIDITY', 'Attestation requires issuedAt < validUntil');
  }
  const coverage = strings(out.coverage, 'INVALID_COVERAGE', 'coverage', true);
  if (new Set(coverage).size !== coverage.length) fail('DUPLICATE_COVERAGE', 'Coverage entries must be unique');
  const assumptions = strings(out.assumptions, 'INVALID_ASSUMPTIONS', 'assumptions', false);
  return hashValue({ profile: ASSURANCE_PROFILE, attestation: {
    kind: 'attestation', version: out.version, id: out.id, result: out.result, verifierId: out.verifierId,
    method: out.method, methodVersion: out.methodVersion, specHash: out.specHash, targetHash: out.targetHash,
    contextHash: out.contextHash, coverage, assumptions, issuedAt: out.issuedAt, validUntil: out.validUntil } });
}

/**
 * 签发合成凭证。签名或 JSON 均不能触发签发：只有注册表内部的签发路径能产生可 evaluate 的凭证。
 * validUntil 必须严格晚于当前合成时间；coverage 非空且不重复。
 */
export function issue(registry: Registry, input: IssueInput): Attestation {
  return locked(registry, cell => {
    const raw = plainRecord(input, 'INVALID_ATTESTATION');
    if (Object.keys(raw).some(key => !ISSUE_KEYS.includes(key))) fail('INVALID_ATTESTATION', 'Unknown issuance field');
    if (!text(raw.evidenceHash) || !text(raw.requirementHash) || !text(raw.contextHash)) {
      fail('INVALID_ATTESTATION', 'Issuance requires evidence, requirement and context hashes');
    }
    // targetHash 省略时绑定证据摘要本身，避免出现未绑定的凭证。
    const target = raw.targetHash === undefined ? raw.evidenceHash : raw.targetHash;
    if (!text(target)) fail('INVALID_ATTESTATION', 'targetHash must be a non-empty string when provided');
    const coverage = strings(raw.coverage, 'INVALID_COVERAGE', 'coverage', true);
    if (new Set(coverage).size !== coverage.length) fail('DUPLICATE_COVERAGE', 'Coverage entries must be unique');
    const assumptions = strings(raw.assumptions, 'INVALID_ASSUMPTIONS', 'assumptions', false);
    if (!RESULTS.includes(raw.result as AttestationResult)) fail('INVALID_RESULT', 'Result must be Pass, Fail or Unknown');
    if (!finite(raw.validUntil)) fail('INVALID_VALIDITY', 'validUntil must be a finite synthetic time');
    const time = clock(cell);
    if (raw.validUntil <= time) fail('INVALID_VALIDITY', 'validUntil must be strictly after the issuance time');
    const state = cell.value;
    // 签发身份只来自配置；提交者与验证者不同人已在配置期强制。
    const binding = { evidenceHash: raw.evidenceHash, requirementHash: raw.requirementHash, targetHash: target,
      contextHash: raw.contextHash, coverage, assumptions, result: raw.result, validUntil: raw.validUntil,
      issuedAt: time, specHash: state.config.specHash, method: state.config.method,
      methodVersion: state.config.methodVersion, seq: state.order.length + 1 };
    const id = `att-${hashValue({ profile: ASSURANCE_PROFILE, binding }).slice('sha256:'.length, 'sha256:'.length + 24)}`;
    const attestation = freeze<Attestation>({
      kind: 'attestation', version: ATTESTATION_VERSION, id, result: raw.result as AttestationResult,
      verifierId: state.config.verifierId, method: state.config.method, methodVersion: state.config.methodVersion,
      specHash: state.config.specHash, targetHash: target, contextHash: raw.contextHash,
      coverage, assumptions, issuedAt: time, validUntil: raw.validUntil,
    });
    const hash = attestationHash(attestation);
    if (Object.hasOwn(state.records, hash)) fail('DUPLICATE_ATTESTATION', 'Issued attestation hash already exists');
    const stored = freeze<Stored>({ attestation, hash, evidenceHash: raw.evidenceHash, requirementHash: raw.requirementHash,
      revoked: false, revokedBy: null, revokedAt: null, challenges: [] as Challenge[] });
    commit(cell, { records: freeze({ ...state.records, [hash]: stored }), order: freeze([...state.order, hash]),
      version: state.version + 1 });
    return attestation;
  });
}

/**
 * 评估当前绑定是否仍支撑该凭证。
 * 顺序固定：REVOKED、EXPIRED、SPEC_CHANGED、TARGET_MISMATCH、CONTEXT_MISMATCH、EVIDENCE_CHANGED、CHALLENGED。
 * 任一项成立即 active=false，且对外 result 强制降级为 'Unknown'（原始 result 只在 inspect 中保留）。
 * 通过 = (result === 'Pass' && active)；降级后 'Pass' 不可能再出现，因此 result 就是唯一判定依据。
 */
export function evaluate(registry: Registry, attestationHashValue: string, current: CurrentBindings): AssuranceEvaluation {
  return locked(registry, cell => {
    if (!text(attestationHashValue)) fail('INVALID_HASH', 'Attestation hash must be a non-empty string');
    const now = clock(cell);
    const raw = plainRecord(current, 'INVALID_CONTEXT');
    const keys = ['targetHash', 'contextHash', 'specHash', 'evidenceHash'];
    if (Object.keys(raw).length !== keys.length || !keys.every(key => Object.hasOwn(raw, key) && text(raw[key]))) {
      fail('INVALID_CONTEXT', 'Current bindings require target, context, spec and evidence hashes');
    }
    const state = cell.value;
    const stored = storedOf(state, attestationHashValue);
    if (attestationHash(stored.attestation) !== stored.hash) fail('ATTESTATION_TAMPERED', 'Stored attestation no longer matches its hash');
    const reasons: string[] = [];
    if (stored.revoked) reasons.push('REVOKED');
    if (now >= stored.attestation.validUntil) reasons.push('EXPIRED');
    if (raw.specHash !== stored.attestation.specHash) reasons.push('SPEC_CHANGED');
    if (raw.targetHash !== stored.attestation.targetHash) reasons.push('TARGET_MISMATCH');
    if (raw.contextHash !== stored.attestation.contextHash) reasons.push('CONTEXT_MISMATCH');
    if (raw.evidenceHash !== stored.evidenceHash) reasons.push('EVIDENCE_CHANGED');
    if (stored.challenges.length) reasons.push('CHALLENGED');
    const active = reasons.length === 0;
    // 降级语义：失效凭证的对外结果一律为 Unknown，历史 result 不参与通过判定。
    const result: AttestationResult = active ? stored.attestation.result : 'Unknown';
    return freeze<AssuranceEvaluation>({ result, active, reasons });
  });
}

/** 撤销为幂等操作：重复撤销不报错、不新增历史，仅回报 alreadyRevoked。 */
export function revoke(registry: Registry, attestationId: string, actor: string): Revocation {
  return locked(registry, cell => {
    if (!text(attestationId)) fail('INVALID_ID', 'Attestation id must be a non-empty string');
    if (!text(actor)) fail('REVOKE_FORBIDDEN', 'Revocation requires an explicit synthetic actor');
    const state = cell.value;
    // 撤销属于验证方管理动作：只允许配置的 CRA，其他主体（含上传者/agent）一律拒绝。
    if (actor !== state.config.verifierId) fail('REVOKE_FORBIDDEN', 'Only the configured synthetic CRA verifier may revoke');
    const time = clock(cell);
    const hash = findHash(state, attestationId);
    if (!hash) fail('UNKNOWN_ATTESTATION', 'Unknown attestation id in this registry');
    const stored = state.records[hash];
    if (stored.revoked) return freeze<Revocation>({ attestationId, revoked: true, alreadyRevoked: true });
    const next = freeze<Stored>({ ...stored, revoked: true, revokedBy: actor, revokedAt: time });
    commit(cell, { records: freeze({ ...state.records, [hash]: next }), version: state.version + 1 });
    return freeze<Revocation>({ attestationId, revoked: true, alreadyRevoked: false });
  });
}

/**
 * 有效挑战使目标凭证永久失去 active 状态，但凭证与挑战历史全部保留。
 * 有效性条件：目标存在、targetHash 与被挑战凭证一致、理由/提出者非空、at 不早于签发时间、提出者不是签发者本人。
 * 同 id 重复提交幂等。
 */
export function challenge(registry: Registry, value: Challenge): ChallengeReceipt {
  return locked(registry, cell => {
    const raw = plainRecord(value, 'INVALID_CHALLENGE');
    if (Object.keys(raw).length !== CHALLENGE_KEYS.length || !CHALLENGE_KEYS.every(key => Object.hasOwn(raw, key))) {
      fail('INVALID_CHALLENGE', 'Challenge fields must match the shared shape exactly');
    }
    if (raw.kind !== 'challenge') fail('INVALID_CHALLENGE', 'Challenge kind must be challenge');
    if (!text(raw.id) || !text(raw.version) || !text(raw.targetAttestationId) || !text(raw.targetHash)
      || !text(raw.reason) || !text(raw.raisedBy)) fail('INVALID_CHALLENGE', 'Challenge fields must be non-empty strings');
    if (!finite(raw.at)) fail('INVALID_CHALLENGE', 'Challenge requires a finite synthetic time');
    const state = cell.value;
    if (raw.raisedBy === state.config.verifierId) fail('CHALLENGE_SEPARATION', 'The issuing verifier cannot challenge its own attestation');
    const hash = findHash(state, raw.targetAttestationId);
    if (!hash) fail('UNKNOWN_ATTESTATION', 'Challenge target is not in this registry');
    const stored = state.records[hash];
    if (raw.targetHash !== stored.attestation.targetHash) fail('CHALLENGE_MISMATCH', 'Challenge must name the attested target hash');
    if (raw.at < stored.attestation.issuedAt) fail('INVALID_CHALLENGE', 'Challenge cannot predate the attestation');
    if (stored.challenges.some(item => item.id === raw.id)) {
      return freeze<ChallengeReceipt>({ id: raw.id as string, targetAttestationId: raw.targetAttestationId as string, alreadyRaised: true });
    }
    const created = freeze<Challenge>({ kind: 'challenge', id: raw.id, version: raw.version,
      targetAttestationId: raw.targetAttestationId, targetHash: raw.targetHash, reason: raw.reason,
      raisedBy: raw.raisedBy, at: raw.at });
    const next = freeze<Stored>({ ...stored, challenges: freeze([...stored.challenges, created]) });
    commit(cell, { records: freeze({ ...state.records, [hash]: next }), version: state.version + 1 });
    return freeze<ChallengeReceipt>({ id: created.id, targetAttestationId: created.targetAttestationId, alreadyRaised: false });
  });
}

/** 只读审计：历史不可原地修改，原始 result 仅在此可见，不作为通过依据。 */
export function inspect(registry: Registry, attestationHashValue: string): Inspection {
  return locked(registry, cell => {
    const stored = storedOf(cell.value, attestationHashValue);
    const attestation = stored.attestation;
    const review: ReviewInput = freeze({ evidenceHash: stored.evidenceHash, attestationId: attestation.id,
      requirementHash: stored.requirementHash, specHash: attestation.specHash });
    return freeze<Inspection>({ hash: stored.hash, attestation, evidenceHash: stored.evidenceHash,
      requirementHash: stored.requirementHash, review, revoked: stored.revoked, revokedBy: stored.revokedBy,
      revokedAt: stored.revokedAt, challenges: stored.challenges });
  });
}
