import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GilError } from '../src/ast.ts';
import type { Spec, Ontology } from '../src/ast.ts';
import type { GateConfig, Grant, ActionRequest, Approval, Identity } from '../src/delegation-ast.ts';
import type { Gate } from '../src/delegation.ts';
import { parse } from '../src/parser.ts';
import { link } from '../src/checker.ts';
import { initialize } from '../src/runtime.ts';
import { sourceArtifact, hashValue } from '../src/interpretation.ts';
import { startSession, answer, accept, resolvedHash } from '../src/exchange.ts';
import { bindPlan } from '../src/plans.ts';
import { createGate, snapshot, authorize, execute, requestHash, approve, revokeGrant, revokeApproval, setCurrentPlan } from '../src/delegation.ts';
import { createBlockerLedger } from '../src/blockers.ts';
import { createObligation } from '../src/deadlines.ts';

const base = new URL('../docs/clinical-operations/monitoring-remediation/', import.meta.url);
const linked = link(parse(readFileSync(new URL('workflow.gil', base), 'utf8')) as Spec,
  [parse(readFileSync(new URL('ontology.gil', base), 'utf8')) as Ontology]);
const core = JSON.parse(readFileSync(new URL('../conformance/clinical-core.json', import.meta.url), 'utf8'));
// Phase5 受信工件：调用者输入里不允许出现这些键，它们只能来自闸门注入。
const trustedKeys = ['actionAt', 'blockers', 'deadline', 'escalation'];
const callerInputs = (() => { const copy = structuredClone(core.inputs); for (const key of trustedKeys) delete copy[key]; return copy; })();
const blockers = createBlockerLedger({ findingId: 'FINDING-DEMO', entries: [
  { id: 'B-POLICY', target: 'recordReviewPass', kind: 'policy', owner: 'coord', resolutionAuthority: 'cra', state: 'RESOLVED', resolvedBy: 'cra', resolvedAt: 1 },
  { id: 'B-DISPUTE', target: 'closeFinding', kind: 'dispute', owner: 'cra', resolutionAuthority: 'ctm', state: 'RESOLVED', resolvedBy: 'ctm', resolvedAt: 2 } ] });
const obligation = createObligation({ findingId: 'FINDING-DEMO', dueAt: 100000, sourceRef: 'POLICY-TIMELINE', sourceVersion: 'V1', policy: 'BLOCK-CLOSURE' }, 0);
const scope = { studyId: 'STUDY-DEMO', siteId: 'SITE-DEMO', findingId: 'FINDING-DEMO' };
const human = { actorId: 'human', kind: 'human' as const, mayAnswer: true, mayAccept: true };
const identities: Identity[] = [
  { actorId: 'coord', kind: 'human', role: 'Coordinator' }, { actorId: 'cra', kind: 'human', role: 'CRA' },
  { actorId: 'ctm', kind: 'human', role: 'CTM' }, { actorId: 'service', kind: 'human', role: 'Service' },
  { actorId: 'agent', kind: 'agent', role: 'Agent' }, { actorId: 'agent2', kind: 'agent', role: 'Agent' },
];
const actions: Record<string, string[]> = { coord: ['submitEvidence'], cra: ['recordReviewPass', 'requestChanges'],
  ctm: ['closeFinding', 'approveClosure'], service: ['recordAcceptedPlan', 'invalidateReview'], agent: ['dispatchTask'], agent2: ['dispatchTask'] };
function grant(actorId: string, patch: Partial<Grant> = {}): Grant {
  return { id: `g-${actorId}`, version: '1', actorId, scope: { ...scope }, actions: actions[actorId],
    effect: 'allow', autonomy: 'Execute', validFrom: 0, validUntil: 1000, budgetId: `b-${actorId}`, maxActions: 20, ...patch };
}
function plan(version = '1') {
  const source = sourceArtifact('request', version, 'Resolve training finding');
  let s = startSession(source, { id: 'candidate', plan: { findingId: '${findingId}' },
    interpretation: { kind: 'interpretation', name: 'Training', sourceText: source.text, imports: [], items: [
      { kind: 'open', name: 'findingId', type: 'Text' }, { kind: 'open', name: 'applicableProtocolVersion', type: 'Text' }] },
    affects: { findingId: ['closeFinding'], applicableProtocolVersion: ['closeFinding'] } }, human,
    { sources: [source], references: [], types: ['Text'] });
  s = answer(s, 'findingId', scope.findingId, human);
  s = answer(s, 'applicableProtocolVersion', 'PROTOCOL-V3', human);
  s = accept(s, { interpretationHash: s.interpretationHash, planHash: s.planHash, resolvedHash: resolvedHash(s) }, human);
  return bindPlan(s, linked, scope, 'REQ-H1');
}
function fixture(patch: Partial<GateConfig> = {}) {
  let time = 100;
  const config: GateConfig = { linked, state: initialize(linked, core.initialState), plan: plan(),
    identities: structuredClone(identities), grants: identities.map(i => grant(i.actorId)), now: () => time,
    blockers, deadline: obligation, ...patch };
  return { gate: createGate(config), config, time: (n: number) => { time = n; } };
}
function req(gate: Gate, actorId: string, action: string, params = {}, inputs = callerInputs): ActionRequest {
  const s = snapshot(gate);
  return { actorId, action, params: structuredClone(params), inputs: structuredClone(inputs), expectedStateHash: s.stateHash, expectedPlanHash: s.planHash };
}
function reviewed(gate: Gate) {
  assert.equal(execute(gate, req(gate, 'service', 'recordAcceptedPlan', { planHash: snapshot(gate).planHash })).ok, true);
  assert.equal(execute(gate, req(gate, 'coord', 'submitEvidence')).ok, true);
  assert.equal(execute(gate, req(gate, 'cra', 'recordReviewPass')).ok, true);
}
function approval(gate: Gate, request: ActionRequest, patch: Partial<Approval> = {}): Approval {
  return { id: 'approval', version: '1', actorId: 'ctm', planHash: snapshot(gate).planHash,
    requestHash: requestHash(gate, request), validUntil: 900, ...patch };
}
const error = (code: string) => (e: unknown) => e instanceof GilError && e.code === code;

test('initial state does not fabricate review provenance or protocol applicability', () => {
  const state = initialize(linked, core.initialState);
  state.phase = 'REVIEWED';
  const f = fixture({ state });
  assert.equal(authorize(f.gate, req(f.gate, 'ctm', 'closeFinding')).code, 'CLOSURE_SEPARATION');
  assert.throws(() => fixture({ reviewerId: 'ctm' }), error('REVIEW_SEPARATION'));
  const wrong = structuredClone(state);
  (wrong.requirement as Record<string, unknown>).protocolVersion = 'PROTOCOL-V2';
  assert.throws(() => fixture({ state: wrong }), error('REQUIREMENT_MISMATCH'));
});

test('A19: no Grant denies; Agent and CRA cannot close or impersonate CTM with flags', () => {
  const { gate } = fixture({ grants: [] });
  assert.equal(execute(gate, req(gate, 'ctm', 'closeFinding')).code, 'NO_GRANT');
  for (const actor of ['agent', 'cra']) {
    assert.equal(authorize(gate, { ...req(gate, actor, 'closeFinding'), flags: { mayClose: true }, role: 'CTM' } as ActionRequest).code, 'ROLE_FORBIDDEN');
  }
  assert.equal(authorize(gate, req(gate, 'fake', 'closeFinding')).code, 'UNKNOWN_ACTOR');
  assert.equal(snapshot(gate).state.phase, 'OPEN');
});

test('A21: shared budget uses conservative minimum across actors/grants and survives revocation', () => {
  const f = fixture({ grants: [grant('agent', { budgetId: 'shared', maxActions: 2 }),
    grant('agent', { id: 'alternative', budgetId: 'shared', maxActions: 99 }), grant('agent2', { budgetId: 'shared', maxActions: 10 })] });
  assert.equal(execute(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 'one' }, {})).ok, true);
  revokeGrant(f.gate, 'g-agent');
  assert.equal(execute(f.gate, req(f.gate, 'agent2', 'dispatchTask', { taskId: 'two' }, {})).ok, true);
  assert.equal(authorize(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 'three' }, {})).code, 'BUDGET_EXHAUSTED');
  assert.equal(snapshot(f.gate).usage.shared, 2);
});

test('budget own-property regression: toString works for dispatch and approval; dangerous IDs reject', () => {
  const f = fixture({ grants: [grant('agent', { budgetId: 'toString', maxActions: 1 })] });
  assert.equal(execute(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 'one' }, {})).ok, true);
  assert.equal(snapshot(f.gate).usage.toString, 1);
  assert.equal(authorize(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 'two' }, {})).code, 'BUDGET_EXHAUSTED');
  const a = fixture({ grants: identities.map(i => grant(i.actorId, i.actorId === 'ctm' ? { budgetId: 'toString' } : {})) });
  reviewed(a.gate); const close = req(a.gate, 'ctm', 'closeFinding'); approve(a.gate, approval(a.gate, close));
  assert.equal(execute(a.gate, close).ok, true); assert.equal(snapshot(a.gate).usage.toString, 2);
  for (const budgetId of ['__proto__', 'constructor', 'prototype']) assert.throws(() => fixture({ grants: [grant('agent', { budgetId })] }), error('INVALID_GRANT'));
  for (const maxActions of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => fixture({ grants: [grant('agent', { maxActions })] }), error('INVALID_GRANT'));
});

test('A20: active deny dominates; expired deny does not; validity is half-open and scope exact', () => {
  const f = fixture({ grants: [grant('agent'), grant('agent', { id: 'deny', effect: 'deny', validUntil: 101 })] });
  assert.equal(authorize(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'EXPLICIT_DENY');
  f.time(101); assert.equal(execute(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).ok, true);
  f.time(1000); assert.equal(authorize(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'NO_GRANT');
  const wrong = fixture({ grants: [grant('agent', { scope: { ...scope, siteId: 'OTHER' } })] });
  assert.equal(authorize(wrong.gate, req(wrong.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'NO_GRANT');
});

test('A23: revocation blocks execution and Control commits exact grantHash', () => {
  const f = fixture(); revokeGrant(f.gate, 'g-agent');
  assert.equal(authorize(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'GRANT_REVOKED');
  assert.equal(snapshot(f.gate).events[0].payload.grantHash, hashValue(f.config.grants.find(g => g.id === 'g-agent')));
  const a = fixture(); reviewed(a.gate); const close = req(a.gate, 'ctm', 'closeFinding');
  approve(a.gate, approval(a.gate, close)); revokeApproval(a.gate, 'approval');
  assert.equal(authorize(a.gate, close).code, 'APPROVAL_REVOKED');
});

test('A22: exact approval required and stale state/input/params cannot reuse it', () => {
  const f = fixture(); reviewed(f.gate); const close = req(f.gate, 'ctm', 'closeFinding');
  assert.equal(authorize(f.gate, close).code, 'APPROVAL_REQUIRED');
  approve(f.gate, approval(f.gate, close));
  assert.equal(authorize(f.gate, { ...close, params: { extra: true } }).code, 'APPROVAL_REQUIRED');
  assert.equal(authorize(f.gate, { ...close, inputs: { ...close.inputs, evaluatedReviewHash: 'OTHER' } }).code, 'APPROVAL_REQUIRED');
  assert.equal(execute(f.gate, close).ok, true);
  assert.equal(execute(f.gate, close).code, 'STALE_VERSION');
});

test('approval selection skips old inactive Grant in favor of a new valid approval', () => {
  const f = fixture({ grants: [...identities.filter(i => i.actorId !== 'ctm').map(i => grant(i.actorId)),
    grant('ctm', { id: 'close', actions: ['closeFinding'] }),
    grant('ctm', { id: 'a-old', actions: ['approveClosure'], validUntil: 200 }),
    grant('ctm', { id: 'z-new', actions: ['approveClosure'], validFrom: 200 })] });
  reviewed(f.gate); const close = req(f.gate, 'ctm', 'closeFinding');
  approve(f.gate, approval(f.gate, close, { id: 'old', validUntil: 200 }));
  f.time(200); approve(f.gate, approval(f.gate, close, { id: 'new', validUntil: 900 }));
  assert.equal(authorize(f.gate, close).outcome, 'Allow');
  assert.equal(execute(f.gate, close).ok, true);
});

test('approval authority requires human CTM and active executable Grant; expired approval blocks', () => {
  const f = fixture(); reviewed(f.gate); const close = req(f.gate, 'ctm', 'closeFinding');
  const a = approval(f.gate, close);
  assert.throws(() => approve(f.gate, { ...a, actorId: 'agent' }), error('HUMAN_APPROVAL_REQUIRED'));
  approve(f.gate, a); f.time(900); assert.equal(authorize(f.gate, close).code, 'APPROVAL_REQUIRED');
  const d = fixture({ grants: [...identities.map(i => grant(i.actorId)), grant('ctm', { id: 'deny', actions: ['approveClosure'], effect: 'deny' })] });
  reviewed(d.gate); assert.throws(() => approve(d.gate, approval(d.gate, req(d.gate, 'ctm', 'closeFinding'))), error('EXPLICIT_DENY'));
});

test('current plan switch invalidates old approval/state while retaining ledger', () => {
  const f = fixture(); reviewed(f.gate); const close = req(f.gate, 'ctm', 'closeFinding');
  const a = approval(f.gate, close); approve(f.gate, a); const before = snapshot(f.gate);
  setCurrentPlan(f.gate, plan('2'));
  assert.equal(authorize(f.gate, close).code, 'STALE_VERSION');
  assert.throws(() => approve(f.gate, { ...a, id: 'stale' }), error('STALE_APPROVAL'));
  assert.equal(authorize(f.gate, req(f.gate, 'ctm', 'closeFinding')).code, 'APPROVAL_REQUIRED');
  assert.deepEqual(snapshot(f.gate).usage, before.usage);
  setCurrentPlan(f.gate, f.config.plan); assert.equal(authorize(f.gate, close).code, 'STALE_VERSION');
});

test('A26: blocked simulation and exceptions never commit state or consume budget; audit chain valid', () => {
  const f = fixture(); const before = snapshot(f.gate);
  assert.equal(execute(f.gate, req(f.gate, 'coord', 'submitEvidence')).code, 'SIMULATION_FAILED');
  assert.equal(execute(f.gate, req(f.gate, 'coord', 'submitEvidence', {}, {})).ok, false);
  assert.equal(execute(f.gate, req(f.gate, 'agent', 'dispatchTask', {}, {})).code, 'INVALID_TASK');
  const after = snapshot(f.gate); assert.equal(after.stateHash, before.stateHash); assert.deepEqual(after.usage, {});
  assert.deepEqual(after.events.map(e => e.type), ['Attempt', 'Failed', 'Attempt', 'Failed', 'Attempt', 'Failed']);
  after.events.forEach((e, i) => { const { id, ...body } = e; assert.equal(id, hashValue(body)); assert.equal(e.parent, i ? after.events[i - 1].id : null); });
});

test('CRA separation and input requirement/scope checks', () => {
  const f = fixture({ submitterId: 'cra' });
  assert.equal(authorize(f.gate, req(f.gate, 'cra', 'recordReviewPass')).code, 'REVIEW_SEPARATION');
  for (const patch of [{ siteId: 'OTHER' }, { requirementHash: 'OTHER' }]) {
    assert.equal(authorize(f.gate, req(f.gate, 'coord', 'submitEvidence', {}, { ...callerInputs, stagedEvidence: { ...core.inputs.stagedEvidence, ...patch } })).code, 'INPUT_SCOPE_MISMATCH');
  }
});

test('Proxy/getter input is rejected without trap execution; copied capabilities rejected', () => {
  const f = fixture(); let calls = 0;
  const proxy = new Proxy({}, { ownKeys() { calls++; throw Error('trap'); }, getPrototypeOf() { calls++; throw Error('trap'); }, get() { calls++; throw Error('trap'); } });
  assert.throws(() => createGate(proxy as GateConfig));
  assert.throws(() => createGate({ ...f.config, state: proxy }));
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { calls++; return true; } });
  assert.equal(authorize(f.gate, { ...req(f.gate, 'agent', 'dispatchTask', {}, {}), params: getter }).outcome, 'Deny');
  assert.equal(execute(f.gate, { ...req(f.gate, 'agent', 'dispatchTask', {}, {}), inputs: proxy }).ok, false);
  assert.throws(() => approve(f.gate, proxy as Approval)); assert.throws(() => setCurrentPlan(f.gate, proxy as GateConfig['plan']));
  assert.throws(() => snapshot(structuredClone(f.gate)), error('UNTRUSTED_GATE'));
  assert.throws(() => setCurrentPlan(f.gate, structuredClone(f.config.plan)), error('UNTRUSTED_PLAN'));
  assert.equal(calls, 0);
});

test('clock regression and expiration at commit prevent state/budget changes', () => {
  const f = fixture(); const before = snapshot(f.gate); f.time(99);
  assert.equal(execute(f.gate, req(f.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'INVALID_CLOCK');
  assert.equal(snapshot(f.gate).stateHash, before.stateHash); assert.deepEqual(snapshot(f.gate).usage, {});
  let calls = 0; const expired = fixture({ now: () => ++calls < 3 ? 100 : 1000 }); const prev = snapshot(expired.gate);
  assert.equal(execute(expired.gate, req(expired.gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'AUTHORIZATION_CHANGED');
  assert.equal(snapshot(expired.gate).stateHash, prev.stateHash); assert.deepEqual(snapshot(expired.gate).usage, {});
});

test('reentrant clock even swallowing the nested exception cannot commit', () => {
  let gate: Gate | undefined;
  const f = fixture({ now: () => { if (gate) { try { revokeGrant(gate, 'g-agent'); } catch {} } return 100; } });
  gate = f.gate; const before = snapshot(gate);
  assert.equal(execute(gate, req(gate, 'agent', 'dispatchTask', { taskId: 't' }, {})).code, 'REENTRANT_GATE');
  assert.equal(snapshot(gate).stateHash, before.stateHash); assert.deepEqual(snapshot(gate).usage, {});
});
