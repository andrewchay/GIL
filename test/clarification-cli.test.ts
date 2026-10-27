import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const input = 'docs/clinical-operations/monitoring-remediation/interpretation.gil';
const fixture = 'conformance/clinical-interpretation.json';
function run(extra: string[] = []) { const result = spawnSync(process.execPath, ['src/cli.ts', 'clarify', input, fixture, ...extra], { cwd: root, encoding: 'utf8' }); return { status: result.status, out: JSON.parse(result.stdout) }; }
test('A17/A24 CLI preserves open parameters, options and action-specific blocking', () => {
  const { status, out } = run(); assert.equal(status, 0); assert.equal(out.authorization, 'not-implemented');
  assert.equal(out.initialQuestions.length, 4); assert.equal(out.session.accepted, undefined);
  const due = out.initialQuestions.find((q: {target: string}) => q.target === 'remediationDueAt');
  assert.deepEqual(due.affects, ['classifyOverdue']);
  const operation = out.initialQuestions.find((q: {target: string}) => q.target === 'intendedOperation');
  assert.deepEqual(operation.options, ['Clinical.PrepareEvidence', 'Clinical.SubmitForReview', 'Clinical.RequestClosure']);
  assert.equal(out.session.events.some((event: {type: string}) => event.type === 'Answer'), false);
});
test('synthetic answers and precise acceptance are explicitly not real user consent', () => {
  const { status, out } = run(['--demo-answer']); assert.equal(status, 0);
  assert.match(out.warning, /synthetic/); assert.equal(out.authorization, 'not-implemented');
  assert.match(out.session.accepted.resolvedHash, /^sha256:/);
  const answers = out.session.events.filter((event: {type: string}) => event.type === 'Answer'); assert.equal(answers.length, 4);
  assert.equal(answers.every((event: {actorId: string}) => event.actorId === 'HUMAN-DEMO'), true);
});
