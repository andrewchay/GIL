import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvironment } from '../src/parser.ts';
import { createRuntime, recordedPolicy, rollout, verifyTrace, parseRecordedTrace } from '../src/rl.ts';
import { contentHash } from '../src/canonical.ts';
import { GilError } from '../src/ast.ts';
import type { PolicyDecision, Primitives } from '../src/rl-ast.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, new URL(`file://${root}`)), 'utf8');
const robot = 'examples/机器人导航.gil';

// 与 examples/robot-runtime.ts 相同的原语（测试内直接构造，独立于模块加载）。
const primitives: Primitives = (await import('../examples/robot-runtime.ts')).default;

/** 用一个贪心策略生成一段真实决策序列（含导致转移失败的最后一次调用）。 */
function recordedEpisode(seed: number) {
  const env = parseEnvironment(read(robot));
  const runtime = createRuntime(env, primitives);
  return rollout(runtime, () => ({ action: 'move', params: { direction: 'right' } }), { seed, maxSteps: 12, recordDecisions: true });
}

test('recorded replay reproduces the exact traceHash from decisions alone', () => {
  const env = parseEnvironment(read(robot));
  const runtime = createRuntime(env, primitives);
  const episode = recordedEpisode(7);
  assert.ok(episode.decisions && episode.decisions.length > 0, 'fixture must produce at least one decision');
  assert.ok(episode.decisions.length >= episode.steps.length, 'decisions include failed final calls');
  const result = verifyTrace(runtime, { seed: 7, maxSteps: 12, decisions: episode.decisions, expectedTraceHash: episode.traceHash });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.match, true);
  assert.equal(result.recomputedTraceHash, episode.traceHash);
  assert.equal(result.steps, episode.steps.length);
});

test('tampered decisions change the hash and fail verification', () => {
  const env = parseEnvironment(read(robot));
  const runtime = createRuntime(env, primitives);
  const decisions = recordedEpisode(7).decisions!;
  const tampered = decisions.map((d, i) => i === 0 ? { action: d.action, params: { ...(d.params as object), direction: 'up' } } : d);
  const result = verifyTrace(runtime, { seed: 7, maxSteps: 12, decisions: tampered, expectedTraceHash: 'sha256:' + '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.match, false);
});

test('exhausted decisions raise POLICY_TRACE_EXHAUSTED, never a silent cutoff', () => {
  const env = parseEnvironment(read(robot));
  const runtime = createRuntime(env, primitives);
  assert.throws(() => verifyTrace(runtime, { seed: 7, maxSteps: 12, decisions: [] }),
    (e: unknown) => e instanceof GilError && e.code === 'POLICY_TRACE_EXHAUSTED');
});

test('missing expectedTraceHash recomputes without claiming verification', () => {
  const env = parseEnvironment(read(robot));
  const runtime = createRuntime(env, primitives);
  const result = verifyTrace(runtime, { seed: 7, maxSteps: 12, decisions: recordedEpisode(7).decisions! });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.match, null);
  assert.match(result.recomputedTraceHash, /^sha256:[a-f0-9]{64}$/);
});

test('environment hash binding detects a different environment file', () => {
  const runtime = createRuntime(parseEnvironment(read(robot)), primitives);
  const wrongEnvHash = contentHash(parseEnvironment(read(robot).replace('4', '9').replace('9', '4')));
  const result = verifyTrace(runtime, { seed: 7, maxSteps: 12, decisions: recordedEpisode(7).decisions!, environmentHash: wrongEnvHash });
  assert.equal(result.environmentHashMatch, false);
  assert.equal(result.ok, false);
});

test('parseRecordedTrace rejects unknown fields, bad hashes and malformed decisions', () => {
  assert.throws(() => parseRecordedTrace({ seed: 1, maxSteps: 1, decisions: [], extra: true }), /Unknown fields/);
  assert.throws(() => parseRecordedTrace({ seed: 1, maxSteps: 1, decisions: [], expectedTraceHash: 'abc' }), /sha256/);
  assert.throws(() => parseRecordedTrace({ seed: 1, maxSteps: 1, decisions: [{ action: '', extra: 1 }] }));
  assert.throws(() => parseRecordedTrace({ seed: 1.5, maxSteps: 1, decisions: [] }), /safe integer/);
  const parsed = parseRecordedTrace({ seed: 1, maxSteps: 5, decisions: [{ action: 'move' }] });
  assert.deepEqual(parsed.decisions, [{ action: 'move' }]);
});

test('CLI verify-trace replays a real environment through the host runtime module', () => {
  const env = parseEnvironment(read(robot));
  const episode = recordedEpisode(7);
  const trace = JSON.stringify({ seed: 7, maxSteps: 12, decisions: episode.decisions,
    environmentHash: contentHash(env), expectedTraceHash: episode.traceHash });
  const tmp = new URL('./verify-trace-fixture.tmp.json', new URL(`file://${root}test/`));
  writeFileSync(tmp, trace, 'utf8');
  const run = spawnSync(process.execPath, ['src/cli.ts', 'verify-trace', robot, 'examples/robot-runtime.ts', 'test/verify-trace-fixture.tmp.json'], { cwd: root, encoding: 'utf8' });
  unlinkSync(tmp);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.match, true);
  assert.equal(out.environmentHashMatch, true);
});
