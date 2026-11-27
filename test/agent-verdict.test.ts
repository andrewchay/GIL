import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/agent-sdk.ts';
import type { ActionAdapter, VerdictInfo } from '../src/agent-sdk.ts';
import { DecisionLog, memorySink, verdictIdentity } from '../src/decision-log.ts';
import { demoHost, scenario } from '../src/agent-demo.ts';

/** 取 create 后的 Propose 事件；审计链第一个环节。 */
function proposeEvent(view: Record<string, unknown>) {
  const events = view.events as ({ type: string; actor: string; binding: string; verdict?: VerdictInfo; decisionId?: string }[]);
  assert.equal(events[0].type, 'Propose');
  return events[0];
}
function ready(service: AgentService, f: ReturnType<typeof scenario>, id: string, binding: string): string {
  const v1 = service.answer('owner', id, binding, 'internal-reviewers');
  const v2 = service.accept('owner', id, String(v1.binding));
  const v3 = service.approve('reviewer', id, String(v2.binding), 'publication-review');
  return String(v3.binding);
}

test('create embeds a self-contained verdict even without an audit sink', () => {
  const service = new AgentService(demoHost());
  const view = service.create('agent', scenario('clinical').draft, scenario('clinical').snapshot);
  const event = proposeEvent(view);
  assert.ok(event.verdict, 'verdict must be present without any sink');
  assert.equal(event.decisionId, undefined);
  // 第三方用同一算法重算：事件内嵌哈希与判定内容逐位一致。
  assert.equal(event.verdict.verdictHash, verdictIdentity(event.verdict));
  // verdict 与 get().report 是同一判定的两种投影。
  const report = view.report as { truth: string; observation: string; issues: string[]; reviewRequired: boolean };
  assert.equal(event.verdict.truth, report.truth);
  assert.equal(event.verdict.observation, report.observation);
  assert.deepEqual(event.verdict.issues, report.issues);
});

test('configured sink records the create verdict; event decisionId matches the log record', () => {
  const sink = memorySink();
  const host = demoHost(); host.decisionLog = sink;
  const service = new AgentService(host);
  const f = scenario('clinical');
  const view = service.create('agent', f.draft, f.snapshot);
  const event = proposeEvent(view);
  const records = new DecisionLog(sink).records();
  assert.equal(records.length, 1);
  const record = records[0] as { kind: string; id: string; contractHash: string; snapshotHash: string; claimKind: string; outcome?: string };
  assert.equal(record.kind, 'decision');
  assert.equal(event.decisionId, record.id, 'event must reference the exact audit record');
  assert.equal(record.contractHash, view.contractHash);
  assert.equal(record.snapshotHash, view.snapshotHash);
  assert.equal(record.claimKind, f.draft.claim.kind);
  assert.equal(record.outcome, undefined, 'create-time record has no outcome');
});

test('settled outcomes are audited; unverified success stays Unknown in the log', async () => {
  const sink = memorySink();
  const adapter: ActionAdapter = {
    async execute(r) { return { requestHash: r.requestHash, status: 'Succeeded', output: {} }; },
    verify() { return false; },
  };
  const host = demoHost(adapter); host.decisionLog = sink;
  const service = new AgentService(host);
  const f = scenario('clinical');
  const v = service.create('agent', f.draft, f.snapshot);
  const b = ready(service, f, String(v.id), String(v.binding));
  const result = await service.execute('agent', String(v.id), b, 'k1');
  assert.equal(result.status, 'Unknown');
  const records = new DecisionLog(sink).records();
  assert.equal(records.length, 2, 'create verdict + settled outcome');
  const outcomeRecord = records[1] as { outcome?: string; truth: string; observation: string };
  assert.equal(outcomeRecord.outcome, 'Unknown');
  // 同一合同同一快照：outcome 变化不算语义漂移，判定身份必须一致。
  assert.equal(verdictIdentity(records[1] as never), verdictIdentity(records[0] as never));
});

test('failed receipts are audited as Failed, not Unknown', async () => {
  const sink = memorySink();
  const adapter: ActionAdapter = {
    async execute(r) { return { requestHash: r.requestHash, status: 'Failed', output: {} }; },
    verify() { return true; },
  };
  const host = demoHost(adapter); host.decisionLog = sink;
  const service = new AgentService(host);
  const f = scenario('clinical');
  const v = service.create('agent', f.draft, f.snapshot);
  const b = ready(service, f, String(v.id), String(v.binding));
  assert.equal((await service.execute('agent', String(v.id), b, 'k1')).status, 'Failed');
  const records = new DecisionLog(sink).records();
  assert.equal((records[1] as { outcome?: string }).outcome, 'Failed');
});

test('tampering with the audit line breaks reconciliation against the embedded verdict', () => {
  const sink = memorySink();
  const host = demoHost(); host.decisionLog = sink;
  const service = new AgentService(host);
  const f = scenario('clinical');
  const view = service.create('agent', f.draft, f.snapshot);
  const event = proposeEvent(view);
  const tampered = sink.text().replace('"truth":"True"', '"truth":"False"');
  const broken = memorySink(tampered);
  assert.throws(() => new DecisionLog(broken).records(), (e: unknown) =>
    e instanceof Error && 'code' in e && (e as { code: string }).code === 'LOG_TAMPERED');
  // 未篡改的原始日志可正常重读，且与事件引用一致。
  const records = new DecisionLog(sink).records();
  assert.equal((event as { decisionId?: string }).decisionId, records[0].id);
});

test('audit sink IO failure fails closed on create instead of writing an unaudited contract', () => {
  const host = demoHost(); host.decisionLog = {
    appendLine() { throw new Error('disk full'); },
    readText() { return ''; },
  };
  const service = new AgentService(host);
  assert.throws(() => service.create('agent', scenario('clinical').draft, scenario('clinical').snapshot), /disk full/);
});
