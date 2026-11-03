import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionLog, memorySink, fileSink, repeatMismatchRate, summarize, fieldsFromReport, validateDecisionInput } from '../src/decision-log.ts';
import { agentDemo } from '../src/agent-demo.ts';
import { GilError } from '../src/ast.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const H1 = 'sha256:' + 'a'.repeat(64), H2 = 'sha256:' + 'b'.repeat(64);
const base = { decidedAt: '2026-11-03T08:00:00Z', contractHash: H1, snapshotHash: H2,
  claimKind: 'Descriptive', truth: 'True', observation: 'ConfirmedAbsent', issues: [], reviewRequired: false } as const;
const error = (code: string) => (e: unknown) => e instanceof GilError && e.code === code;

/** 真实 Agent 闭环的两次独立运行，用于验证确定性实现的自洽性。 */
async function twoRuns() {
  const log = new DecisionLog(memorySink());
  for (let run = 0; run < 2; run++) {
    const out = await agentDemo();
    for (const s of out.scenarios) {
      log.appendDecision(fieldsFromReport(s.view.report, s.view.draft.claim.kind, '2026-11-03T08:00:00Z',
        { contractHash: s.view.contractHash, snapshotHash: s.view.snapshotHash }, s.execution.status));
    }
  }
  return log;
}

test('deterministic replay yields zero repeat mismatch', async () => {
  const log = await twoRuns();
  const report = repeatMismatchRate(log.records());
  assert.equal(report.groups, 2, 'two domain contracts each repeated twice');
  assert.equal(report.examined, 2);
  assert.equal(report.mismatched, 0);
  assert.equal(report.rate, 0);
});

test('a differing verdict is counted as a mismatch instead of being averaged away', () => {
  const log = new DecisionLog(memorySink());
  log.appendDecision(base);
  log.appendDecision({ ...base, truth: 'Unknown' });
  log.appendDecision(base);
  const report = repeatMismatchRate(log.records());
  assert.equal(report.examined, 2);
  assert.equal(report.mismatched, 1);
  assert.equal(report.rate, 0.5);
});

test('outcome drift is not mistaken for a semantic mismatch', () => {
  const log = new DecisionLog(memorySink());
  log.appendDecision({ ...base, outcome: 'Unknown' });
  log.appendDecision({ ...base, outcome: 'Succeeded' });
  assert.equal(repeatMismatchRate(log.records()).rate, 0);
});

test('ground truth is appended, never overwrites the original decision', () => {
  const sink = memorySink();
  const log = new DecisionLog(sink);
  const decision = log.appendDecision(base);
  const before = sink.text();
  log.appendGroundTruth({ decisionId: decision.id, recordedAt: '2026-11-10T08:00:00Z', value: 'False', source: 'audit', auditor: 'auditor-1' });
  const after = sink.text();
  assert.ok(after.startsWith(before), 'existing lines must be byte-identical');
  assert.equal(after.split('\n').filter(Boolean).length, 2);
  const records = log.records();
  assert.equal(records[0].kind, 'decision');
  assert.equal((records[0] as typeof decision).truth, 'True');
});

test('backfilling an unknown decision is rejected', () => {
  const log = new DecisionLog(memorySink());
  assert.throws(() => log.appendGroundTruth({ decisionId: 'd-99-x', recordedAt: '2026-11-10T08:00:00Z',
    value: 'True', source: 'audit', auditor: 'a' }), error('UNKNOWN_DECISION'));
});

test('a second backfill must explicitly supersede the previous one', () => {
  const log = new DecisionLog(memorySink());
  const d = log.appendDecision(base);
  const first = log.appendGroundTruth({ decisionId: d.id, recordedAt: '2026-11-10T08:00:00Z', value: 'True', source: 'audit', auditor: 'a' });
  assert.throws(() => log.appendGroundTruth({ decisionId: d.id, recordedAt: '2026-11-11T08:00:00Z',
    value: 'False', source: 'audit', auditor: 'b' }), error('GROUND_TRUTH_CONFLICT'));
  const second = log.appendGroundTruth({ decisionId: d.id, recordedAt: '2026-11-11T08:00:00Z',
    value: 'False', source: 'audit', auditor: 'b', supersedes: first.id });
  const summary = summarize(log.records());
  assert.equal(summary.groundTruth.covered, 1);
  assert.equal(summary.groundTruth.bySource.audit, 1);
  assert.equal(second.supersedes, first.id);
});

test('tampering with any line is detected on the next read', () => {
  // 构造即校验：损坏的历史不会被静默接受。
  const forged = `{"kind":"decision","id":"d-1-x","sequence":1,"decidedAt":"2026-11-03T08:00:00Z","contractHash":"${H1}","snapshotHash":"${H2}","claimKind":"Descriptive","truth":"False","observation":"ConfirmedAbsent","issues":[],"reviewRequired":false,"recordHash":"sha256:${'0'.repeat(64)}"}\n`;
  assert.throws(() => new DecisionLog(memorySink(forged)), error('LOG_TAMPERED'));

  // 已打开的日志在重新读取时同样拒绝被改写的行。
  let text = '';
  const controllable = { appendLine: (line: string) => { text += line + '\n'; }, readText: () => text };
  const log = new DecisionLog(controllable);
  log.appendDecision(base);
  text = text.replace('"truth":"True"', '"truth":"False"');
  assert.throws(() => log.records(), error('LOG_TAMPERED'));
});

test('strict shape rejects unknown fields, bad hashes and non-ISO timestamps', () => {
  assert.throws(() => validateDecisionInput({ ...base, actor: 'agent' }), error('INVALID_LOG'));
  assert.throws(() => validateDecisionInput({ ...base, contractHash: 'sha256:short' }), error('INVALID_LOG'));
  assert.throws(() => validateDecisionInput({ ...base, decidedAt: 'yesterday' }), error('INVALID_LOG'));
  assert.throws(() => validateDecisionInput({ ...base, truth: 'Maybe' }), error('INVALID_LOG'));
  assert.throws(() => validateDecisionInput({ ...base, issues: ['A', 'A'] }), error('INVALID_LOG'));
  const { truth, ...missing } = base;
  assert.throws(() => validateDecisionInput(missing), error('INVALID_LOG'));
});

test('a getter is never executed and the caller object is not mutated', () => {
  const input: Record<string, unknown> = { ...base };
  let called = false;
  Object.defineProperty(input, 'claimKind', { get() { called = true; return 'Descriptive'; }, enumerable: true });
  assert.throws(() => validateDecisionInput(input));
  assert.equal(called, false);
  const mutable = { ...base, issues: ['X'] as string[] };
  const accepted = validateDecisionInput(mutable);
  mutable.issues.push('Y');
  assert.deepEqual(accepted.issues, ['X']);
});

test('summary keeps ground truth coverage and unknown share separate', () => {
  const log = new DecisionLog(memorySink());
  const a = log.appendDecision(base);
  log.appendDecision({ ...base, snapshotHash: 'sha256:' + 'c'.repeat(64), truth: 'Unknown', issues: ['INPUT_CONFLICT'], reviewRequired: true });
  log.appendGroundTruth({ decisionId: a.id, recordedAt: '2026-11-10T08:00:00Z', value: 'True', source: 'expert-consensus', auditor: 'panel' });
  const s = summarize(log.records());
  assert.equal(s.decisions, 2);
  assert.equal(s.byTruth.True, 1);
  assert.equal(s.byTruth.Unknown, 1);
  assert.equal(s.unknownShare, 0.5);
  assert.equal(s.reviewRequired, 1);
  assert.equal(s.groundTruth.covered, 1);
  assert.equal(s.groundTruth.coveredShare, 0.5);
  assert.equal(s.groundTruth.bySource['expert-consensus'], 1);
  assert.equal(s.repeat.groups, 0, 'distinct snapshots are not compared');
});

test('the file sink appends JSONL and survives a reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gil-log-'));
  const path = join(dir, 'nested', 'decisions.jsonl');
  try {
    new DecisionLog(fileSink(path)).appendDecision(base);
    const reopened = new DecisionLog(fileSink(path));
    reopened.appendDecision({ ...base, truth: 'False' });
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(reopened.records().length, 2);
    assert.equal(repeatMismatchRate(reopened.records()).rate, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupted file is rejected rather than silently skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gil-log-'));
  const path = join(dir, 'decisions.jsonl');
  try {
    writeFileSync(path, '{"kind":"decision"}\n', 'utf8');
    assert.throws(() => new DecisionLog(fileSink(path)), error('LOG_TAMPERED'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI demo reports determinism and never claims correctness', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = spawnSync(process.execPath, ['src/cli.ts', 'demo-decision-log'], { cwd: root, encoding: 'utf8' });
  const out = JSON.parse(run.stdout);
  assert.equal(run.status, 0, JSON.stringify(out));
  assert.equal(out.mode, 'synthetic-decision-log-simulation');
  assert.equal(out.productionAudit, false);
  assert.match(out.warning, /SYNTHETIC ONLY/);
  assert.equal(out.summary.decisions, 4);
  assert.equal(out.summary.repeat.rate, 0);
  assert.equal(out.afterBackfill.covered, 1);
  assert.ok(out.boundaries.some((b: string) => /never correctness/.test(b)));
});
