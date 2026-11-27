import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyCore, verifyRl, verifyAgent, verifyAgentInput, VERIFY_VERSION } from '../src/verify.ts';
import { scenario } from '../src/agent-demo.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(new URL(path, new URL(`file://${root}`)), 'utf8');
const spec = 'docs/clinical-operations/monitoring-remediation/workflow.gil';
const ontology = 'docs/clinical-operations/monitoring-remediation/ontology.gil';
const robot = 'examples/机器人导航.gil';

test('verify core passes the clinical slice with hashes and versioned result', () => {
  const result = verifyCore(read(spec), [read(ontology)]);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.verifyVersion, VERIFY_VERSION);
  assert.equal(result.profile, 'gil-core-clinical-0.1');
  assert.deepEqual(result.checks.map(c => c.name), ['parse-spec', 'parse-ontology-0', 'link', 'core-check']);
  assert.match(result.hashes.spec, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.hashes['ontology-0'], /^sha256:[a-f0-9]{64}$/);
});

test('verify core reports each broken input as a named check without fail-fast', () => {
  const brokenSpec = read(spec).replace('spec', 'spcc');
  const result = verifyCore(brokenSpec, [read(ontology), 'ontology { name Broken version "0.0" }']);
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
  assert.notEqual(result.checks[0].code, undefined);
  // spec 坏了不阻止 ontology-1 的 parse 结果独立报告（不短路）。
  assert.equal(result.checks.find(c => c.name === 'parse-ontology-1')?.ok, false);
  // link 被跳过而不是报错：前置 parse 失败时该 check 不产生。
  assert.equal(result.checks.some(c => c.name === 'link'), false);
});

test('verify rl passes the robot environment and rejects a bad probability distribution', () => {
  const good = verifyRl(read(robot));
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  assert.equal(good.profile, 'gil-rl-experimental');
  const bad = verifyRl(read(robot).replace('0.9 ->', '0.8 ->')); // 概率和 ≠ 1
  assert.equal(bad.ok, false);
  assert.equal(bad.checks.find(c => c.name === 'rl-structure')?.ok, false);
});

test('verify agent runs structure and verdict dry-run on a real scenario', () => {
  const f = scenario('clinical');
  const result = verifyAgent({ draft: JSON.parse(JSON.stringify(f.draft)), snapshot: JSON.parse(JSON.stringify(f.snapshot)) });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.profile, 'gil-agent-contract-0.3-experimental');
  const verdict = result.checks.find(c => c.name === 'snapshot-verdict');
  assert.ok(verdict?.details);
  const report = JSON.parse(verdict.details);
  assert.ok(['True', 'False', 'Unknown'].includes(report.truth));
});

test('verify agent reports structure failure and non-boolean fact as named checks', () => {
  const f = scenario('clinical');
  const brokenDraft = JSON.parse(JSON.stringify(f.draft));
  delete brokenDraft.recipient; // 缺字段 ≠ null（未决）；exact 校验必须拒绝
  const missing = verifyAgent({ draft: brokenDraft, snapshot: f.snapshot });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find(c => c.name === 'draft-structure')?.code, 'INVALID_CONTRACT');
  const badFact = JSON.parse(JSON.stringify(f));
  badFact.draft.claim.fact = 'analysisReady';      // 让 claim 真正读取 facts
  badFact.snapshot.facts.analysisReady = 'text-not-bool';
  const typeError = verifyAgent(badFact);
  // 判定 dry-run 对类型错误 fail：这是 verify 的失败，不是 Unknown。
  assert.equal(typeError.checks.find(c => c.name === 'snapshot-verdict')?.ok, false);
});

test('verify agent input rejects files with extra or missing fields', () => {
  assert.throws(() => verifyAgentInput({ draft: {}, snapshot: {}, extra: 1 }), (e: unknown) =>
    e instanceof Error && (e as { code?: string }).code === 'VERIFY_INPUT');
  assert.throws(() => verifyAgentInput({ draft: {} }), (e: unknown) =>
    e instanceof Error && (e as { code?: string }).code === 'VERIFY_INPUT');
});

test('CLI verify commands exit nonzero on failure and emit versioned results', () => {
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ['src/cli.ts', ...args], { cwd: root, encoding: 'utf8' });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
  const good = run(['verify', 'core', spec, ontology]);
  assert.equal(good.status, 0);
  assert.equal(good.out.ok, true);
  assert.equal(good.out.verifyVersion, 'gil-verify-0.1');
  const bad = run(['verify', 'core', spec]);
  assert.equal(bad.status, 1);
  assert.equal(bad.out.ok, false);
  const agent = run(['verify', 'agent', '-']);
  assert.equal(agent.status, 1);
  const unknown = run(['verify', 'nonsense', 'x']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.out.code, 'CLI_ERROR');
});
