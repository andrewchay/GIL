/**
 * 标注者一致性：Fleiss' κ 与 Cohen's κ。
 *
 * 用途是度量"独立标注者读同一份材料，能否得出同一判断"。它测的是**材料是否
 * 可读**，不是系统是否正确。κ 高只说明规则没有歧义，不说明规则是对的。
 *
 * 边界：
 * - 纯计算，不做 I/O，不读时钟。
 * - 缺失标注不插补：要么整份可用，要么拒绝并说明。
 * - κ 是观察一致度对随机一致度的校正；类别分布极不均衡时 κ 会失真，
 *   因此同时返回原始一致率与类别分布。
 */

import { GilError } from './ast.ts';

export const AGREEMENT_PROFILE = 'gil-annotation-agreement-0.1';

export interface KappaResult {
  readonly kappa: number;
  /** 观察到的平均一致比例 P̄。 */
  readonly observed: number;
  /** 随机期望一致比例 Pₑ。 */
  readonly expected: number;
  readonly subjects: number;
  readonly ratersPerSubject: number;
  /** 每个类别的被选次数，用于识别分布失衡。 */
  readonly categories: Readonly<Record<string, number>>;
  /** Pₑ 为 1 时 κ 无定义（全部标注同一类别），此时 kappa 为 0 且该标志为 true。 */
  readonly undefined: boolean;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
  readonly level: number;
  readonly samples: number;
}

function fail(code: string, message: string): never { throw new GilError(code, message); }

function tally(subjects: readonly (readonly string[])[]): { counts: Map<string, number>; names: string[]; n: number; N: number } {
  if (!Array.isArray(subjects) || subjects.length < 2) fail('AGREEMENT_INPUT', 'At least two subjects are required');
  const names = [...new Set(subjects.flat())].sort();
  if (names.length < 2) fail('AGREEMENT_INPUT', 'At least two distinct rating categories are required');
  const n = subjects[0].length;
  if (n < 2) fail('AGREEMENT_INPUT', 'At least two raters per subject are required');
  for (const subject of subjects) {
    if (subject.length !== n) fail('AGREEMENT_INPUT', 'Every subject needs the same number of raters (no missing values)');
    for (const rating of subject) if (!names.includes(rating)) fail('AGREEMENT_INPUT', `Unknown category ${String(rating)}`);
  }
  const counts = new Map<string, number>(names.map(name => [name, 0]));
  for (const subject of subjects) for (const rating of subject) counts.set(rating, counts.get(rating)! + 1);
  return { counts, names, n, N: subjects.length };
}

/** Fleiss' κ：适用于任意数量标注者，要求每人评全部对象。 */
export function fleissKappa(subjects: readonly (readonly string[])[]): KappaResult {
  const { counts, names, n, N } = tally(subjects);
  let pBar = 0;
  for (const subject of subjects) {
    const local = new Map<string, number>(names.map(name => [name, 0]));
    for (const rating of subject) local.set(rating, local.get(rating)! + 1);
    let agreements = 0;
    for (const value of local.values()) agreements += value * (value - 1);
    pBar += agreements / (n * (n - 1));
  }
  pBar /= N;
  let pExpected = 0;
  for (const name of names) { const share = counts.get(name)! / (N * n); pExpected += share * share; }
  const undefinedKappa = Math.abs(1 - pExpected) < 1e-12;
  const kappa = undefinedKappa ? 0 : (pBar - pExpected) / (1 - pExpected);
  return Object.freeze({
    kappa, observed: pBar, expected: pExpected, subjects: N, ratersPerSubject: n,
    categories: Object.freeze(Object.fromEntries(counts)), undefined: undefinedKappa,
  });
}

/** Cohen's κ：两标注者配对比较，用于定位"是谁和谁不一致"。 */
export function cohenKappa(a: readonly string[], b: readonly string[]): KappaResult {
  if (a.length !== b.length) fail('AGREEMENT_INPUT', 'Both raters must label the same subjects');
  const subjects = a.map((rating, index) => [rating, b[index]]);
  return fleissKappa(subjects);
}

/** 确定性伪随机，避免 bootstrap 结果每次运行都变。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 对对象做 bootstrap 重采样，给出 κ 的区间。
 *
 * 这不是精确置信区间：小样本下 bootstrap 会偏窄，且忽略标注者误差。
 * 报区间而不是点估计，是为了避免把 κ=0.61 说成"达标"。
 */
export function bootstrapInterval(subjects: readonly (readonly string[])[], options: { samples?: number; level?: number; seed?: number } = {}): Interval {
  tally(subjects);
  const samples = options.samples ?? 2000, level = options.level ?? 0.95, seed = options.seed ?? 20261103;
  if (!Number.isSafeInteger(samples) || samples < 100) fail('AGREEMENT_INPUT', 'Need at least 100 bootstrap samples');
  if (!(level > 0 && level < 1)) fail('AGREEMENT_INPUT', 'Level must be between 0 and 1');
  const random = rng(seed), values: number[] = [];
  for (let i = 0; i < samples; i++) {
    const resampled: string[][] = [];
    for (let j = 0; j < subjects.length; j++) resampled.push(subjects[Math.floor(random() * subjects.length)]);
    try { const result = fleissKappa(resampled); if (!result.undefined) values.push(result.kappa); }
    catch { /* 重采样可能只剩单一类别；跳过而不是伪造数值。 */ }
  }
  if (values.length < samples / 2) fail('AGREEMENT_INPUT', 'Too few valid bootstrap samples; sample size is too small');
  values.sort((x, y) => x - y);
  const lower = values[Math.floor((1 - level) / 2 * (values.length - 1))];
  const upper = values[Math.ceil((1 + level) / 2 * (values.length - 1))];
  return Object.freeze({ low: lower, high: upper, level, samples: values.length });
}

export type Band = 'substantial' | 'moderate' | 'fair' | 'poor';
/** Landis & Koch 的经验分档，仅作沟通用，不是通过标准。 */
export function band(kappa: number): Band {
  if (kappa > 0.8) return 'substantial';
  if (kappa >= 0.6) return 'moderate';
  if (kappa >= 0.4) return 'fair';
  return 'poor';
}
