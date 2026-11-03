/**
 * 盲测管线演示：合成 40 例 → 生成盲测包与回答表 → 模拟三份回答 → 算 κ。
 *
 * 合成回答由真实系统判定加上受控扰动产生，用来证明管线可用。
 * **它不能替代真人标注**：κ 的具体数值在这里没有科学意义，
 * 只用于验证"生成—回收—分析"这条链路不丢信息。
 */
import { importCases, renderBlindPack, renderResponseSheet, renderAnswerKey, analyze } from './blind-bench.ts';
import type { Case, ResponseSheet, AnalysisReport } from './blind-bench.ts';
import { OBSERVATION_LABELS, TRUTH_LABELS } from './blind-bench.ts';

const claim = { kind: 'Descriptive', fact: 'recordAbsent', causalDesign: null,
  uncertainty: 'None', uncertaintyMethod: 'None', requiresIndependentSources: false } as const;

const observation = (over: Record<string, unknown> = {}) => ({
  readability: 'Available', completeness: 'Complete', searched: true, matches: 0,
  mappingValid: true, applicable: true, windowMature: true, scopeCovered: true,
  watermarkCovered: true, closureBasis: 'closure-v1', ...over });

/** 覆盖闭合缺失的各条边界：任一条件不满足都应降级。 */
const VARIANTS: Record<string, unknown>[] = [
  {},                                                    // 完全闭合 → ConfirmedAbsent
  { matches: 1 },                                        // 有命中 → Observed
  { completeness: 'Partial' },                           // 覆盖不全 → NotObserved
  { completeness: 'Unknown' },
  { readability: 'Partial' },
  { readability: 'Unavailable' },                        // 不可读 → UnableToDetermine
  { searched: false },
  { mappingValid: false },
  { applicable: false },
  { windowMature: false },                               // 窗口未成熟 → NotObserved
  { scopeCovered: false },
  { watermarkCovered: false },
  { closureBasis: null },                                // 无闭合依据 → NotObserved
  { matches: 2, readability: 'Partial' },
  { completeness: 'Partial', windowMature: false },
];

export function syntheticCases(count = 40): Case[] {
  const inputs = [];
  for (let index = 0; index < count; index++) {
    const variant = VARIANTS[index % VARIANTS.length];
    const withConflict = index % 8 === 3;
    inputs.push({
      id: `S-${String(index + 1).padStart(2, '0')}`,
      domain: index % 2 === 0 ? 'clinical' : 'growth',
      claim,
      snapshot: { facts: {}, conflicts: withConflict ? ['recordAbsent'] : [], lineageRoots: ['synthetic-root'], observation: observation(variant) },
      disclosure: { sanitized: true, checkedBy: 'synthetic' },
    });
  }
  return importCases(inputs);
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

/**
 * 模拟标注者：以系统判定为基准，按给定错误率扰动。
 * 这不是"模拟真人"，只是造出已知一致度以验证 κ 能否被复现。
 */
function syntheticSheet(name: string, cases: readonly Case[], errorRate: number, seed: number): ResponseSheet {
  const random = rng(seed), answers = new Map<string, { truth: string; observation: string }>();
  for (const item of cases) {
    const flip = random() < errorRate;
    const truth = item.system.truth, obs = item.system.observation;
    if (!flip) { answers.set(item.id, { truth, observation: obs }); continue; }
    const truthPool = TRUTH_LABELS.filter(label => label !== truth);
    const obsPool = OBSERVATION_LABELS.filter(label => label !== obs);
    answers.set(item.id, {
      truth: truthPool[Math.floor(random() * truthPool.length)],
      observation: obsPool[Math.floor(random() * obsPool.length)],
    });
  }
  return { annotator: name, answers };
}

export function blindBenchDemo() {
  const cases = syntheticCases(40);
  const sheets = [syntheticSheet('模拟标注者-1', cases, 0.1, 101),
    syntheticSheet('模拟标注者-2', cases, 0.15, 202),
    syntheticSheet('模拟标注者-3', cases, 0.2, 303)];
  const report: AnalysisReport = analyze(cases, sheets, { samples: 500 });

  const truth = report.dimensions.find(d => d.dimension === 'truth')!;
  const obs = report.dimensions.find(d => d.dimension === 'observation')!;

  return {
    ok: report.cases === 40 && truth.overall.subjects === 40 && Number.isFinite(truth.overall.kappa),
    mode: 'synthetic-blind-bench-pipeline',
    syntheticAnswers: true,
    warning: 'SYNTHETIC ONLY: answers are generated from the system verdict with controlled noise. The kappa values validate the pipeline, not human agreement.',
    cases: report.cases,
    annotators: report.annotators,
    blindPackBytes: renderBlindPack(cases).length,
    responseSheetRows: renderResponseSheet(cases).trim().split('\n').length - 1,
    answerKeyBytes: renderAnswerKey(cases).length,
    truth: { kappa: round(truth.overall.kappa), interval: [round(truth.interval.low), round(truth.interval.high)],
      band: truth.band, unanimous: truth.unanimous, disputed: truth.disputed.length },
    observation: { kappa: round(obs.overall.kappa), interval: [round(obs.interval.low), round(obs.interval.high)],
      band: obs.band, unanimous: obs.unanimous, disputed: obs.disputed.length },
    pairwise: truth.pairwise.map(p => ({ pair: p.pair, kappa: round(p.kappa) })),
    warnings: report.warnings,
    boundaries: [
      'synthetic answers cannot estimate real human agreement',
      'kappa measures readability of the case material, never correctness of the system',
      'disagreement with the majority is not an error rate',
      'blind pack contains no verdicts; the answer key must never reach annotators',
    ],
  };
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }
