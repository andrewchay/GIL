import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const spec = 'docs/clinical-operations/monitoring-remediation/workflow.gil';
const ontology = 'docs/clinical-operations/monitoring-remediation/ontology.gil';
function run(args: string[]) { const result = spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: root, encoding: 'utf8' }); return { status: result.status, out: JSON.parse(result.stdout) }; }
test('CLI parses and hashes ontology', () => {
  const { status, out } = run(['ast', ontology]); assert.equal(status, 0); assert.match(out.hash, /^sha256:[a-f0-9]{64}$/); assert.equal(out.ast.profile, 'gil-core-clinical-0.1');
});
test('CLI checks clinical spec with exact ontology', () => {
  const { status, out } = run(['check', spec, ontology]); assert.equal(status, 0); assert.equal(out.ok, true); assert.deepEqual(out.diagnostics, []);
});
test('CLI runs synthetic clinical path but never claims authorization', () => {
  const { status, out } = run(['simulate', spec, ontology, 'conformance/clinical-core.json']);
  assert.equal(status, 0); assert.equal(out.ok, true); assert.equal(out.state.phase, 'CLOSED'); assert.equal(out.trace.length, 4);
  assert.equal(out.authorization, 'not-implemented'); assert.equal(out.mode, 'core-simulation'); assert.match(out.warning, /not authorization/);
});
test('CLI errors are structured and nonzero', () => {
  const { status, out } = run(['check', spec]); assert.equal(status, 1); assert.equal(out.ok, false); assert.equal(typeof out.code, 'string');
});
