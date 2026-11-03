/**
 * 决策日志：只追加，不原地修改。
 *
 * 用途是让"判定是否稳定、是否与事实一致"成为可测的问题。当前 GIL 的测试
 * 全部落在自洽性（同一输入得同一结论），没有任何一条证据回答"判对了吗"。
 * 没有这个日志，后者无法开始。
 *
 * 边界：
 * - 不是审计主记录，没有签名、没有跨进程事务。
 * - 回填 ground truth 是独立追加事件，绝不改写原判定。
 * - 内容哈希证明记录未被篡改，不证明记录在写入时是正确的。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import type { EvaluationReport } from './agent-semantics.ts';

export const DECISION_LOG_PROFILE = 'gil-decision-log-0.1';

export type Verdict = 'True' | 'False' | 'Unknown';
export type ObservationVerdict = 'Observed' | 'ConfirmedAbsent' | 'NotObserved' | 'UnableToDetermine';
export type Outcome = 'Succeeded' | 'Failed' | 'Unknown' | 'NotExecuted';
/** 三种来源可信度不同，报表必须分开统计，不能合成一个数。 */
export type GroundTruthSource = 'audit' | 'expert-consensus' | 'downstream-data';

export interface DecisionInput {
  decidedAt: string;
  contractHash: string;
  snapshotHash: string;
  claimKind: string;
  truth: Verdict;
  observation: ObservationVerdict;
  issues: readonly string[];
  reviewRequired: boolean;
  outcome?: Outcome;
}

export interface GroundTruthInput {
  decisionId: string;
  recordedAt: string;
  value: 'True' | 'False';
  source: GroundTruthSource;
  auditor: string;
  note?: string;
  supersedes?: string;
}

export interface DecisionRecord extends DecisionInput {
  readonly kind: 'decision';
  readonly id: string;
  readonly sequence: number;
  readonly recordHash: string;
}

export interface GroundTruthRecord extends GroundTruthInput {
  readonly kind: 'ground-truth';
  readonly id: string;
  readonly sequence: number;
  readonly recordHash: string;
}

export type LogRecord = DecisionRecord | GroundTruthRecord;

/** 追加式存储。readText 必须返回全部历史，用于重算哈希。 */
export interface LogSink {
  appendLine(line: string): void;
  readText(): string;
}

function fail(code: string, message: string): never { throw new GilError(code, message); }

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}
function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('INVALID_LOG', `${label} must be a non-empty string`);
  return value;
}
/** 在反射之前拒绝 Proxy/getter/循环/危险键：hashValue 已覆盖这些情形。 */
function clean(value: unknown): Record<string, unknown> {
  hashValue(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_LOG', 'Expected a plain object');
  return structuredClone(value) as Record<string, unknown>;
}
function exact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail('INVALID_LOG', `Unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(record, key)) fail('INVALID_LOG', `Missing field ${key}`);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail('INVALID_LOG', `${label} must be one of ${choices.join(', ')}`);
  return value as T;
}

export function validateDecisionInput(value: unknown): DecisionInput {
  const r = clean(value);
  exact(r, ['decidedAt', 'contractHash', 'snapshotHash', 'claimKind', 'truth', 'observation', 'issues', 'reviewRequired'], ['outcome']);
  if (!isTimestamp(r.decidedAt)) fail('INVALID_LOG', 'decidedAt must be a parseable timestamp');
  if (!isHash(r.contractHash) || !isHash(r.snapshotHash)) fail('INVALID_LOG', 'Hashes must be sha256:<64 hex>');
  if (!Array.isArray(r.issues) || r.issues.some(i => typeof i !== 'string' || !i.trim())) fail('INVALID_LOG', 'issues must be non-empty strings');
  if (new Set(r.issues as string[]).size !== (r.issues as string[]).length) fail('INVALID_LOG', 'issues must not repeat');
  if (typeof r.reviewRequired !== 'boolean') fail('INVALID_LOG', 'reviewRequired must be bool');
  const result: DecisionInput = {
    decidedAt: r.decidedAt, contractHash: r.contractHash, snapshotHash: r.snapshotHash,
    claimKind: nonEmpty(r.claimKind, 'claimKind'),
    truth: oneOf(r.truth, ['True', 'False', 'Unknown'] as const, 'truth'),
    observation: oneOf(r.observation, ['Observed', 'ConfirmedAbsent', 'NotObserved', 'UnableToDetermine'] as const, 'observation'),
    issues: [...(r.issues as string[])], reviewRequired: r.reviewRequired,
  };
  if (Object.hasOwn(r, 'outcome')) result.outcome = oneOf(r.outcome, ['Succeeded', 'Failed', 'Unknown', 'NotExecuted'] as const, 'outcome');
  return result;
}

export function validateGroundTruthInput(value: unknown): GroundTruthInput {
  const r = clean(value);
  exact(r, ['decisionId', 'recordedAt', 'value', 'source', 'auditor'], ['note', 'supersedes']);
  const result: GroundTruthInput = {
    decisionId: nonEmpty(r.decisionId, 'decisionId'),
    recordedAt: isTimestamp(r.recordedAt) ? r.recordedAt : fail('INVALID_LOG', 'recordedAt must be a parseable timestamp'),
    value: oneOf(r.value, ['True', 'False'] as const, 'value'),
    source: oneOf(r.source, ['audit', 'expert-consensus', 'downstream-data'] as const, 'source'),
    auditor: nonEmpty(r.auditor, 'auditor'),
  };
  if (Object.hasOwn(r, 'note')) result.note = nonEmpty(r.note, 'note');
  if (Object.hasOwn(r, 'supersedes')) result.supersedes = nonEmpty(r.supersedes, 'supersedes');
  return result;
}

/** 从判定报告取记录字段，避免调用方各自拼装。 */
export function fieldsFromReport(report: EvaluationReport, claimKind: string, decidedAt: string,
  hashes: { contractHash: string; snapshotHash: string }, outcome?: Outcome): DecisionInput {
  return validateDecisionInput({ ...hashes, claimKind, decidedAt, truth: report.truth, observation: report.observation,
    issues: [...report.issues], reviewRequired: report.reviewRequired, ...(outcome === undefined ? {} : { outcome }) });
}

export function fileSink(path: string): LogSink {
  return {
    appendLine(line: string) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line + '\n', 'utf8');
    },
    readText() { return existsSync(path) ? readFileSync(path, 'utf8') : ''; },
  };
}
export function memorySink(initial = ''): LogSink & { text(): string } {
  let text = initial;
  return { appendLine(line) { text += line + '\n'; }, readText() { return text; }, text() { return text; } };
}

function payloadOf<T extends object>(record: T): string { return hashValue(record); }

export class DecisionLog {
  private readonly sink: LogSink;
  private seq = 0;
  constructor(sink: LogSink) { this.sink = sink; this.seq = this.records().length; }

  /** 只追加。返回冻结副本，调用方不能借引用改历史。 */
  appendDecision(input: unknown): DecisionRecord {
    const clean = validateDecisionInput(input);
    const sequence = this.seq + 1;
    const id = `d-${sequence}-${hashValue({ profile: DECISION_LOG_PROFILE, ...clean }).slice(7, 23)}`;
    const body = { kind: 'decision' as const, id, sequence, ...clean };
    const record: DecisionRecord = { ...body, recordHash: payloadOf(body) };
    this.sink.appendLine(JSON.stringify(record));
    this.seq = sequence;
    return Object.freeze(structuredClone(record));
  }

  /**
   * 回填事实。同一判定已有回填时必须显式 supersedes 前一条，
   * 这样纠错本身也是可追溯事件，而不是把旧记录改掉。
   */
  appendGroundTruth(input: unknown): GroundTruthRecord {
    const clean = validateGroundTruthInput(input);
    const history = this.records();
    if (!history.some(r => r.kind === 'decision' && r.id === clean.decisionId)) {
      fail('UNKNOWN_DECISION', `No decision ${clean.decisionId}`);
    }
    const prior = history.filter(r => r.kind === 'ground-truth' && r.decisionId === clean.decisionId) as GroundTruthRecord[];
    if (prior.length > 0) {
      const latest = prior[prior.length - 1];
      if (clean.supersedes !== latest.id) fail('GROUND_TRUTH_CONFLICT', `Supersede ${latest.id} explicitly or omit duplicate backfill`);
    } else if (clean.supersedes !== undefined) {
      fail('GROUND_TRUTH_CONFLICT', 'No earlier ground truth to supersede');
    }
    const sequence = this.seq + 1;
    const id = `g-${sequence}-${hashValue({ profile: DECISION_LOG_PROFILE, ...clean }).slice(7, 23)}`;
    const body = { kind: 'ground-truth' as const, id, sequence, ...clean };
    const record: GroundTruthRecord = { ...body, recordHash: payloadOf(body) };
    this.sink.appendLine(JSON.stringify(record));
    this.seq = sequence;
    return Object.freeze(structuredClone(record));
  }

  /** 全量重读并重算哈希。任何一行被改写都会在这里暴露。 */
  records(): LogRecord[] {
    const text = this.sink.readText();
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    const result: LogRecord[] = [];
    const ids = new Set<string>();
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { fail('LOG_TAMPERED', `Line ${index + 1} is not JSON`); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('LOG_TAMPERED', `Line ${index + 1} is not a record`);
      const { recordHash, ...body } = parsed as Record<string, unknown>;
      if (!isHash(recordHash)) fail('LOG_TAMPERED', `Line ${index + 1} has no content hash`);
      if (payloadOf(body as object) !== recordHash) fail('LOG_TAMPERED', `Line ${index + 1} content does not match its hash`);
      const record = body as unknown as LogRecord;
      if (record.sequence !== index + 1) fail('LOG_TAMPERED', `Line ${index + 1} breaks sequence order`);
      if (ids.has(record.id)) fail('LOG_TAMPERED', `Duplicate id ${record.id}`);
      ids.add(record.id);
      result.push(record);
    }
    return result;
  }
}

export interface RepeatReport {
  /** 分组键为 contractHash + snapshotHash：同一合同与同一输入快照。 */
  groups: number;
  /** 参与比较的判定条数（仅统计出现重复的组）。 */
  examined: number;
  /** 与组内首次判定不一致的条数。 */
  mismatched: number;
  /** mismatched / examined；确定性实现应恒为 0。 */
  rate: number;
}

/**
 * L1 自洽性：同一 (合同, 快照) 是否总得同一判定。
 *
 * 判定身份只取 truth/observation/issues/reviewRequired。outcome 会随外部执行
 * 变化，不能参与比较，否则会把"重试成功"误算成语义漂移。
 */
export function repeatMismatchRate(records: readonly LogRecord[]): RepeatReport {
  const decisions = records.filter((r): r is DecisionRecord => r.kind === 'decision');
  const groups = new Map<string, DecisionRecord[]>();
  for (const record of decisions) {
    const key = `${record.contractHash}|${record.snapshotHash}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record); else groups.set(key, [record]);
  }
  let examined = 0, mismatched = 0, repeated = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    repeated++;
    const baseline = hashValue({ truth: bucket[0].truth, observation: bucket[0].observation,
      issues: bucket[0].issues, reviewRequired: bucket[0].reviewRequired });
    for (const record of bucket.slice(1)) {
      examined++;
      const verdict = hashValue({ truth: record.truth, observation: record.observation,
        issues: record.issues, reviewRequired: record.reviewRequired });
      if (verdict !== baseline) mismatched++;
    }
  }
  return Object.freeze({ groups: repeated, examined, mismatched, rate: examined === 0 ? 0 : mismatched / examined });
}

export interface Summary {
  decisions: number;
  byTruth: Record<Verdict, number>;
  byObservation: Record<ObservationVerdict, number>;
  unknownShare: number;
  reviewRequired: number;
  /** 有回填的比例。低覆盖意味着 L3 结论尚不成立。 */
  groundTruth: { covered: number; coveredShare: number; bySource: Record<GroundTruthSource, number> };
  repeat: RepeatReport;
}

/**
 * 汇总。只报计数与区间语义明确的比例，不合成"对齐度"总分——
 * 把不同可信度的东西加起来会掩盖最难的部分。
 */
export function summarize(records: readonly LogRecord[]): Summary {
  const decisions = records.filter((r): r is DecisionRecord => r.kind === 'decision');
  const truths: Record<Verdict, number> = { True: 0, False: 0, Unknown: 0 };
  const observations: Record<ObservationVerdict, number> = { Observed: 0, ConfirmedAbsent: 0, NotObserved: 0, UnableToDetermine: 0 };
  let reviewRequired = 0;
  for (const record of decisions) { truths[record.truth]++; observations[record.observation]++; if (record.reviewRequired) reviewRequired++; }
  // 每条判定只认最新一条回填；被 supersede 的旧值不计入来源统计之外的任何数字。
  const latest = new Map<string, GroundTruthRecord>();
  for (const record of records) if (record.kind === 'ground-truth') latest.set(record.decisionId, record);
  const bySource: Record<GroundTruthSource, number> = { audit: 0, 'expert-consensus': 0, 'downstream-data': 0 };
  for (const record of latest.values()) bySource[record.source]++;
  const covered = [...latest.keys()].filter(id => decisions.some(d => d.id === id)).length;
  return Object.freeze({
    decisions: decisions.length, byTruth: truths, byObservation: observations,
    unknownShare: decisions.length === 0 ? 0 : truths.Unknown / decisions.length,
    reviewRequired,
    groundTruth: { covered, coveredShare: decisions.length === 0 ? 0 : covered / decisions.length, bySource },
    repeat: repeatMismatchRate(records),
  });
}
