// Phase5 演示：阻断项台账、逾期升级与时间语义。
// 全部为合成数据与过程内工件；不涉及真实认证、监管时限或临床执行。
import { GilError } from './ast.ts';
import { createBlockerLedger, resolveBlocker } from './blockers.ts';
import { acknowledgeEscalation, createObligation } from './deadlines.ts';
import {
  approve, blockerReport, createGate, deadlineReport, execute, recordEscalation, requestHash, setBlockers, snapshot,
} from './delegation.ts';
import { call, grants, identities, loadFixture, stateFor } from './assurance-demo.ts';
import type { ActionRequest, GateConfig } from './delegation-ast.ts';
import type { State } from './runtime.ts';

const NOW = 1793016000000;
const DUE_AT = NOW + 3600000;

function code(thrown: unknown): string { return thrown instanceof GilError ? thrown.code : 'UNEXPECTED_ERROR'; }

/** 批准并执行一次精确关闭请求；批准有效期跟随当前合成时间，避免夹具过期干扰场景。 */
function closeWithApproval(gate: ReturnType<typeof createGate>, inputs: State, time: number) {
  const current = snapshot(gate);
  const request: ActionRequest = { actorId: 'CTM-DEMO', action: 'closeFinding', params: {}, inputs,
    expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  approve(gate, { id: `APPROVAL-${current.stateHash.slice(7, 15)}`, version: '1', actorId: 'CTM-DEMO',
    planHash: current.planHash, requestHash: requestHash(gate, request), validUntil: time + 100000 });
  return execute(gate, request);
}

export function governanceDemo(): unknown {
  const f = loadFixture();
  const status = (gate: ReturnType<typeof createGate>) => snapshot(gate).state.phase;

  // 场景1：政策阻断仍未解除 → 复核被拒，诊断给出目标与解除权限。
  const openLedger = createBlockerLedger({ findingId: 'FINDING-DEMO', entries: [
    { id: 'B-POLICY-1', target: 'recordReviewPass', kind: 'policy', owner: 'COORD-DEMO',
      resolutionAuthority: 'CRA-DEMO', state: 'OPEN' },
    { id: 'B-DISPUTE-1', target: 'closeFinding', kind: 'dispute', owner: 'CRA-DEMO',
      resolutionAuthority: 'CTM-DEMO', state: 'OPEN' } ] });
  const obligation = createObligation({ findingId: 'FINDING-DEMO', dueAt: DUE_AT,
    sourceRef: 'POLICY-TIMELINE-DEMO', sourceVersion: 'V1', policy: 'BLOCK-CLOSURE' }, NOW);
  const g1 = createGate({ linked: f.linked, state: stateFor(f), plan: f.plan, identities,
    grants: grants(), now: () => NOW, blockers: openLedger, deadline: obligation });
  call(g1, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g1, 'COORD-DEMO', 'submitEvidence', f.inputs);
  const blockedReview = call(g1, 'CRA-DEMO', 'recordReviewPass', f.inputs).out;
  const report = blockerReport(g1);

  // 场景2：非权限主体解除被拒；有权主体解除后放行。
  const deniedResolution = (() => {
    try { resolveBlocker(openLedger, { id: 'B-DISPUTE-1', actor: 'CRA-DEMO', at: NOW }); return 'ALLOWED'; }
    catch (error) { return code(error); }
  })();
  const resolved = resolveBlocker(openLedger, { id: 'B-DISPUTE-1', actor: 'CTM-DEMO', at: NOW });
  setBlockers(g1, resolved.ledger);
  const afterFirstResolve = call(g1, 'CRA-DEMO', 'recordReviewPass', f.inputs).out;
  const fullyCleared = resolveBlocker(resolved.ledger, { id: 'B-POLICY-1', actor: 'CRA-DEMO', at: NOW });
  setBlockers(g1, fullyCleared.ledger);
  const reviewAfterClearing = call(g1, 'CRA-DEMO', 'recordReviewPass', f.inputs).out;

  // 场景3：换台账后旧精确批准失效。
  let time = NOW;
  const g3 = createGate({ linked: f.linked, state: stateFor(f), plan: f.plan, identities,
    grants: grants(), now: () => time, blockers: fullyCleared.ledger, deadline: obligation });
  call(g3, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g3, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g3, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  const beforeSwap = snapshot(g3);
  const closeRequest: ActionRequest = { actorId: 'CTM-DEMO', action: 'closeFinding', params: {},
    inputs: f.inputs, expectedStateHash: beforeSwap.stateHash, expectedPlanHash: beforeSwap.planHash };
  approve(g3, { id: 'APPROVAL-SWAP', version: '1', actorId: 'CTM-DEMO', planHash: beforeSwap.planHash,
    requestHash: requestHash(g3, closeRequest), validUntil: time + 100000 });
  setBlockers(g3, createBlockerLedger({ findingId: 'FINDING-DEMO', entries: [
    { id: 'B-POLICY-1', target: 'recordReviewPass', kind: 'policy', owner: 'COORD-DEMO',
      resolutionAuthority: 'CRA-DEMO', state: 'RESOLVED', resolvedBy: 'CRA-DEMO', resolvedAt: NOW },
    { id: 'B-DISPUTE-1', target: 'closeFinding', kind: 'dispute', owner: 'CRA-DEMO',
      resolutionAuthority: 'CTM-DEMO', state: 'RESOLVED', resolvedBy: 'CTM-DEMO', resolvedAt: NOW },
    { id: 'B-AUDIT-1', target: 'closeFinding', kind: 'escalation', owner: 'CTM-DEMO',
      resolutionAuthority: 'CTM-DEMO', state: 'WAIVED', resolvedBy: 'CTM-DEMO', resolvedAt: NOW } ] }));
  const staleApproval = (() => {
    const fresh = snapshot(g3);
    return execute(g3, { ...closeRequest, expectedStateHash: fresh.stateHash, expectedPlanHash: fresh.planHash });
  })();

  // 场景4：逾期 → 升级事件 + 阻断关闭；CTM ACCEPT-LATE 后合法关闭。
  time = NOW;
  const g4 = createGate({ linked: f.linked, state: stateFor(f), plan: f.plan, identities,
    grants: grants(), now: () => time, blockers: fullyCleared.ledger, deadline: obligation });
  call(g4, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g4, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g4, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  time = DUE_AT + 1000;
  const overdueClose = closeWithApproval(g4, f.inputs, time);
  const escalationEvents = snapshot(g4).events.filter(entry => entry.type === 'Escalation');
  recordEscalation(g4, acknowledgeEscalation(obligation, { ackId: 'ACK-1',
    disposition: 'ACCEPT-LATE', authority: 'CTM-DEMO', at: time }));
  const closedAfterDisposition = closeWithApproval(g4, f.inputs, time);
  const deadlineView = deadlineReport(g4);
  const closedPhase = status(g4);

  // 场景5：关闭后重开，再提交更早的业务日期 → 拒绝回填。
  const reopen = (() => {
    const state = snapshot(g4);
    return execute(g4, { actorId: 'CTM-DEMO', action: 'reopenFinding', params: {}, inputs: {},
      expectedStateHash: state.stateHash, expectedPlanHash: state.planHash });
  })();
  const backdated = (() => {
    const state = snapshot(g4);
    return execute(g4, { actorId: 'CTM-DEMO', action: 'reopenFinding', params: {},
      inputs: { ...f.inputs, businessDate: 20260101 }, expectedStateHash: state.stateHash, expectedPlanHash: state.planHash });
  })();

  const ok = blockedReview.ok === false && blockedReview.code === 'BLOCKERS_OPEN'
    && report !== null && report.openCount === 2 && deniedResolution === 'RESOLUTION_AUTHORITY_REQUIRED'
    && afterFirstResolve.ok === false && reviewAfterClearing.ok === true
    && staleApproval.ok === false && staleApproval.code === 'APPROVAL_REQUIRED'
    && overdueClose.ok === false && overdueClose.code === 'DEADLINE_EXCEEDED' && escalationEvents.length >= 1
    && closedAfterDisposition.ok === true && closedPhase === 'CLOSED'
    && reopen.ok === true && backdated.ok === false && backdated.code === 'BACKDATED_BUSINESS_DATE'
    && deadlineView !== null && deadlineView.lastBusinessDate === 20261020;

  return {
    ok,
    mode: 'synthetic-governance-simulation',
    warning: 'NOT real authentication, regulatory deadline, evidence verification or clinical execution',
    scenarios: {
      blockedReview: { ok: blockedReview.ok, code: blockedReview.code, phase: status(g1),
        report: report && { openCount: report.openCount, targets: report.open.map(entry => [entry.target, entry.resolutionAuthority]) } },
      resolutions: { unauthorized: deniedResolution,
        afterFirstResolve: { ok: afterFirstResolve.ok, code: afterFirstResolve.code },
        afterClearing: { ok: reviewAfterClearing.ok, code: reviewAfterClearing.code } },
      ledgerSwap: { close: { ok: staleApproval.ok, code: staleApproval.code },
        note: 'the previous exact approval no longer matches the new ledger hash' },
      overdue: { close: { ok: overdueClose.ok, code: overdueClose.code },
        escalation: escalationEvents.map(entry => entry.payload),
        afterDisposition: { ok: closedAfterDisposition.ok, code: closedAfterDisposition.code, phase: closedPhase },
        deadline: deadlineView },
      businessDate: { reopen: { ok: reopen.ok, code: reopen.code }, backdated: { ok: backdated.ok, code: backdated.code } },
    },
  };
}
