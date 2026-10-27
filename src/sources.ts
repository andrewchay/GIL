// Phase5 检索来源模型：把"确认缺失"与"无法判定"分开记录。
// 覆盖不完整或材料不可读时，结论只能是 Unknown；不得据此声称 MISSING_EVIDENCE。
// 本模块只处理合成本地工件，不连接任何真实检索或文档系统。
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import { HASH_PATTERN, fail, freeze, nonEmpty, plainRecord, readOwn, rejectUnknown } from './artifact.ts';

export const SOURCE_VERSION = 'gil-assurance-sources-0.1';

/** 检索覆盖等级：全量/部分/完全不可达。 */
export type CoverageLevel = 'FULL' | 'PARTIAL' | 'NONE';
/** 判定结果：确认存在、确认缺失、无法判定。三者不得合并。 */
export type QueryVerdict = 'CONFIRMED_PRESENT' | 'CONFIRMED_ABSENT' | 'UNKNOWN';
export type UnknownReason = 'MATERIAL_UNREADABLE' | 'PARTIAL_COVERAGE' | 'NO_SOURCE_REACHABLE';

export interface SourceQueryInput {
  sourceId: string;
  sourceVersion: string;
  /** 被检索对象的合成范围标识（例如研究/中心/受试者键）。 */
  scopeKey: string;
  queriedAt: number;
  coverage: CoverageLevel;
  /** 材料是否可解析读取；不可读时覆盖等级无意义。 */
  readable: boolean;
  /** 在完整可读覆盖下检索命中与否；部分覆盖时该值不构成结论。 */
  found: boolean;
}

export interface RetrievalRecord extends SourceQueryInput {
  kind: 'retrieval-record';
  version: string;
  contentHash: string;
}

export interface Assessment {
  verdict: QueryVerdict;
  reason: UnknownReason | 'FOUND' | 'ABSENT_AFTER_FULL_READABLE_QUERY';
  /** 只有在 CONFIRMED_ABSENT 时才允许在诊断中报 MISSING_EVIDENCE。 */
  mayReportMissing: boolean;
  sourceId: string;
  sourceVersion: string;
  coverage: CoverageLevel;
}

const COVERAGE_LEVELS: readonly CoverageLevel[] = ['FULL', 'PARTIAL', 'NONE'];
const INPUT_KEYS = ['sourceId', 'sourceVersion', 'scopeKey', 'queriedAt', 'coverage', 'readable', 'found'];
const RECORD_KEYS = ['kind', 'version', 'sourceId', 'sourceVersion', 'scopeKey', 'queriedAt', 'coverage', 'readable', 'found', 'contentHash'];

/** 过程内签发记录：JSON 重建的检索记录不携带来源权威。 */
const records = new WeakMap<object, { seal: string }>();

type Content = Omit<RetrievalRecord, 'contentHash'>;

function digest(content: Content): string {
  return hashValue({ version: content.version, sourceId: content.sourceId, sourceVersion: content.sourceVersion,
    scopeKey: content.scopeKey, queriedAt: content.queriedAt, coverage: content.coverage,
    readable: content.readable, found: content.found });
}

function pickContent(record: Record<string, unknown>, code: string): Content {
  const sourceId = nonEmpty(readOwn(record, 'sourceId', code), code, 'sourceId');
  const sourceVersion = nonEmpty(readOwn(record, 'sourceVersion', code), code, 'sourceVersion');
  const scopeKey = nonEmpty(readOwn(record, 'scopeKey', code), code, 'scopeKey');
  const queriedAt = readOwn(record, 'queriedAt', code);
  if (typeof queriedAt !== 'number' || !Number.isFinite(queriedAt)) fail(code, 'queriedAt must be a finite synthetic time');
  const coverage = readOwn(record, 'coverage', code);
  if (!COVERAGE_LEVELS.includes(coverage as CoverageLevel)) fail(code, 'coverage must be FULL, PARTIAL or NONE');
  const readable = readOwn(record, 'readable', code);
  const found = readOwn(record, 'found', code);
  if (typeof readable !== 'boolean') fail(code, 'readable must be a boolean');
  if (typeof found !== 'boolean') fail(code, 'found must be a boolean');
  return { kind: 'retrieval-record', version: nonEmpty(readOwn(record, 'version', code), code, 'version'),
    sourceId, sourceVersion, scopeKey, queriedAt, coverage: coverage as CoverageLevel, readable, found };
}

/**
 * 登记一次显式检索。调用方必须同时声明覆盖等级与可读性，
 * 不允许只给一个"没找到"的布尔值——这正是 A07/A09 要消除的投影。
 */
export function createRetrieval(input: SourceQueryInput): RetrievalRecord {
  const record = plainRecord(input, 'INVALID_RETRIEVAL');
  rejectUnknown(record, INPUT_KEYS, 'INVALID_RETRIEVAL');
  const content = pickContent({ ...record, kind: 'retrieval-record', version: SOURCE_VERSION }, 'INVALID_RETRIEVAL');
  const created: RetrievalRecord = freeze({ ...content, contentHash: digest(content) });
  records.set(created, { seal: digest(content) });
  return created;
}

export function validateRetrieval(value: RetrievalRecord): RetrievalRecord {
  if (value === null || typeof value !== 'object' || !records.has(value)) {
    fail('UNTRUSTED_RETRIEVAL', 'Use a RetrievalRecord returned by createRetrieval; copies and JSON rebuilds are rejected');
  }
  const record = plainRecord(value, 'INVALID_RETRIEVAL');
  rejectUnknown(record, RECORD_KEYS, 'INVALID_RETRIEVAL');
  if (readOwn(record, 'kind', 'INVALID_RETRIEVAL') !== 'retrieval-record') fail('INVALID_RETRIEVAL', 'kind must be retrieval-record');
  const contentHash = nonEmpty(readOwn(record, 'contentHash', 'INVALID_RETRIEVAL'), 'INVALID_RETRIEVAL', 'contentHash');
  if (!HASH_PATTERN.test(contentHash)) fail('INVALID_RETRIEVAL', 'contentHash must be sha256:<64 hex>');
  const content = pickContent(record, 'INVALID_RETRIEVAL');
  if (digest(content) !== contentHash) fail('TAMPERED_RETRIEVAL', 'contentHash must match the retrieval record');
  if (records.get(value)!.seal !== contentHash) fail('TAMPERED_RETRIEVAL', 'Record no longer matches its in-process seal');
  return value;
}

/**
 * 判定：只有"全量覆盖 + 可读"的检索才能给出确定结论。
 * 其余一律 UNKNOWN，且明确不得报 MISSING_EVIDENCE。
 */
export function assessQuery(value: RetrievalRecord): Assessment {
  const record = validateRetrieval(value);
  const base = { sourceId: record.sourceId, sourceVersion: record.sourceVersion, coverage: record.coverage };
  if (!record.readable) return freeze({ ...base, verdict: 'UNKNOWN' as const, reason: 'MATERIAL_UNREADABLE' as const, mayReportMissing: false });
  if (record.coverage === 'NONE') return freeze({ ...base, verdict: 'UNKNOWN' as const, reason: 'NO_SOURCE_REACHABLE' as const, mayReportMissing: false });
  if (record.coverage === 'PARTIAL') return freeze({ ...base, verdict: 'UNKNOWN' as const, reason: 'PARTIAL_COVERAGE' as const, mayReportMissing: false });
  if (record.found) return freeze({ ...base, verdict: 'CONFIRMED_PRESENT' as const, reason: 'FOUND' as const, mayReportMissing: false });
  return freeze({ ...base, verdict: 'CONFIRMED_ABSENT' as const, reason: 'ABSENT_AFTER_FULL_READABLE_QUERY' as const, mayReportMissing: true });
}

/** 只有确认缺失才允许报 MISSING_EVIDENCE；Unknown 必须保持 Unknown。 */
export function missingEvidenceClaim(value: RetrievalRecord): 'MISSING_EVIDENCE' | 'UNKNOWN' {
  const assessment = assessQuery(value);
  return assessment.mayReportMissing ? 'MISSING_EVIDENCE' : 'UNKNOWN';
}

/** 覆盖是否足以支撑一次复核：部分覆盖与不可读都必须显式列为缺口。 */
export function coverageGaps(values: RetrievalRecord[]): { sourceId: string; reason: string }[] {
  if (!Array.isArray(values)) fail('INVALID_RETRIEVAL', 'coverageGaps requires an array of retrieval records');
  const gaps: { sourceId: string; reason: string }[] = [];
  for (const value of values) {
    const assessment = assessQuery(value);
    if (assessment.verdict !== 'UNKNOWN') continue;
    gaps.push({ sourceId: assessment.sourceId, reason: assessment.reason });
  }
  return freeze(gaps);
}

/** 不可判定，但必须是 GilError 语义而不是返回 false 静默降级。 */
export function assertAssessable(value: RetrievalRecord): RetrievalRecord {
  try { return validateRetrieval(value); }
  catch (error) { if (error instanceof GilError) fail('UNASSESSABLE_RETRIEVAL', error.message); throw error; }
}
