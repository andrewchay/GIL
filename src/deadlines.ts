// Phase5 期限与时间语义：显式期限来源、逾期投影、越期处置回执。
// 本模块不猜测日期、不编造监管时限：没有来源就没有义务工件。
// 真实执行时间由调用方的受信时钟提供（gate 注入）；声明的业务日期是另一条独立通道。
import { hashValue } from './interpretation.ts';
import { HASH_PATTERN, fail, freeze, nonEmpty, plainRecord, readOwn, rejectUnknown } from './artifact.ts';

export const OBLIGATION_VERSION = 'gil-assurance-obligation-0.1';
export const ESCALATION_VERSION = 'gil-assurance-escalation-0.1';

/** BLOCK-CLOSURE：逾期阻断关闭；ESCALATE-ONLY：逾期只产生升级事件，不阻断关闭。 */
export type DeadlinePolicy = 'BLOCK-CLOSURE' | 'ESCALATE-ONLY';
/** ACCEPT-LATE 是唯一能越期关闭的处置；REMEDIATE 表示先整改，Core 会继续阻断。 */
export type EscalationDisposition = 'ACCEPT-LATE' | 'REMEDIATE';

export interface Obligation {
  kind: 'obligation';
  version: string;
  findingId: string;
  /** 期限本身，合成时间轴上的有限数值。 */
  dueAt: number;
  /** 期限来源工件标识；不得为空，禁止"没有来源的期限"。 */
  sourceRef: string;
  sourceVersion: string;
  policy: DeadlinePolicy;
  contentHash: string;
}

/** 与 GIL `C.Obligation` concept 逐字段一致。 */
export interface ObligationView {
  contentHash: string;
  dueAt: number;
  sourceRef: string;
  sourceVersion: string;
  policy: DeadlinePolicy;
}

/** 与 GIL `C.EscalationAck` concept 逐字段一致。 */
export interface EscalationView {
  ackId: string;
  obligationHash: string;
  disposition: EscalationDisposition;
  authority: string;
}

export interface EscalationAck extends EscalationView {
  kind: 'escalation-ack';
  version: string;
  at: number;
}

export interface ObligationInput { findingId: string; dueAt: number; sourceRef: string; sourceVersion: string; policy: DeadlinePolicy }
export interface AckInput { ackId: string; disposition: EscalationDisposition; authority: string; at: number }
export interface DeadlineStatus {
  overdue: boolean;
  /** 逾期且政策为 BLOCK-CLOSURE 时为 true。 */
  blocked: boolean;
  dueAt: number;
  sourceRef: string;
  sourceVersion: string;
  policy: DeadlinePolicy;
  reason: 'WITHIN-DUE' | 'OVERDUE-BLOCKED' | 'OVERDUE-ESCALATED';
}

const POLICIES: readonly DeadlinePolicy[] = ['BLOCK-CLOSURE', 'ESCALATE-ONLY'];
const DISPOSITIONS: readonly EscalationDisposition[] = ['ACCEPT-LATE', 'REMEDIATE'];
const OBLIGATION_KEYS = ['kind', 'version', 'findingId', 'dueAt', 'sourceRef', 'sourceVersion', 'policy', 'contentHash'];
const OBLIGATION_INPUT_KEYS = ['findingId', 'dueAt', 'sourceRef', 'sourceVersion', 'policy'];
const ACK_KEYS = ['kind', 'version', 'ackId', 'obligationHash', 'disposition', 'authority', 'at'];
const ACK_INPUT_KEYS = ['ackId', 'disposition', 'authority', 'at'];

/** 过程内签发记录：JSON 重建的义务或回执不携带权威。 */
const obligations = new WeakMap<object, { seal: string }>();
const acks = new WeakMap<object, { seal: string }>();

function obligationDigest(content: Omit<Obligation, 'contentHash'>): string {
  return hashValue({ version: content.version, findingId: content.findingId, dueAt: content.dueAt,
    sourceRef: content.sourceRef, sourceVersion: content.sourceVersion, policy: content.policy });
}

function ackDigest(content: Omit<EscalationAck, 'at'>): string {
  return hashValue({ version: content.version, ackId: content.ackId, obligationHash: content.obligationHash,
    disposition: content.disposition, authority: content.authority });
}

/**
 * 建立期限义务。dueAt 必须严格晚于当前合成时间，来源与来源版本必须显式给出。
 * 期限未定义时调用方必须不创建义务（A17 的 open 未决项），而不是猜一个日期。
 */
export function createObligation(input: ObligationInput, now: number): Obligation {
  const record = plainRecord(input, 'INVALID_OBLIGATION');
  rejectUnknown(record, OBLIGATION_INPUT_KEYS, 'INVALID_OBLIGATION');
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('INVALID_CLOCK', 'Obligation needs a finite synthetic time');
  const findingId = nonEmpty(readOwn(record, 'findingId', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'findingId');
  const dueAt = readOwn(record, 'dueAt', 'INVALID_OBLIGATION');
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) fail('INVALID_OBLIGATION', 'dueAt must be a finite synthetic time');
  if (dueAt <= now) fail('INVALID_OBLIGATION', 'dueAt must be strictly after the creation time; backdated obligations are rejected');
  const sourceRef = nonEmpty(readOwn(record, 'sourceRef', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'sourceRef');
  const sourceVersion = nonEmpty(readOwn(record, 'sourceVersion', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'sourceVersion');
  const policy = readOwn(record, 'policy', 'INVALID_OBLIGATION');
  if (!POLICIES.includes(policy as DeadlinePolicy)) fail('INVALID_OBLIGATION', 'policy must be BLOCK-CLOSURE or ESCALATE-ONLY');
  const content = { kind: 'obligation' as const, version: OBLIGATION_VERSION, findingId, dueAt, sourceRef, sourceVersion, policy: policy as DeadlinePolicy };
  const obligation: Obligation = freeze({ ...content, contentHash: obligationDigest(content) });
  obligations.set(obligation, { seal: obligationDigest(content) });
  return obligation;
}

export function validateObligation(value: Obligation): Obligation {
  if (value === null || typeof value !== 'object' || !obligations.has(value)) {
    fail('UNTRUSTED_OBLIGATION', 'Use an Obligation returned by createObligation; copies and JSON rebuilds are rejected');
  }
  const record = plainRecord(value, 'INVALID_OBLIGATION');
  rejectUnknown(record, OBLIGATION_KEYS, 'INVALID_OBLIGATION');
  if (readOwn(record, 'kind', 'INVALID_OBLIGATION') !== 'obligation') fail('INVALID_OBLIGATION', 'kind must be obligation');
  const contentHash = nonEmpty(readOwn(record, 'contentHash', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'contentHash');
  if (!HASH_PATTERN.test(contentHash)) fail('INVALID_OBLIGATION', 'contentHash must be sha256:<64 hex>');
  const dueAt = readOwn(record, 'dueAt', 'INVALID_OBLIGATION');
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) fail('INVALID_OBLIGATION', 'dueAt must be a finite synthetic time');
  const policy = readOwn(record, 'policy', 'INVALID_OBLIGATION');
  if (!POLICIES.includes(policy as DeadlinePolicy)) fail('INVALID_OBLIGATION', 'policy must be BLOCK-CLOSURE or ESCALATE-ONLY');
  const content = { kind: 'obligation' as const, version: nonEmpty(readOwn(record, 'version', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'version'),
    findingId: nonEmpty(readOwn(record, 'findingId', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'findingId'), dueAt,
    sourceRef: nonEmpty(readOwn(record, 'sourceRef', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'sourceRef'),
    sourceVersion: nonEmpty(readOwn(record, 'sourceVersion', 'INVALID_OBLIGATION'), 'INVALID_OBLIGATION', 'sourceVersion'),
    policy: policy as DeadlinePolicy };
  if (obligationDigest(content) !== contentHash) fail('TAMPERED_OBLIGATION', 'contentHash must match obligation content');
  return value;
}

/** 供 Core 使用的义务视图。 */
export function obligationView(obligation: Obligation): ObligationView {
  const valid = validateObligation(obligation);
  return freeze({ contentHash: valid.contentHash, dueAt: valid.dueAt, sourceRef: valid.sourceRef,
    sourceVersion: valid.sourceVersion, policy: valid.policy });
}

/**
 * 逾期投影：只报告事实，不产生复核结论。
 * 逾期且 BLOCK-CLOSURE 时，只有同一义务的 ACCEPT-LATE 回执才能解除阻断。
 */
export function deadlineStatus(obligation: Obligation, at: number): DeadlineStatus {
  const valid = validateObligation(obligation);
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_CLOCK', 'Deadline evaluation needs a finite synthetic time');
  const overdue = at > valid.dueAt;
  const blocked = overdue && valid.policy === 'BLOCK-CLOSURE';
  const reason: DeadlineStatus['reason'] = !overdue ? 'WITHIN-DUE' : blocked ? 'OVERDUE-BLOCKED' : 'OVERDUE-ESCALATED';
  return freeze({ overdue, blocked, dueAt: valid.dueAt, sourceRef: valid.sourceRef,
    sourceVersion: valid.sourceVersion, policy: valid.policy, reason });
}

/**
 * 签发越期处置回执。这是显式处置，不是复核结论：ACCEPT-LATE 只解除期限阻断，
 * 不免除证据、复核或批准要求。authority 必须是具名主体（由外层校验其角色）。
 */
export function acknowledgeEscalation(obligation: Obligation, input: AckInput): EscalationAck {
  const valid = validateObligation(obligation);
  const record = plainRecord(input, 'INVALID_ESCALATION');
  rejectUnknown(record, ACK_INPUT_KEYS, 'INVALID_ESCALATION');
  const ackId = nonEmpty(readOwn(record, 'ackId', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'ackId');
  const authority = nonEmpty(readOwn(record, 'authority', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'authority');
  const at = readOwn(record, 'at', 'INVALID_ESCALATION');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_ESCALATION', 'at must be a finite synthetic time');
  // 处置不能早于期限届满，也不能自称由签发者本人绕过。
  if (at <= valid.dueAt) fail('INVALID_ESCALATION', 'An escalation cannot be acknowledged before the deadline');
  const disposition = readOwn(record, 'disposition', 'INVALID_ESCALATION');
  if (!DISPOSITIONS.includes(disposition as EscalationDisposition)) {
    fail('INVALID_ESCALATION', 'disposition must be ACCEPT-LATE or REMEDIATE');
  }
  const content = { kind: 'escalation-ack' as const, version: ESCALATION_VERSION, ackId,
    obligationHash: valid.contentHash, disposition: disposition as EscalationDisposition, authority };
  const ack: EscalationAck = freeze({ ...content, at });
  acks.set(ack, { seal: ackDigest(content) });
  return ack;
}

export function validateEscalation(ack: EscalationAck): EscalationAck {
  if (ack === null || typeof ack !== 'object' || !acks.has(ack)) {
    fail('UNTRUSTED_ESCALATION', 'Use an EscalationAck returned by acknowledgeEscalation; copies are rejected');
  }
  const record = plainRecord(ack, 'INVALID_ESCALATION');
  rejectUnknown(record, ACK_KEYS, 'INVALID_ESCALATION');
  if (readOwn(record, 'kind', 'INVALID_ESCALATION') !== 'escalation-ack') fail('INVALID_ESCALATION', 'kind must be escalation-ack');
  const at = readOwn(record, 'at', 'INVALID_ESCALATION');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_ESCALATION', 'at must be a finite synthetic time');
  const disposition = readOwn(record, 'disposition', 'INVALID_ESCALATION');
  if (!DISPOSITIONS.includes(disposition as EscalationDisposition)) fail('INVALID_ESCALATION', 'Unsupported disposition');
  const content = { kind: 'escalation-ack' as const, version: nonEmpty(readOwn(record, 'version', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'version'),
    ackId: nonEmpty(readOwn(record, 'ackId', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'ackId'),
    obligationHash: nonEmpty(readOwn(record, 'obligationHash', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'obligationHash'),
    disposition: disposition as EscalationDisposition,
    authority: nonEmpty(readOwn(record, 'authority', 'INVALID_ESCALATION'), 'INVALID_ESCALATION', 'authority') };
  if (ackDigest(content) !== acks.get(ack)!.seal) fail('TAMPERED_ESCALATION', 'Ack no longer matches its in-process seal');
  return ack;
}

/** 供 Core 使用的回执视图；回执必须属于当前义务。 */
export function escalationView(ack: EscalationAck, obligation: Obligation): EscalationView {
  const valid = validateEscalation(ack);
  const obligationHash = validateObligation(obligation).contentHash;
  if (valid.obligationHash !== obligationHash) fail('ESCALATION_MISMATCH', 'Ack must name the current obligation');
  return freeze({ ackId: valid.ackId, obligationHash: valid.obligationHash, disposition: valid.disposition, authority: valid.authority });
}

/**
 * 业务日期簿：真实执行时间与声明业务日期分离。
 * 已记录的业务日期只能持平或前进；回填更早的日期被拒绝，历史不可改写。
 */
export interface BusinessDateRecord { lastBusinessDate: number; history: { businessDate: number; actionAt: number }[] }

export function recordBusinessDate(record: BusinessDateRecord, businessDate: number, actionAt: number): BusinessDateRecord {
  if (!Number.isSafeInteger(businessDate) || businessDate <= 0) {
    fail('INVALID_BUSINESS_DATE', 'businessDate must be a positive safe integer ordinal');
  }
  if (typeof actionAt !== 'number' || !Number.isFinite(actionAt)) fail('INVALID_CLOCK', 'actionAt must be a finite synthetic time');
  if (businessDate < record.lastBusinessDate) {
    fail('BACKDATED_BUSINESS_DATE', `businessDate ${businessDate} predates the recorded ${record.lastBusinessDate}; history cannot be rewritten`);
  }
  return freeze({ lastBusinessDate: businessDate,
    history: [...record.history, { businessDate, actionAt }] });
}

/** 初始簿：尚无任何业务日期，lastBusinessDate 为 0 表示未记录。 */
export function emptyBusinessDates(): BusinessDateRecord { return freeze({ lastBusinessDate: 0, history: [] }); }
