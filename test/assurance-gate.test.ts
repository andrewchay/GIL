import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assuranceDemo } from '../src/assurance-demo.ts';

const scenario = assuranceDemo() as Record<string, any>;

test('Phase4 baseline: accepted plan, submitted evidence, valid attestation, approved closure', () => {
  assert.equal(scenario.ok, true);
  assert.deepEqual(scenario.scenarios.baseline.path.map((step: { ok: boolean }) => step.ok), [true, true, true]);
  assert.equal(scenario.scenarios.baseline.close.ok, true);
  assert.equal(scenario.scenarios.baseline.phase, 'CLOSED');
});

test('attestation bound to another evidence hash blocks review even when Core conditions hold', () => {
  assert.equal(scenario.scenarios.assuranceConfigured.evidenceMismatch.ok, false);
  assert.equal(scenario.scenarios.assuranceConfigured.evidenceMismatch.code, 'ATTESTATION_INVALID');
});

test('self-reported reviewStillValid is never the authority once assurance is configured', () => {
  assert.equal(scenario.scenarios.assuranceConfigured.selfReportFalseIgnored.ok, true);
});

test('verifier may not be the submitter', () => {
  assert.equal(scenario.scenarios.selfReview.code, 'PERSON_SEPARATION');
});

test('revoked or expired attestation degrades to Unknown and blocks closure', () => {
  assert.equal(scenario.scenarios.revoked.close.ok, false);
  assert.equal(scenario.scenarios.revoked.evaluation.active, false);
  assert.equal(scenario.scenarios.revoked.evaluation.result, 'Unknown');
  assert.deepEqual(scenario.scenarios.revoked.evaluation.reasons, ['REVOKED']);
});

test('challenge after closure deactivates the attestation and authorises only a separate reopen', () => {
  const c = scenario.scenarios.challenge;
  assert.equal(c.closed, true);
  assert.equal(c.evaluation.active, false);
  assert.deepEqual(c.evaluation.reasons, ['CHALLENGED']);
  assert.equal(c.reopen.ok, true);
  assert.equal(c.reopen.phase, 'OPEN');
  assert.equal(c.historyPreserved, true);
});

test('evidence replacement invalidates the previous attestation binding', () => {
  const s = scenario.scenarios.evidenceSwap;
  assert.equal(s.submit.ok, true);
  assert.equal(s.close.ok, false);
  assert.equal(s.close.code, 'ATTESTATION_INVALID');
  assert.equal(s.freshReadiness.ready, false);
});

test('stale binding cannot be adopted for new evidence; a freshly issued pass can be rotated in', () => {
  assert.notEqual(scenario.scenarios.evidenceSwap.staleBindingAttempt, 'ADOPTED');
  assert.equal(scenario.scenarios.rotation.setAssurance, 'ADOPTED');
  assert.equal(scenario.scenarios.rotation.close.ok, true);
});

test('CLI demo-assurance reports synthetic-only assurance and exits zero', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-assurance'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out).slice(0, 400));
  assert.equal(out.mode, 'synthetic-assurance-simulation');
  assert.match(out.warning, /NOT real authentication/);
  assert.equal(out.ok, true);
});
