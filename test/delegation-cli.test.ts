import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('delegation CLI shows Agent denial then separately approved CTM simulation', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-delegation'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out)); assert.equal(out.ok, true);
  assert.equal(out.authorization, 'simulated-registry-and-grants'); assert.equal(out.assurance, 'synthetic-inputs-only');
  assert.match(out.warning, /NOT real/); assert.equal(out.snapshot.state.phase, 'CLOSED');
  const agent = out.outcomes.find((item: {actorId:string}) => item.actorId === 'AGENT-DEMO');
  assert.equal(agent.ok, false); assert.equal(agent.decision.outcome, 'Deny');
  assert.equal(out.snapshot.usage['G-AGENT'] ?? 0, 0);
  const events = out.snapshot.events;
  assert.equal(events.some((event: {type:string;actorId:string}) => event.type === 'Succeeded' && event.actorId === 'AGENT-DEMO'), false);
  assert.equal(events.some((event: {type:string;actorId:string}) => event.type === 'Denied' && event.actorId === 'AGENT-DEMO'), true);
  assert.match(out.plan.hash, /^sha256:/);
});
