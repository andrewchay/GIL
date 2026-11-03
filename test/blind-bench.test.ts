import test from 'node:test';
import assert from 'node:assert/strict';
import { fleissKappa, cohenKappa, bootstrapInterval, band } from '../src/agreement.ts';
import { importCase, importCases, renderBlindPack, renderResponseSheet, renderAnswerKey,
  parseResponseSheet, analyze } from '../src/blind-bench.ts';
import { GilError } from '../src/ast.ts';

const error = (code: string) => (e: unknown) => e instanceof GilError && e.code === code;

const observation = (over: Record<string, unknown> = {}) => ({
  readability: 'Available', completeness: 'Complete', searched: true, matches: 0,
  mappingValid: true, applicable: true, windowMature: true, scopeCovered: true,
  watermarkCovered: true, closureBasis: 'closure-v1', ...over });
const claim = (over: Record<string, unknown> = {}) => ({ kind: 'Descriptive', fact: 'recordAbsent',
  causalDesign: null, uncertainty: 'None', uncertaintyMethod: 'None', requiresIndependentSources: false, ...over });
const caseInput = (id: string, over: Record<string, unknown> = {}, claimOver: Record<string, unknown> = {}) => ({
  id, domain: 'clinical', claim: claim(claimOver),
  snapshot: { facts: {}, conflicts: [], lineageRoots: ['root-a'], observation: observation(over) },
  disclosure: { sanitized: true, checkedBy: 'operator' } });

// ---------- agreement ----------

test('fleiss kappa is 1 for unanimous ratings and negative for systematic disagreement', () => {
  assert.equal(fleissKappa([['A', 'A', 'A'], ['B', 'B', 'B'], ['A', 'A', 'A']]).kappa, 1);
  assert.ok(fleissKappa([['A', 'A', 'B'], ['B', 'B', 'A'], ['A', 'B', 'A']]).kappa < 0);
});

test('fleiss kappa matches a hand-computed example', () => {
  // 4 subjects, 3 raters, categories A/B. P̄ = (1+1+0+0.3333)/4 = 0.58333
  const subjects = [['A', 'A', 'A'], ['A', 'A', 'A'], ['A', 'B', 'B'], ['A', 'B', 'C']];
  const result = fleissKappa(subjects);
  // A:8 B:3 C:1，共 12 个标注 → Pₑ = (8/12)² + (3/12)² + (1/12)²
  assert.ok(Math.abs(result.expected - ((8 / 12) ** 2 + (3 / 12) ** 2 + (1 / 12) ** 2)) < 1e-12);
  // P̄ = (1 + 1 + 1/3 + 0) / 4
  assert.ok(Math.abs(result.observed - 0.5833333333333334) < 1e-12);
  assert.ok(Math.abs(result.kappa - 0.1428571428571429) < 1e-9);
});

test('cohen kappa compares exactly two raters', () => {
  assert.equal(cohenKappa(['A', 'B', 'A'], ['A', 'B', 'A']).kappa, 1);
  assert.throws(() => cohenKappa(['A'], ['A', 'B']), error('AGREEMENT_INPUT'));
});

test('kappa rejects missing values, single categories and single raters', () => {
  assert.throws(() => fleissKappa([['A']]), error('AGREEMENT_INPUT'));
  assert.throws(() => fleissKappa([['A', 'A'], ['A', 'A']]), error('AGREEMENT_INPUT'));
  assert.throws(() => fleissKappa([['A', 'A'], ['B']]), error('AGREEMENT_INPUT'));
});

test('bootstrap interval is deterministic for a fixed seed and brackets the point estimate', () => {
  const subjects = [['A', 'A', 'A'], ['B', 'B', 'A'], ['A', 'B', 'A'], ['B', 'B', 'B'], ['A', 'A', 'B']];
  const first = bootstrapInterval(subjects, { samples: 500 });
  const second = bootstrapInterval(subjects, { samples: 500 });
  assert.deepEqual(first, second);
  const point = fleissKappa(subjects).kappa;
  assert.ok(first.low <= point + 1e-9 && point <= first.high + 1e-9);
});

test('band thresholds are stated, not implied', () => {
  assert.equal(band(0.85), 'substantial');
  assert.equal(band(0.6), 'moderate');
  assert.equal(band(0.4), 'fair');
  assert.equal(band(0.39), 'poor');
});

// ---------- import ----------

test('import refuses unsanitized cases instead of trusting a promise', () => {
  const input = { ...caseInput('C-01'), disclosure: { sanitized: false, checkedBy: 'operator' } };
  assert.throws(() => importCase(input), error('NOT_SANITIZED'));
  const omitted = caseInput('C-01'); delete (omitted as Record<string, unknown>).disclosure;
  assert.throws(() => importCase(omitted), error('INVALID_CASE'));
});

test('import rejects unknown fields so business text cannot ride along', () => {
  assert.throws(() => importCase({ ...caseInput('C-01'), notes: 'patient X at site 12' }), error('INVALID_CASE'));
});

test('system verdict comes from the real evaluator, not from caller input', () => {
  const closed = importCase(caseInput('C-01'));
  assert.equal(closed.system.truth, 'True');
  assert.equal(closed.system.observation, 'ConfirmedAbsent');
  const partial = importCase(caseInput('C-02', { completeness: 'Partial' }));
  assert.equal(partial.system.truth, 'Unknown');
  assert.equal(partial.system.observation, 'NotObserved');
  const conflict = importCase(caseInput('C-03', {}, {}));
  assert.equal(conflict.system.truth, 'True', 'no conflict declared');
  const conflicted = importCase({ ...caseInput('C-04'), snapshot: { facts: {}, conflicts: ['recordAbsent'],
    lineageRoots: ['r'], observation: observation() } });
  assert.equal(conflicted.system.observation, 'UnableToDetermine');
  assert.equal(conflicted.system.reviewRequired, true);
});

test('cases need unique ids and at least two verdict categories', () => {
  assert.throws(() => importCases([caseInput('C-01'), caseInput('C-01', { completeness: 'Partial' })]), error('DUPLICATE_CASE'));
  assert.throws(() => importCases([caseInput('C-01'), caseInput('C-02')]), error('DEGENERATE_PACK'));
});

// ---------- rendering ----------

test('the blind pack never contains the system verdict', () => {
  const cases = importCases([caseInput('C-01'), caseInput('C-02', { completeness: 'Partial' })]);
  const pack = renderBlindPack(cases);
  assert.ok(pack.includes('C-01') && pack.includes('Partial'));
  // Observed 是 NotObserved 的子串，检查它就覆盖两者。
  for (const leak of ['Observed', 'UnableToDetermine', 'reviewRequired', 'issues']) {
    assert.ok(!pack.includes(leak), `blind pack leaked ${leak}`);
  }
  assert.ok(renderAnswerKey(cases).includes('ConfirmedAbsent'));
});

test('the response sheet prefills ids and leaves answers empty', () => {
  const cases = importCases([caseInput('C-01'), caseInput('C-02', { completeness: 'Partial' })]);
  assert.equal(renderResponseSheet(cases), 'case_id,truth,observation\nC-01,,\nC-02,,\n');
});

// ---------- responses and analysis ----------

function sheets(cases: ReturnType<typeof importCases>, rows: Record<string, [string, string][]>) {
  return Object.entries(rows).map(([name, answers]) => ({
    annotator: name,
    answers: new Map(cases.map((item, index) => [item.id, { truth: answers[index][0], observation: answers[index][1] }])),
  }));
}

test('parse rejects missing, unknown and out-of-range answers without imputing', () => {
  const cases = importCases([caseInput('C-01'), caseInput('C-02', { completeness: 'Partial' })]);
  const ok = 'case_id,truth,observation\nC-01,True,ConfirmedAbsent\nC-02,Unknown,NotObserved\n';
  assert.equal(parseResponseSheet('A', ok, cases).answers.size, 2);
  assert.throws(() => parseResponseSheet('A', 'case_id,truth,observation\nC-01,True,ConfirmedAbsent\n', cases), error('INVALID_RESPONSE'));
  assert.throws(() => parseResponseSheet('A', 'case_id,truth,observation\nC-01,True,ConfirmedAbsent\nC-99,True,Observed\n', cases), error('INVALID_RESPONSE'));
  assert.throws(() => parseResponseSheet('A', 'case_id,truth,observation\nC-01,Maybe,ConfirmedAbsent\nC-02,True,Observed\n', cases), error('INVALID_RESPONSE'));
  assert.throws(() => parseResponseSheet('A', ok.replace('case_id,truth,observation', 'id,t,o'), cases), error('INVALID_RESPONSE'));
});

test('analysis reports per-dimension kappa, pairwise disagreement and system differences', () => {
  const cases = importCases([caseInput('C-01'), caseInput('C-02', { completeness: 'Partial' }),
    caseInput('C-03', { matches: 1 }), caseInput('C-04', { readability: 'Unavailable' })]);
  const parsed = sheets(cases, {
    A: [['True', 'ConfirmedAbsent'], ['Unknown', 'NotObserved'], ['False', 'Observed'], ['True', 'UnableToDetermine']],
    B: [['True', 'ConfirmedAbsent'], ['Unknown', 'Observed'], ['False', 'Observed'], ['True', 'UnableToDetermine']],
    C: [['True', 'ConfirmedAbsent'], ['Unknown', 'NotObserved'], ['False', 'NotObserved'], ['Unknown', 'UnableToDetermine']],
  });
  const report = analyze(cases, parsed, { samples: 200 });
  assert.equal(report.cases, 4);
  assert.equal(report.annotators.length, 3);
  const truth = report.dimensions.find(d => d.dimension === 'truth')!;
  const obs = report.dimensions.find(d => d.dimension === 'observation')!;
  assert.ok(truth.overall.kappa > obs.overall.kappa, 'truth is more consistent than observation here');
  assert.equal(truth.pairwise.length, 3);
  // C-04 系统判 Unknown，但两人说 True → 多数意见与系统不一致。
  assert.ok(truth.differsFromSystem.includes('C-04'));
  // observation 上 C-02 与 C-03 都有分歧。
  assert.ok(obs.disputed.includes('C-02'));
  assert.ok(obs.disputed.includes('C-03'));
  // 系统与多数不一致只表示分歧位置，不表示谁对。
  assert.ok(truth.unanimous >= 3);
  assert.ok(report.warnings.length > 0, 'small samples and wide intervals must be flagged');
});

test('analysis refuses a single annotator or duplicate labels', () => {
  const cases = importCases([caseInput('C-01'), caseInput('C-02', { completeness: 'Partial' })]);
  const one = sheets(cases, { A: [['True', 'ConfirmedAbsent'], ['Unknown', 'NotObserved']] });
  assert.throws(() => analyze(cases, one), error('INVALID_RESPONSE'));
  assert.throws(() => analyze(cases, [...one, ...one]), error('INVALID_RESPONSE'));
});

// ---------- CLI roundtrip ----------

test('CLI pack and analyze round-trip without leaking verdicts', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { mkdtempSync, mkdir, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'gil-bench-'));
  try {
    const inputs = Array.from({ length: 8 }, (_, index) => caseInput(`C-0${index + 1}`,
      index % 3 === 0 ? { matches: 1 } : index % 3 === 1 ? { completeness: 'Partial' } : {}));
    const casesPath = join(dir, 'cases.json');
    writeFileSync(casesPath, JSON.stringify(inputs), 'utf8');
    const pack = spawnSync(process.execPath, ['src/cli.ts', 'bench:pack', casesPath, '--out', join(dir, 'run')],
      { cwd: root, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stdout);
    const blind = readFileSync(join(dir, 'run', '盲测案例.md'), 'utf8');
    assert.ok(!blind.includes('Observed'), 'blind pack must not contain verdicts');
    assert.ok(!blind.includes('NotObserved'));

    // 三份回答：两份贴近系统判定，一份略有扰动。
    const key = JSON.parse(readFileSync(join(dir, 'run', '答案键.json'), 'utf8'));
    const sheets = key.cases.map((item: { id: string }) => item.id).map((id: string, index: number) => {
      const system = key.cases.find((item: { id: string }) => item.id === id).system;
      const flip = index === 0;
      return { id, truth: flip ? 'Unknown' : system.truth, observation: flip ? 'NotObserved' : system.observation };
    });
    const sheetPaths: string[] = [];
    for (let rater = 1; rater <= 3; rater++) {
      const path = join(dir, 'run', `回答表-${rater}.csv`);
      // 只在 observation 维度上让第三位标注者与另两人不同，制造一处真实分歧。
      const rows = ['case_id,truth,observation',
        ...sheets.map((row: { id: string; truth: string; observation: string }) => {
          const divergent = rater === 3 && row.id === 'C-02';
          const observation = divergent ? (row.observation === 'Observed' ? 'NotObserved' : 'Observed') : row.observation;
          return `${row.id},${row.truth},${observation}`;
        })];
      writeFileSync(path, rows.join('\n') + '\n', 'utf8');
      sheetPaths.push(path);
    }
    const result = spawnSync(process.execPath, ['src/cli.ts', 'bench:analyze', casesPath, ...sheetPaths],
      { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'blind-bench-analysis');
    assert.equal(report.cases, 8);
    assert.equal(report.annotators.length, 3);
    assert.equal(report.dimensions.length, 2);
    assert.ok(report.warnings.some((w: string) => /案例数/.test(w)), 'small sample must warn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pipeline demo runs and declares its answers synthetic', async () => {
  const { blindBenchDemo } = await import('../src/blind-bench-demo.ts');
  const demo = blindBenchDemo();
  assert.equal(demo.ok, true);
  assert.equal(demo.syntheticAnswers, true);
  assert.equal(demo.cases, 40);
  assert.match(demo.warning, /SYNTHETIC ONLY/);
  assert.equal(demo.pairwise.length, 3);
  assert.ok(demo.boundaries.some((b: string) => /never correctness/.test(b)));
});
