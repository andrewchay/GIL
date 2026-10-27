// Phase5 验收测试：阻断项台账（A18）、期限与逾期（A16）、时间语义（A30）、要求更新链（A13）。
// 全部为合成数据与过程内工件；不涉及真实认证、真实时限或临床执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GilError } from '../src/ast.ts';
import type { Ontology, Spec } from '../src/ast.ts';
import type { ActionRequest, GateConfig, Grant, Identity } from '../src/delegation-ast.ts';
import type { State } from '../src/runtime.ts';
import { parse } from '../src/parser.ts';
import { link } from '../src/checker.ts';
import { initialize } from '../src/runtime.ts';
import { sourceArtifact } from '../src/interpretation.ts';
import { accept, answer, resolvedHash, startSession } from '../src/exchange.ts';
import { bindPlan } from '../src/plans.ts';
import { contentHash } from '../src/canonical.ts';
import { createAssurance, attestationHash, evaluate, issue } from '../src/assurance.ts';
import { createEvidence, createRequirement, evidenceHash, requirementHash } from '../src/evidence.ts';
import { acknowledgeEscalation, createObligation, deadlineStatus } from '../src/deadlines.ts';
import {
  approve, authorize, blockerReport, createGate, deadlineReport, execute, recordEscalation, requestHash,
  setAssurance, setBlockers, setDeadline, snapshot,
} from '../src/delegation.ts';
import { blockerStatus, createBlockerLedger, openBlockers, resolveBlocker } from '../src/blockers.ts';
import { assessQuery, assertAssessable, coverageGaps, createRetrieval, missingEvidenceClaim } from '../src/sources.ts';

const base = new URL('../docs/clinical-operations/monitoring-remediation/', import.meta.url);
const linked = link(parse(readFileSync(new URL('workflow.gil', base), 'utf8')) as Spec,
  [parse(readFileSync(new URL('ontology.gil', base), 'utf8')) as Ontology]);
const core = JSON.parse(readFileSync(new URL('../conformance/clinical-core.json', import.meta.url), 'utf8'));
const scope = { studyId: 'STUDY-DEMO', siteId: 'SITE-DEMO', findingId: 'FINDING-DEMO' };
const human = { actorId: 'human', kind: 'human' as const, mayAnswer: true, mayAccept: true };
const identities: Identity[] = [
  { actorId: 'coord', kind: 'human', role: 'Coordinator' }, { actorId: 'cra', kind: 'human', role: 'CRA' },
  { actorId: 'ctm', kind: 'human', role: 'CTM' }, { actorId: 'service', kind: 'human', role: 'Service' },
];
const actions: Record<string, string[]> = {
  coord: ['submitEvidence'], cra: ['recordReviewPass', 'requestChanges'],
  ctm: ['closeFinding', 'approveClosure', 'reopenFinding', 'updateRequirement'],
  service: ['recordAcceptedPlan', 'invalidateReview'],
};
const NOW = 5000;
const materials = [{ id: 'training-record', contentHash: 'sha256:' + 'a'.repeat(64) }];

function grant(actorId: string): Grant {
  return { id: `g-${actorId}`, version: '1', actorId, scope: { ...scope }, actions: actions[actorId],
    effect: 'allow', autonomy: 'Execute', validFrom: 0, validUntil: NOW + 1000000, budgetId: `b-${actorId}`, maxActions: 20 };
}
function plan(requirementHash = 'REQ-H1') {
  const source = sourceArtifact('request', '1', 'Resolve training finding');
  let session = startSession(source, { id: 'candidate', plan: { findingId: '${findingId}' },
    interpretation: { kind: 'interpretation', name: 'Training', sourceText: source.text, imports: [], items: [
      { kind: 'open', name: 'findingId', type: 'Text' }, { kind: 'open', name: 'applicableProtocolVersion', type: 'Text' }] },
    affects: { findingId: ['closeFinding'], applicableProtocolVersion: ['closeFinding'] } }, human,
    { sources: [source], references: [], types: ['Text'] });
  session = answer(session, 'findingId', scope.findingId, human);
  session = answer(session, 'applicableProtocolVersion', 'PROTOCOL-V3', human);
  session = accept(session, { interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolvedHash(session) }, human);
  return bindPlan(session, linked, scope, requirementHash);
}

/** 台账夹具：默认两条阻断，一条已由 CRA 解除、一条仍开放（由 CTM 解除）。 */
function ledger(open = true) {
  return createBlockerLedger({ findingId: 'FINDING-DEMO', entries: [
    { id: 'B-POLICY', target: 'recordReviewPass', kind: 'policy', owner: 'coord',
      resolutionAuthority: 'cra', state: 'RESOLVED', resolvedBy: 'cra', resolvedAt: 1 },
    open
      ? { id: 'B-DISPUTE', target: 'closeFinding', kind: 'dispute', owner: 'cra', resolutionAuthority: 'ctm', state: 'OPEN' }
      : { id: 'B-DISPUTE', target: 'closeFinding', kind: 'dispute', owner: 'cra', resolutionAuthority: 'ctm',
        state: 'RESOLVED', resolvedBy: 'ctm', resolvedAt: 2 },
  ] });
}
const cleared = () => ledger(false);
function obligation(policy: 'BLOCK-CLOSURE' | 'ESCALATE-ONLY' = 'BLOCK-CLOSURE', dueAt = 10000) {
  return createObligation({ findingId: 'FINDING-DEMO', dueAt, sourceRef: 'POLICY-TIMELINE', sourceVersion: 'V1', policy }, NOW);
}
const evidence: State = { bundleId: 'E-1', contentHash: 'E-H1', requirementHash: 'REQ-H1', ...scope,
  staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3', complete: true, readable: true,
  authenticityEstablished: true, policyChecksPass: true };
const inputs: State = { stagedEvidence: evidence, reviewStillValid: true,
  evaluatedReviewHash: 'REVIEW-H1', businessDate: 20261020 };

function fixture(patch: Partial<GateConfig> = {}) {
  let time = NOW;
  const config: GateConfig = { linked, state: initialize(linked, core.initialState), plan: plan(),
    identities: structuredClone(identities), grants: identities.map(identity => grant(identity.actorId)),
    now: () => time, blockers: cleared(), deadline: obligation(), ...patch };
  return { gate: createGate(config), time: (next: number) => { time = next; } };
}
function req(gate: ReturnType<typeof createGate>, actorId: string, action: string, params: State = {}, requestInputs: State = inputs): ActionRequest {
  const current = snapshot(gate);
  return { actorId, action, params: structuredClone(params), inputs: structuredClone(requestInputs),
    expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
}
const error = (code: string) => (thrown: unknown) => thrown instanceof GilError && thrown.code === code;
function step(gate: ReturnType<typeof createGate>, actorId: string, action: string, params: State = {}, requestInputs: State = inputs) {
  return execute(gate, req(gate, actorId, action, params, requestInputs));
}
function reviewed(gate: ReturnType<typeof createGate>, requestInputs: State = inputs) {
  const accepted = step(gate, 'service', 'recordAcceptedPlan', { planHash: snapshot(gate).planHash }, requestInputs);
  assert.equal(accepted.ok, true, 'recordAcceptedPlan: ' + JSON.stringify(accepted));
  assert.equal(step(gate, 'coord', 'submitEvidence', {}, requestInputs).ok, true);
  const review = step(gate, 'cra', 'recordReviewPass', {}, requestInputs);
  assert.equal(review.ok, true, JSON.stringify(review) + JSON.stringify(snapshot(gate).events.slice(-2)));
  return review;
}
function closeWithApproval(gate: ReturnType<typeof createGate>, requestInputs: State = inputs) {
  const current = snapshot(gate);
  const request: ActionRequest = { actorId: 'ctm', action: 'closeFinding', params: {}, inputs: structuredClone(requestInputs),
    expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  approve(gate, { id: `a-${current.stateHash.slice(7, 15)}`, version: '1', actorId: 'ctm',
    planHash: current.planHash, requestHash: requestHash(gate, request), validUntil: NOW + 100000 });
  return execute(gate, request);
}

// ---------- A18 阻断项模型 ----------

test('A18: blocker status is derived from the ledger, never from caller input', () => {
  const open = ledger(true);
  assert.equal(blockerStatus(open).openCount, 1);
  assert.equal(blockerStatus(open).total, 2);
  assert.deepEqual(openBlockers(open).map(entry => entry.id), ['B-DISPUTE']);
  assert.equal(openBlockers(open)[0].resolutionAuthority, 'ctm');
});

test('A18: an open blocker stops review and closure without touching state', () => {
  const { gate } = fixture({ blockers: ledger(true) });
  assert.equal(step(gate, 'service', 'recordAcceptedPlan', { planHash: snapshot(gate).planHash }).ok, true);
  assert.equal(step(gate, 'coord', 'submitEvidence').ok, true);
  const before = snapshot(gate);
  const review = step(gate, 'cra', 'recordReviewPass');
  assert.equal(review.ok, false);
  assert.equal(review.code, 'BLOCKERS_OPEN');
  assert.equal(snapshot(gate).stateHash, before.stateHash);
  // 诊断必须给出阻断目标与解除权限，而不是一个 Bool。
  const report = blockerReport(gate)!;
  assert.equal(report.openCount, 1);
  assert.deepEqual(report.open.map(entry => [entry.target, entry.resolutionAuthority]), [['closeFinding', 'ctm']]);
});

test('A18: only the declared authority can resolve a blocker; the resolved ledger unblocks', () => {
  const open = ledger(true);
  assert.throws(() => resolveBlocker(open, { id: 'B-DISPUTE', actor: 'cra', at: 3 }), error('RESOLUTION_AUTHORITY_REQUIRED'));
  const resolved = resolveBlocker(open, { id: 'B-DISPUTE', actor: 'ctm', at: 3 });
  assert.equal(resolved.alreadyResolved, false);
  assert.equal(blockerStatus(resolved.ledger).openCount, 0);
  // 旧台账不被原地修改，重复解除幂等。
  assert.equal(blockerStatus(open).openCount, 1);
  assert.equal(resolveBlocker(resolved.ledger, { id: 'B-DISPUTE', actor: 'ctm', at: 4 }).alreadyResolved, true);
});

test('A18: caller-supplied task fields, including blockers, are rejected as trusted-input forgery', () => {
  const { gate } = fixture();
  step(gate, 'service', 'recordAcceptedPlan', { planHash: snapshot(gate).planHash });
  step(gate, 'coord', 'submitEvidence');
  const forged = authorize(gate, req(gate, 'cra', 'recordReviewPass', {}, {
    ...inputs, blockers: { ledgerHash: 'BLK-FAKE', findingId: 'FINDING-DEMO', openCount: 0, total: 0 } }));
  assert.equal(forged.code, 'CALLER_CONTROLLED_TRUSTED_INPUT');
  assert.equal(authorize(gate, req(gate, 'cra', 'recordReviewPass', {}, { ...inputs, actionAt: 999 })).code,
    'CALLER_CONTROLLED_TRUSTED_INPUT');
});

test('A18: a gate without a blocker ledger cannot review or close', () => {
  const { gate } = fixture({ blockers: undefined });
  step(gate, 'service', 'recordAcceptedPlan', { planHash: snapshot(gate).planHash });
  step(gate, 'coord', 'submitEvidence');
  assert.equal(authorize(gate, req(gate, 'cra', 'recordReviewPass')).code, 'BLOCKER_LEDGER_REQUIRED');
  assert.equal(blockerReport(gate), null);
});

test('A18: swapping the ledger invalidates the previous exact approval', () => {
  const { gate } = fixture();
  reviewed(gate);
  const current = snapshot(gate);
  const request: ActionRequest = { actorId: 'ctm', action: 'closeFinding', params: {}, inputs: structuredClone(inputs),
    expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  approve(gate, { id: 'a1', version: '1', actorId: 'ctm', planHash: current.planHash,
    requestHash: requestHash(gate, request), validUntil: NOW + 100000 });
  // 同一事实被重新登记为台账（内容相同→不同 hash 需不同条目，这里追加一条已解除记录）。
  setBlockers(gate, createBlockerLedger({ findingId: 'FINDING-DEMO', entries: [
    { id: 'B-POLICY', target: 'recordReviewPass', kind: 'policy', owner: 'coord',
      resolutionAuthority: 'cra', state: 'RESOLVED', resolvedBy: 'cra', resolvedAt: 1 },
    { id: 'B-DISPUTE', target: 'closeFinding', kind: 'dispute', owner: 'cra',
      resolutionAuthority: 'ctm', state: 'RESOLVED', resolvedBy: 'ctm', resolvedAt: 2 },
    { id: 'B-AUDIT', target: 'recordReviewPass', kind: 'policy', owner: 'coord',
      resolutionAuthority: 'cra', state: 'WAIVED', resolvedBy: 'cra', resolvedAt: 3 } ] }));
  const stale = execute(gate, { ...request, expectedStateHash: snapshot(gate).stateHash, expectedPlanHash: snapshot(gate).planHash });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'APPROVAL_REQUIRED', 'old approval must not survive a ledger swap');
});

// ---------- A16 期限与逾期 ----------

test('A16: an obligation without an explicit source cannot be created', () => {
  assert.throws(() => createObligation({ findingId: 'FINDING-DEMO', dueAt: 9000, sourceRef: '',
    sourceVersion: 'V1', policy: 'BLOCK-CLOSURE' }, NOW), error('INVALID_OBLIGATION'));
  // 回填的期限（已有过去时间）同样拒绝，不允许"事后补一个已到期的期限"。
  assert.throws(() => createObligation({ findingId: 'FINDING-DEMO', dueAt: NOW - 1, sourceRef: 'POLICY-TIMELINE',
    sourceVersion: 'V1', policy: 'BLOCK-CLOSURE' }, NOW), error('INVALID_OBLIGATION'));
});

test('A16: overdue under BLOCK-CLOSURE denies closure, records the escalation and keeps the freeze', () => {
  const f = fixture();
  reviewed(f.gate);
  f.time(20000);
  const before = snapshot(f.gate);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'DEADLINE_EXCEEDED');
  assert.equal(snapshot(f.gate).state.phase, 'REVIEWED');
  const escalations = snapshot(f.gate).events.filter(entry => entry.type === 'Escalation');
  assert.ok(escalations.length >= 1, 'overdue must produce an escalation event');
  const payload = escalations.at(-1)!.payload;
  assert.equal(payload.reason, 'OVERDUE-BLOCKED');
  assert.equal(payload.sourceRef, 'POLICY-TIMELINE');
  assert.equal(payload.policy, 'BLOCK-CLOSURE');
  assert.ok(before.events.length <= snapshot(f.gate).events.length);
});

test('A16: an ACCEPT-LATE disposition is the only way past an overdue BLOCK-CLOSURE', () => {
  const dueAt = 10000;
  const f = fixture({ deadline: obligation('BLOCK-CLOSURE', dueAt) });
  reviewed(f.gate);
  f.time(20000);
  // 早于期限的处置不能签发。
  assert.throws(() => acknowledgeEscalation(obligation('BLOCK-CLOSURE', dueAt), {
    ackId: 'ACK-1', disposition: 'ACCEPT-LATE', authority: 'ctm', at: dueAt }), error('INVALID_ESCALATION'));
  const ack = acknowledgeEscalation(obligation('BLOCK-CLOSURE', dueAt),
    { ackId: 'ACK-1', disposition: 'ACCEPT-LATE', authority: 'ctm', at: 20000 });
  // 只有注册表内的 CTM 能登记处置。
  const ackAsCra = acknowledgeEscalation(obligation('BLOCK-CLOSURE', dueAt),
    { ackId: 'ACK-2', disposition: 'ACCEPT-LATE', authority: 'cra', at: 20000 });
  assert.throws(() => recordEscalation(f.gate, ackAsCra), error('HUMAN_APPROVAL_REQUIRED'));
  recordEscalation(f.gate, ack);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(snapshot(f.gate).state.phase, 'CLOSED');
  const report = deadlineReport(f.gate)!;
  assert.equal(report.overdue, true);
  assert.equal(report.escalation!.disposition, 'ACCEPT-LATE');
});

test('A16: ESCALATE-ONLY overdueness is reported but does not block closure', () => {
  const f = fixture({ deadline: obligation('ESCALATE-ONLY') });
  reviewed(f.gate);
  f.time(20000);
  const status = deadlineStatus(f.gate ? obligation('ESCALATE-ONLY') : obligation(), 20000);
  assert.equal(status.overdue, true);
  assert.equal(status.blocked, false);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(snapshot(f.gate).events.filter(entry => entry.type === 'Escalation').at(-1)!.payload.reason,
    'OVERDUE-ESCALATED');
});

test('A16: a gate without a deadline obligation cannot close', () => {
  const { gate } = fixture({ deadline: undefined });
  reviewed(gate);
  assert.equal(authorize(gate, req(gate, 'ctm', 'closeFinding')).code, 'DEADLINE_REQUIRED');
  assert.equal(deadlineReport(gate), null);
});

test('A16: replacing the obligation requires a new exact approval', () => {
  const f = fixture();
  reviewed(f.gate);
  setDeadline(f.gate, obligation('BLOCK-CLOSURE', 50000));
  const current = snapshot(f.gate);
  const request: ActionRequest = { actorId: 'ctm', action: 'closeFinding', params: {}, inputs: structuredClone(inputs),
    expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  assert.equal(authorize(f.gate, request).code, 'APPROVAL_REQUIRED');
});

// ---------- A30 时间语义 ----------

test('A30: real execution time is injected by the gate and cannot be supplied by the caller', () => {
  const f = fixture();
  reviewed(f.gate);
  assert.equal(authorize(f.gate, req(f.gate, 'ctm', 'closeFinding', {}, { ...inputs, actionAt: 1 })).code,
    'CALLER_CONTROLLED_TRUSTED_INPUT');
  f.time(7777);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const successes = snapshot(f.gate).events.filter(entry => entry.type === 'Succeeded' && entry.payload.businessDate === 20261020);
  const close = successes.at(-1)!;
  assert.equal(close.time, 7777, 'event time is the real synthetic clock, not the business date');
  assert.equal(close.payload.businessDate, 20261020, 'the declared business date must be audited separately');
});

test('A30: backdated business dates are rejected and history is never rewritten', () => {
  const f = fixture();
  reviewed(f.gate);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(deadlineReport(f.gate)!.lastBusinessDate, 20261020);
  f.time(8000);
  const reopened = step(f.gate, 'ctm', 'reopenFinding', {}, { ...inputs, businessDate: 20260101 });
  assert.equal(reopened.ok, false);
  assert.equal(reopened.code, 'BACKDATED_BUSINESS_DATE');
  assert.equal(deadlineReport(f.gate)!.lastBusinessDate, 20261020);
});

// ---------- A13 要求更新链 ----------

const requirement = createRequirement({ ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3', materials });
const evidenceSnapshot = createEvidence(requirement, { ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3',
  materials });
const reqHash = requirementHash(requirement);
const evHash = evidenceHash(evidenceSnapshot);

test('A13: updateRequirement resets the chain and foreign snapshots cannot bind the old evidence', () => {
  const f = fixture();
  reviewed(f.gate);
  const next = createRequirement({ ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V4', materials });
  const nextHash = requirementHash(next);
  const updated = step(f.gate, 'ctm', 'updateRequirement', { nextRequirement: {
    requirementId: 'REQ-DEMO', contentHash: nextHash, ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V4' } });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const state = snapshot(f.gate).state;
  assert.equal(state.phase, 'OPEN');
  assert.equal(state.acceptedPlanHash, '');
  assert.equal(state.activeReviewHash, '');
  assert.equal(state.reviewedEvidenceHash, '');
  assert.equal((state.requirement as Record<string, unknown>).protocolVersion, 'PROTOCOL-V4');
  // 旧证据绑定旧要求，不得继续作为当前证据通过复核。
  const staleEvidence = authorize(f.gate, req(f.gate, 'cra', 'recordReviewPass', {}, { ...inputs,
    stagedEvidence: { ...evidence, requirementHash: reqHash } }));
  assert.equal(staleEvidence.outcome, 'Deny');
  assert.notEqual(nextHash, reqHash);
  // 未按 SPEC 检查 contentHash 时同样拒绝：要求快照不可由调用者构造。
  assert.notEqual(evHash, nextHash);
});

test('A13: an attestation bound to the previous requirement cannot be adopted after the update', () => {
  const specHash = contentHash(linked.spec);
  const registry = createAssurance({ now: () => NOW, verifierId: 'cra', verifierRole: 'CRA', submitterId: 'coord',
    specHash, method: 'HumanReview', methodVersion: 'HUMAN-REVIEW-V1' });
  const attestation = issue(registry, { evidenceHash: evHash, requirementHash: reqHash, contextHash: reqHash,
    coverage: ['scope', 'materials'], assumptions: ['synthetic'], validUntil: NOW + 3600000, result: 'Pass' });
  const hash = attestationHash(attestation);
  const binding = { registry, attestationHash: hash, evidenceHash: evHash, requirementHash: reqHash };
  const state = initialize(linked, { requirement: { requirementId: 'REQ-DEMO', contentHash: reqHash, ...scope,
    staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3' } });
  const f = fixture({ assurance: binding, plan: plan(reqHash), state });
  const evidenceInputs = { ...inputs, stagedEvidence: { ...evidence, requirementHash: reqHash, contentHash: evHash } };
  reviewed(f.gate, evidenceInputs);
  const next = createRequirement({ ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V4', materials });
  const nextHash = requirementHash(next);
  const updated = step(f.gate, 'ctm', 'updateRequirement', { nextRequirement: {
    requirementId: 'REQ-DEMO', contentHash: nextHash, ...scope, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V4' } }, evidenceInputs);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  // 新要求下旧凭证必然失活：上下文（要求）已变，原始结论保留但不再支撑任何动作。
  const evaluation = evaluate(registry, hash, { targetHash: evHash, contextHash: nextHash, specHash, evidenceHash: evHash });
  assert.equal(evaluation.result, 'Unknown');
  assert.equal(evaluation.active, false);
  assert.ok(evaluation.reasons.includes('CONTEXT_MISMATCH'));
  // 且不能被当作新要求下的当前凭证采纳。
  assert.throws(() => setAssurance(f.gate, { ...binding, requirementHash: nextHash }), error('REQUIREMENT_MISMATCH'));
});

// ---------- A07 / A09 来源覆盖与可读性 ----------

const retrieval = (patch: Partial<Parameters<typeof createRetrieval>[0]> = {}) => createRetrieval({
  sourceId: 'EDC-TRAINING', sourceVersion: 'V1', scopeKey: 'SITE-DEMO/STAFF-DEMO',
  queriedAt: NOW, coverage: 'FULL', readable: true, found: false, ...patch });

test('A07: incomplete coverage yields Unknown, never a confirmed absence', () => {
  const partial = assessQuery(retrieval({ coverage: 'PARTIAL' }));
  assert.equal(partial.verdict, 'UNKNOWN');
  assert.equal(partial.reason, 'PARTIAL_COVERAGE');
  assert.equal(partial.mayReportMissing, false);
  assert.equal(missingEvidenceClaim(retrieval({ coverage: 'PARTIAL' })), 'UNKNOWN');
  const unreachable = assessQuery(retrieval({ coverage: 'NONE' }));
  assert.equal(unreachable.reason, 'NO_SOURCE_REACHABLE');
  assert.equal(missingEvidenceClaim(retrieval({ coverage: 'NONE' })), 'UNKNOWN');
});

test('A07: only a full readable query can confirm absence or presence', () => {
  assert.equal(assessQuery(retrieval({ found: false })).verdict, 'CONFIRMED_ABSENT');
  assert.equal(missingEvidenceClaim(retrieval({ found: false })), 'MISSING_EVIDENCE');
  assert.equal(assessQuery(retrieval({ found: true })).verdict, 'CONFIRMED_PRESENT');
  assert.equal(missingEvidenceClaim(retrieval({ found: true })), 'UNKNOWN');
});

test('A09: unreadable material is Unknown regardless of coverage, and gaps stay explicit', () => {
  const unreadable = assessQuery(retrieval({ readable: false, found: false }));
  assert.equal(unreadable.verdict, 'UNKNOWN');
  assert.equal(unreadable.reason, 'MATERIAL_UNREADABLE');
  assert.equal(missingEvidenceClaim(retrieval({ readable: false, found: false })), 'UNKNOWN');
  assert.deepEqual(coverageGaps([retrieval({ coverage: 'FULL', found: true }), retrieval({ readable: false }),
    retrieval({ coverage: 'PARTIAL' })]).map(gap => gap.reason), ['MATERIAL_UNREADABLE', 'PARTIAL_COVERAGE']);
});

test('A09: retrieval records are content-addressed and cannot be rebuilt from JSON', () => {
  const record = retrieval({ found: true });
  assert.match(record.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => assessQuery(structuredClone(record)), error('UNTRUSTED_RETRIEVAL'));
  assert.throws(() => assertAssessable(JSON.parse(JSON.stringify(record))), error('UNASSESSABLE_RETRIEVAL'));
});

// ---------- CLI 冒烟 ----------

test('Phase5 CLI demo reports blockers, overdue escalation and backdating refusal', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-governance'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'synthetic-governance-simulation');
  assert.match(out.warning, /NOT real/);
  assert.equal(out.scenarios.blockedReview.code, 'BLOCKERS_OPEN');
  assert.deepEqual(out.scenarios.blockedReview.report.targets,
    [['recordReviewPass', 'CRA-DEMO'], ['closeFinding', 'CTM-DEMO']]);
  assert.equal(out.scenarios.resolutions.unauthorized, 'RESOLUTION_AUTHORITY_REQUIRED');
  assert.equal(out.scenarios.ledgerSwap.close.code, 'APPROVAL_REQUIRED');
  assert.equal(out.scenarios.overdue.close.code, 'DEADLINE_EXCEEDED');
  assert.equal(out.scenarios.overdue.escalation[0].sourceRef, 'POLICY-TIMELINE-DEMO');
  assert.equal(out.scenarios.overdue.afterDisposition.phase, 'CLOSED');
  assert.equal(out.scenarios.businessDate.backdated.code, 'BACKDATED_BUSINESS_DATE');
});

test('A16: an ACCEPT-LATE receipt never carries over to a different obligation', () => {
  const f = fixture();
  reviewed(f.gate);
  f.time(20000);
  recordEscalation(f.gate, acknowledgeEscalation(obligation('BLOCK-CLOSURE', 10000),
    { ackId: 'ACK-X', disposition: 'ACCEPT-LATE', authority: 'ctm', at: 20000 }));
  assert.equal(deadlineReport(f.gate)!.dispositionAccepted, true);
  // 换成另一份仍逾期的义务：旧回执必须自动失效，不能顺带放行新期限。
  setDeadline(f.gate, obligation('BLOCK-CLOSURE', 15000));
  const report = deadlineReport(f.gate)!;
  assert.equal(report.dispositionAccepted, false);
  assert.equal(report.escalation, null);
  const closed = closeWithApproval(f.gate);
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'DEADLINE_EXCEEDED');
});
