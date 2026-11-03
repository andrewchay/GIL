/**
 * 盲测包：把真实决策脱敏成可标注案例，生成不含答案的案例表与回答表，
 * 再把回收结果算成一致性指标。
 *
 * 边界：
 * - 本模块不读取业务原始数据。案例必须由操作者按严格 schema 导入，
 *   并显式声明已脱敏；未声明则拒绝生成。
 * - 案例只有结构化字段，没有自由文本描述，避免无意夹带业务内容。
 * - 系统判定单独写入答案键，绝不进入标注者可见文件。
 * - 一致性不等于正确性。"多数意见与系统不一致"只表示分歧位置，
 *   不能据此判断谁对。
 */
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import { evaluateSnapshot, validateClaim, validateSnapshot } from './agent-semantics.ts';
import type { Claim, Snapshot } from './agent-semantics.ts';
import { fleissKappa, cohenKappa, bootstrapInterval, band } from './agreement.ts';
import type { KappaResult } from './agreement.ts';

export const BLIND_BENCH_PROFILE = 'gil-blind-bench-0.1';

export const TRUTH_LABELS = ['True', 'False', 'Unknown'] as const;
export const OBSERVATION_LABELS = ['Observed', 'ConfirmedAbsent', 'NotObserved', 'UnableToDetermine'] as const;
export type TruthLabel = typeof TRUTH_LABELS[number];
export type ObservationLabel = typeof OBSERVATION_LABELS[number];

export interface Case {
  readonly id: string;
  readonly domain: 'clinical' | 'growth' | 'other';
  readonly claim: Claim;
  readonly snapshot: Snapshot;
  readonly system: { truth: TruthLabel; observation: ObservationLabel; issues: string[]; reviewRequired: boolean };
}

export interface CaseInput {
  id: unknown;
  domain: unknown;
  claim: unknown;
  snapshot: unknown;
  /** 操作者必须显式确认脱敏；否则拒绝。 */
  disclosure: unknown;
}

function fail(code: string, message: string): never { throw new GilError(code, message); }

function plain(value: unknown): Record<string, unknown> {
  hashValue(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CASE', 'Expected a plain object');
  return structuredClone(value) as Record<string, unknown>;
}
function exact(record: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail('INVALID_CASE', `Unknown field ${key}`);
  for (const key of keys) if (!Object.hasOwn(record, key)) fail('INVALID_CASE', `Missing field ${key}`);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string, code = 'INVALID_CASE'): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(code, `${label} must be one of ${choices.join(', ')}`);
  return value as T;
}

/**
 * 校验单个案例。系统判定由真实的 evaluateSnapshot 重新计算，不接受外部填写，
 * 避免答案键与实际代码行为脱节。
 */
export function importCase(value: unknown): Case {
  const r = plain(value);
  exact(r, ['id', 'domain', 'claim', 'snapshot', 'disclosure']);
  if (typeof r.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(r.id)) {
    fail('INVALID_CASE', 'id must be a short anonymous label such as C-01');
  }
  const domain = oneOf(r.domain, ['clinical', 'growth', 'other'] as const, 'domain');
  const disclosure = plain(r.disclosure);
  exact(disclosure, ['sanitized', 'checkedBy']);
  if (disclosure.sanitized !== true) fail('NOT_SANITIZED', 'Cases must be explicitly declared sanitized before a pack is built');
  if (typeof disclosure.checkedBy !== 'string' || !disclosure.checkedBy.trim()) fail('INVALID_CASE', 'checkedBy is required');
  const claim = validateClaim(r.claim);
  const snapshot = validateSnapshot(r.snapshot);
  const report = evaluateSnapshot(snapshot, claim);
  return Object.freeze({
    id: r.id, domain, claim, snapshot,
    system: Object.freeze({ truth: report.truth, observation: report.observation,
      issues: [...report.issues], reviewRequired: report.reviewRequired }),
  });
}

export function importCases(values: readonly unknown[]): Case[] {
  if (!Array.isArray(values) || values.length < 2) fail('INVALID_CASE', 'At least two cases are required');
  const cases = values.map(importCase);
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) fail('DUPLICATE_CASE', `Duplicate case id ${item.id}`);
    ids.add(item.id);
  }
  // 类别必须同时出现两种以上，否则 κ 无定义。
  for (const [label, values2] of [['truth', cases.map(c => c.system.truth)], ['observation', cases.map(c => c.system.observation)]] as const) {
    if (new Set(values2).size < 2) fail('DEGENERATE_PACK', `All cases share one ${label}; kappa would be undefined`);
  }
  return cases;
}

/** 标注者可见的案例正文。不含任何答案、不含系统判定。 */
export function renderBlindPack(cases: readonly Case[]): string {
  const lines: string[] = [
    '# GIL 判定盲测案例',
    '',
    '请只依据下方字段判断，不要查阅其他资料、不要与他人讨论。',
    '把答案填进随附的「回答表」CSV，不要修改本文件。',
    '',
  ];
  for (const item of cases) {
    const o = item.snapshot.observation;
    lines.push(
      `## ${item.id}`,
      '',
      '| 字段 | 值 |',
      '|---|---|',
      `| readability | ${o.readability} |`,
      `| completeness | ${o.completeness} |`,
      `| searched | ${o.searched} |`,
      `| matches | ${o.matches} |`,
      `| mappingValid | ${o.mappingValid} |`,
      `| applicable | ${o.applicable} |`,
      `| windowMature | ${o.windowMature} |`,
      `| scopeCovered | ${o.scopeCovered} |`,
      `| watermarkCovered | ${o.watermarkCovered} |`,
      `| closureBasis | ${o.closureBasis === null ? '（无）' : o.closureBasis} |`,
      `| conflicts | ${item.snapshot.conflicts.length ? item.snapshot.conflicts.join(', ') : '（无）'} |`,
      `| lineageRoots | ${item.snapshot.lineageRoots.join(', ') || '（无）'} |`,
      '',
      '| 主张字段 | 值 |',
      '|---|---|',
      `| kind | ${item.claim.kind} |`,
      `| fact | ${item.claim.fact} |`,
      `| causalDesign | ${item.claim.causalDesign ?? '（无）'} |`,
      `| uncertainty | ${item.claim.uncertainty} |`,
      `| uncertaintyMethod | ${item.claim.uncertaintyMethod} |`,
      `| requiresIndependentSources | ${item.claim.requiresIndependentSources} |`,
      '',
      `事实取值：${Object.entries(item.snapshot.facts).map(([k, v]) => `${k}=${String(v)}`).join('，') || '（无）'}`,
      '',
    );
  }
  return lines.join('\n');
}

/** 回答表：预填 case id，答案留空。一人一份。 */
export function renderResponseSheet(cases: readonly Case[]): string {
  const header = 'case_id,truth,observation';
  const rows = cases.map(item => `${item.id},,`);
  return [header, ...rows].join('\n') + '\n';
}

/** 答案键：只用于分析，绝不给标注者。 */
export function renderAnswerKey(cases: readonly Case[]): string {
  const payload = {
    profile: BLIND_BENCH_PROFILE,
    cases: cases.map(item => ({ id: item.id, domain: item.domain, system: item.system })),
    keyHash: hashValue(cases.map(item => ({ id: item.id, snapshot: item.snapshot, claim: item.claim, system: item.system }))),
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

export interface ResponseSheet { annotator: string; answers: Map<string, { truth: string; observation: string }> }

/** 解析一份回答 CSV。缺失、越界、重复一律拒绝，不做插补。 */
export function parseResponseSheet(annotator: string, text: string, cases: readonly Case[]): ResponseSheet {
  if (typeof annotator !== 'string' || !annotator.trim()) fail('INVALID_RESPONSE', 'Annotator label is required');
  const expected = new Set(cases.map(item => item.id));
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) fail('INVALID_RESPONSE', 'Empty response sheet');
  if (lines[0].replace(/\s/g, '') !== 'case_id,truth,observation') fail('INVALID_RESPONSE', 'Unexpected header; keep the generated columns');
  const answers = new Map<string, { truth: string; observation: string }>();
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map(cell => cell.trim());
    if (cells.length !== 3) fail('INVALID_RESPONSE', `Expected 3 columns, got ${cells.length}: ${line}`);
    const [id, truth, observation] = cells;
    if (!expected.has(id)) fail('INVALID_RESPONSE', `Unknown case ${id}`);
    if (answers.has(id)) fail('INVALID_RESPONSE', `Duplicate answer for ${id}`);
    if (!truth) fail('INVALID_RESPONSE', `Missing truth for ${id}`);
    if (!observation) fail('INVALID_RESPONSE', `Missing observation for ${id}`);
    oneOf(truth, TRUTH_LABELS, `truth for ${id}`, 'INVALID_RESPONSE');
    oneOf(observation, OBSERVATION_LABELS, `observation for ${id}`, 'INVALID_RESPONSE');
    answers.set(id, { truth, observation });
  }
  const missing = [...expected].filter(id => !answers.has(id));
  if (missing.length) fail('INVALID_RESPONSE', `Unanswered cases: ${missing.join(', ')}`);
  return { annotator, answers };
}

export interface DimensionReport {
  readonly dimension: 'truth' | 'observation';
  readonly overall: KappaResult;
  readonly interval: { low: number; high: number; level: number; samples: number };
  readonly band: string;
  /** 两两之间的 κ，用于定位"谁和谁不一致"。 */
  readonly pairwise: { pair: string; kappa: number }[];
  readonly unanimous: number;
  readonly disputed: string[];
  /** 多数意见与系统判定不一致的案例。不是错误率，无法判断谁对。 */
  readonly differsFromSystem: string[];
}

export interface AnalysisReport {
  readonly profile: string;
  readonly cases: number;
  readonly annotators: string[];
  readonly dimensions: DimensionReport[];
  readonly warnings: string[];
}

function majority(labels: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let best: string | undefined, top = 0, tie = false;
  for (const [label, count] of counts) {
    if (count > top) { best = label; top = count; tie = false; }
    else if (count === top) tie = true;
  }
  return tie ? undefined : best;
}

export function analyze(cases: readonly Case[], sheets: readonly ResponseSheet[], options: { samples?: number; seed?: number } = {}): AnalysisReport {
  if (sheets.length < 2) fail('INVALID_RESPONSE', 'At least two annotators are required');
  const names = new Set<string>();
  for (const sheet of sheets) {
    if (names.has(sheet.annotator)) fail('INVALID_RESPONSE', `Duplicate annotator ${sheet.annotator}`);
    names.add(sheet.annotator);
  }
  const warnings: string[] = [];
  const dimensions: DimensionReport[] = [];
  for (const dimension of ['truth', 'observation'] as const) {
    const matrix = cases.map(item => sheets.map(sheet => sheet.answers.get(item.id)![dimension]));
    const overall = fleissKappa(matrix);
    const interval = bootstrapInterval(matrix, { samples: options.samples ?? 2000, seed: options.seed ?? 20261103 });
    const pairwise: { pair: string; kappa: number }[] = [];
    for (let i = 0; i < sheets.length; i++) {
      for (let j = i + 1; j < sheets.length; j++) {
        const a = cases.map(item => sheets[i].answers.get(item.id)![dimension]);
        const b = cases.map(item => sheets[j].answers.get(item.id)![dimension]);
        pairwise.push({ pair: `${sheets[i].annotator}×${sheets[j].annotator}`, kappa: cohenKappa(a, b).kappa });
      }
    }
    const disputed: string[] = [], differsFromSystem: string[] = [];
    let unanimous = 0;
    for (const item of cases) {
      const labels = sheets.map(sheet => sheet.answers.get(item.id)![dimension]);
      if (new Set(labels).size === 1) unanimous++;
      else disputed.push(item.id);
      const agreed = majority(labels);
      const systemValue = dimension === 'truth' ? item.system.truth : item.system.observation;
      if (agreed === undefined || agreed !== systemValue) differsFromSystem.push(item.id);
    }
    if (overall.undefined) warnings.push(`${dimension}: 所有标注落在同一类别，κ 无定义`);
    if (interval.high - interval.low > 0.4) warnings.push(`${dimension}: κ 区间宽达 ${(interval.high - interval.low).toFixed(2)}，案例数不足以支撑结论`);
    if (interval.low < 0.6 && interval.high > 0.6) warnings.push(`${dimension}: 区间跨越 0.6，无法判断是否达到"中等一致"`);
    dimensions.push(Object.freeze({ dimension, overall, interval, band: band(overall.kappa), pairwise, unanimous, disputed, differsFromSystem }));
  }
  if (cases.length < 30) warnings.push(`仅有 ${cases.length} 个案例；κ 区间会偏宽，只宜看方向`);
  return Object.freeze({ profile: BLIND_BENCH_PROFILE, cases: cases.length, annotators: [...names], dimensions, warnings });
}
