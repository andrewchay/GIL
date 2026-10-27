import { readFileSync } from 'node:fs';
import { parse, parseInterpretation } from './parser.ts';
import { check, link } from './checker.ts';
import { contentHash } from './canonical.ts';
import { initialize } from './runtime.ts';
import { sourceArtifact } from './interpretation.ts';
import { accept, answer, resolvedHash, startSession } from './exchange.ts';
import { bindPlan } from './plans.ts';
import { createAssurance, attestationHash, challenge, evaluate, issue, revoke } from './assurance.ts';
import { createEvidence, createRequirement, evidenceHash, evidenceReady, requirementHash } from './evidence.ts';
import { approve, createGate, execute, requestHash, setAssurance, snapshot } from './delegation.ts';
import { GilError } from './ast.ts';
import type { ActionRequest, GateConfig, Grant, Identity } from './delegation-ast.ts';
import type { State } from './runtime.ts';

const BASE = 'docs/clinical-operations/monitoring-remediation/';
const SCOPE = { studyId: 'STUDY-DEMO', siteId: 'SITE-DEMO', findingId: 'FINDING-DEMO' };
const NOW = 1793016000000;
const JSON_MATERIALS = [{ id: 'training-record', contentHash: 'sha256:' + 'a'.repeat(64) },
  { id: 'protocol-ack', contentHash: 'sha256:' + 'b'.repeat(64) }];

interface Fixture { linked: GateConfig['linked']; plan: ReturnType<typeof bindPlan>; requirement: ReturnType<typeof createRequirement>;
  evidence: ReturnType<typeof createEvidence>; reqHash: string; evHash: string; inputs: State; specHash: string }

function loadFixture(): Fixture {
  const spec = parse(readFileSync(BASE + 'workflow.gil', 'utf8'));
  const ontology = parse(readFileSync(BASE + 'ontology.gil', 'utf8'));
  if (spec.kind !== 'spec' || ontology.kind !== 'ontology') throw new GilError('DEMO_ERROR', 'Invalid clinical documents');
  const linked = link(spec, [ontology]);
  if (check(linked).length) throw new GilError('DEMO_ERROR', 'Clinical spec must pass static checks');
  const intent = JSON.parse(readFileSync('conformance/clinical-interpretation.json', 'utf8'));
  const core = JSON.parse(readFileSync('conformance/clinical-core.json', 'utf8'));
  const requirement = createRequirement({ ...SCOPE, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3', materials: JSON_MATERIALS });
  const evidence = createEvidence(requirement, { ...SCOPE, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3',
    materials: JSON_MATERIALS, submitterClaims: { authenticityEstablished: true, complete: true } });
  const reqHash = requirementHash(requirement), evHash = evidenceHash(evidence);
  const source = sourceArtifact(intent.source.id, intent.source.version, intent.source.text);
  const interpretation = parseInterpretation(readFileSync(BASE + 'interpretation.gil', 'utf8'));
  const template = { ...intent.plan, operation: '${intendedOperation}', workflow: 'training-remediation', execution: 'requires-separate-grants' };
  let session = startSession(source, { id: intent.candidateId, interpretation, plan: template, affects: intent.affects },
    { actorId: 'AGENT-DEMO', kind: 'agent', mayAnswer: false, mayAccept: false },
    { sources: [source], references: intent.references, types: intent.types });
  const human = { actorId: 'CTM-DEMO', kind: 'human' as const, mayAnswer: true, mayAccept: true };
  for (const question of session.questions) {
    session = answer(session, question.id, question.target === 'intendedOperation' ? 'Clinical.RequestClosure' : intent.answers[question.target], human);
  }
  session = accept(session, { interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolvedHash(session) }, human);
  const plan = bindPlan(session, linked, SCOPE, reqHash);
  const initialState: State = { requirement: { requirementId: 'REQ-DEMO', contentHash: reqHash, ...SCOPE,
    staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3' } };
  const inputs: State = { stagedEvidence: { bundleId: `E-${evHash.slice(7, 15)}`, contentHash: evHash, requirementHash: reqHash,
    ...SCOPE, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3', complete: true, readable: true,
    authenticityEstablished: true, policyChecksPass: true }, blockingItemsResolved: true, reviewStillValid: true,
    evaluatedReviewHash: 'REVIEW-H1' };
  void core; void initialState;
  return { linked, plan, requirement, evidence, reqHash, evHash, inputs, specHash: contentHash(linked.spec) };
}
const identities: Identity[] = [
  { actorId: 'COORD-DEMO', kind: 'human', role: 'Coordinator' },
  { actorId: 'CRA-DEMO', kind: 'human', role: 'CRA' },
  { actorId: 'CRA2-DEMO', kind: 'human', role: 'CRA' },
  { actorId: 'CTM-DEMO', kind: 'human', role: 'CTM' },
  { actorId: 'SERVICE-DEMO', kind: 'human', role: 'Service' },
];
function grants(): Grant[] {
  const template = [['G-SERVICE', 'SERVICE-DEMO', ['recordAcceptedPlan', 'invalidateReview']],
    ['G-COORD', 'COORD-DEMO', ['submitEvidence']], ['G-CRA', 'CRA-DEMO', ['recordReviewPass', 'requestChanges']],
    ['G-CRA2', 'CRA2-DEMO', ['recordReviewPass', 'requestChanges']],
    ['G-CTM', 'CTM-DEMO', ['closeFinding', 'approveClosure', 'reopenFinding', 'updateRequirement']]] as const;
  return template.map(([id, actorId, actions]) => ({ id, actorId, actions: [...actions] as string[], version: '1', scope: SCOPE,
    effect: 'allow' as const, autonomy: 'Execute' as const, validFrom: NOW - 1000, validUntil: NOW + 86400000, budgetId: id, maxActions: 20 }));
}
function stateFor(f: Fixture): State {
  const merged: State = { requirement: { requirementId: 'REQ-DEMO', contentHash: f.reqHash, ...SCOPE,
    staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3' } };
  return initialize(f.linked, merged);
}
function gateFor(f: Fixture, state: State, assurance?: GateConfig['assurance']) {
  return createGate({ linked: f.linked, state, plan: f.plan, identities, grants: grants(), now: () => NOW, assurance });
}
function call(gate: ReturnType<typeof createGate>, actorId: string, action: string, inputs: State, params: State = {}) {
  const current = snapshot(gate);
  const req: ActionRequest = { actorId, action, params, inputs, expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  return { req, out: execute(gate, req) };
}
function approveClose(gate: ReturnType<typeof createGate>, inputs: State) {
  const current = snapshot(gate);
  const req: ActionRequest = { actorId: 'CTM-DEMO', action: 'closeFinding', params: {}, inputs, expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
  approve(gate, { id: 'APPROVAL-DEMO', version: '1', actorId: 'CTM-DEMO', planHash: current.planHash,
    requestHash: requestHash(gate, req), validUntil: NOW + 10000 });
  return execute(gate, req);
}

/** Phase4 演示：凭证门、失效、挑战与重开；全部为合成数据。 */
export function assuranceDemo(): unknown {
  const f = loadFixture();
  // 每个场景使用独立注册表与凭证，避免撤销/挑战互相污染。
  const makeAssurance = () => {
    const registry = createAssurance({ now: () => NOW, verifierId: 'CRA-DEMO', verifierRole: 'CRA',
      submitterId: 'COORD-DEMO', specHash: f.specHash, method: 'HumanReview', methodVersion: 'HUMAN-REVIEW-V1' });
    const attestation = issue(registry, { evidenceHash: f.evHash, requirementHash: f.reqHash, contextHash: f.reqHash,
      coverage: ['scope', 'protocol-version', 'materials', 'readability', 'authenticity-source'],
      assumptions: ['synthetic fixture'], validUntil: NOW + 3600000, result: 'Pass' });
    return { registry, attestation, binding: { registry, attestationHash: attestationHash(attestation),
      evidenceHash: f.evHash, requirementHash: f.reqHash } };
  };
  const readiness = evidenceReady(f.requirement, f.evidence);
  const current = (hash: string) => ({ targetHash: hash, contextHash: f.reqHash, specHash: f.specHash, evidenceHash: hash });

  // 场景1：完整合法路径，凭证有效。
  const a1 = makeAssurance();
  const g1 = gateFor(f, stateFor(f), a1.binding);
  const path = [call(g1, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash }),
    call(g1, 'COORD-DEMO', 'submitEvidence', f.inputs),
    call(g1, 'CRA-DEMO', 'recordReviewPass', f.inputs)];
  const closeOut = approveClose(g1, f.inputs);
  const baseline = { path: path.map(item => ({ ok: item.out.ok, code: item.out.code })), close: { ok: closeOut.ok, code: closeOut.code },
    phase: snapshot(g1).state.phase };

  // 场景2：未配置凭证的 legacy 门仍是 Core 投影（只保留回归兼容，不是 Phase4 合规路径）。
  const g2 = gateFor(f, stateFor(f));
  const legacy = (() => {
    call(g2, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
    call(g2, 'COORD-DEMO', 'submitEvidence', f.inputs);
    return call(g2, 'CRA-DEMO', 'recordReviewPass', f.inputs).out;
  })();
  // 场景2b：配置了凭证，但绑定证据摘要与当前提交不一致。
  const a2 = makeAssurance();
  const g3 = gateFor(f, stateFor(f), { ...a2.binding, evidenceHash: 'sha256:' + 'c'.repeat(64) });
  call(g3, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g3, 'COORD-DEMO', 'submitEvidence', f.inputs);
  const mismatchedEvidence = call(g3, 'CRA-DEMO', 'recordReviewPass', f.inputs).out;
  // 调用者自报 reviewStillValid=false 也不能否决有效凭证（凭证是唯一依据）。
  const a2b = makeAssurance();
  const g3b = gateFor(f, stateFor(f), a2b.binding);
  call(g3b, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g3b, 'COORD-DEMO', 'submitEvidence', f.inputs);
  const overrodeSelfReport = call(g3b, 'CRA-DEMO', 'recordReviewPass', { ...f.inputs, reviewStillValid: false }).out;

  // 场景3：CRA 不得自审（签发者=提交者被拒）。
  let selfReviewCode = 'ALLOWED';
  try {
    createAssurance({ now: () => NOW, verifierId: 'COORD-DEMO', verifierRole: 'CRA', submitterId: 'COORD-DEMO',
      specHash: f.specHash, method: 'HumanReview', methodVersion: 'HUMAN-REVIEW-V1' });
  } catch (error) { selfReviewCode = error instanceof GilError ? error.code : 'ERROR'; }

  // 场景4：凭证在关闭前被撤销 → 关闭被拒，原始结论仍可查。
  const a4 = makeAssurance();
  const g4 = gateFor(f, stateFor(f), a4.binding);
  call(g4, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g4, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g4, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  revoke(a4.registry, a4.attestation.id, 'CRA-DEMO');
  const revokedClose = approveClose(g4, f.inputs);
  const revokedEval = evaluate(a4.registry, a4.binding.attestationHash, current(f.evHash));

  // 场景5：CLOSED 后挑战 → 凭证失活；CTM 重开保留历史。
  const a5 = makeAssurance();
  const g5 = gateFor(f, stateFor(f), a5.binding);
  call(g5, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g5, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g5, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  const closed = approveClose(g5, f.inputs).ok;
  const successBefore = snapshot(g5).events.filter(event => event.type === 'Succeeded').length;
  const receipt = challenge(a5.registry, { kind: 'challenge', id: 'CH-1', version: '0.1',
    targetAttestationId: a5.attestation.id, targetHash: a5.attestation.targetHash,
    reason: 'synthetic late finding', raisedBy: 'CRA2-DEMO', at: NOW + 1000 });
  const afterChallenge = evaluate(a5.registry, a5.binding.attestationHash, current(f.evHash));
  const reopen = (() => {
    const state = snapshot(g5);
    const req: ActionRequest = { actorId: 'CTM-DEMO', action: 'reopenFinding', params: {}, inputs: {},
      expectedStateHash: state.stateHash, expectedPlanHash: state.planHash };
    return execute(g5, req);
  })();
  const successAfter = snapshot(g5).events.filter(event => event.type === 'Succeeded').length;

  // 场景6：换新证据（缺一项材料）后旧凭证与旧批准不能复用。
  const fresh = createEvidence(f.requirement, { ...SCOPE, staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3',
    materials: [JSON_MATERIALS[0]] }, { allowMissingMaterials: true });
  const freshHash = evidenceHash(fresh);
  const freshReadiness = evidenceReady(f.requirement, fresh);
  const a6 = makeAssurance();
  const g6 = gateFor(f, stateFor(f), a6.binding);
  call(g6, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g6, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g6, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  const swapped = call(g6, 'COORD-DEMO', 'submitEvidence', { ...f.inputs,
    stagedEvidence: { ...(f.inputs.stagedEvidence as Record<string, unknown>), contentHash: freshHash } }).out;
  const closeAfterSwap = (() => {
    const state = snapshot(g6);
    const req: ActionRequest = { actorId: 'CTM-DEMO', action: 'closeFinding', params: {}, inputs: f.inputs,
      expectedStateHash: state.stateHash, expectedPlanHash: state.planHash };
    return execute(g6, req);
  })();
  const adoptionCode = (() => { try { setAssurance(g6, { ...a6.binding, evidenceHash: freshHash }); return 'ADOPTED'; }
    catch (error) { return error instanceof GilError ? error.code : 'ERROR'; } })();

  // 场景7：同一证据下重新签发的新凭证可合法轮换，且需要新的精确批准。
  const a7 = makeAssurance();
  const g7 = gateFor(f, stateFor(f), a7.binding);
  call(g7, 'SERVICE-DEMO', 'recordAcceptedPlan', {}, { planHash: f.plan.hash });
  call(g7, 'COORD-DEMO', 'submitEvidence', f.inputs);
  call(g7, 'CRA-DEMO', 'recordReviewPass', f.inputs);
  const refreshed = issue(a7.registry, { evidenceHash: f.evHash, requirementHash: f.reqHash, contextHash: f.reqHash,
    coverage: ['scope', 'protocol-version', 'materials', 'readability', 'authenticity-source'],
    assumptions: ['synthetic re-review'], validUntil: NOW + 7200000, result: 'Pass' });
  const rotated = (() => { try { setAssurance(g7, { ...a7.binding, attestationHash: attestationHash(refreshed) }); return 'ADOPTED'; }
    catch (error) { return error instanceof GilError ? error.code : 'ERROR'; } })();
  const closeAfterRotate = approveClose(g7, f.inputs);

  return {
    ok: baseline.close.ok && mismatchedEvidence.ok === false && overrodeSelfReport.ok === true
      && selfReviewCode === 'PERSON_SEPARATION' && revokedClose.ok === false && closed
      && afterChallenge.active === false && reopen.ok === true && successAfter === successBefore + 1
      && swapped.ok === true && closeAfterSwap.ok === false && adoptionCode !== 'ADOPTED'
      && rotated === 'ADOPTED' && closeAfterRotate.ok === true,
    mode: 'synthetic-assurance-simulation',
    assurance: 'process-local-unsigned-attestations',
    warning: 'NOT real authentication, signed evidence, regulatory certification or clinical execution',
    readiness,
    attestation: { hash: makeAssurance().binding.attestationHash, result: 'Pass',
      coverage: ['scope', 'protocol-version', 'materials', 'readability', 'authenticity-source'] },
    scenarios: {
      baseline,
      legacyWithoutAssurance: { review: { ok: legacy.ok, code: legacy.code },
        note: 'LEGACY: gate without assurance only checks Core projection; not a Phase4 compliant path' },
      assuranceConfigured: {
        evidenceMismatch: { ok: mismatchedEvidence.ok, code: mismatchedEvidence.code },
        selfReportFalseIgnored: { ok: overrodeSelfReport.ok, code: overrodeSelfReport.code },
      },
      selfReview: { code: selfReviewCode },
      revoked: { close: { ok: revokedClose.ok, code: revokedClose.code }, evaluation: revokedEval },
      challenge: { receipt, evaluation: afterChallenge, closed,
        reopen: { ok: reopen.ok, phase: snapshot(g5).state.phase },
        historyPreserved: successAfter === successBefore + 1 && snapshot(g5).events.some(event => event.type === 'Succeeded') },
      evidenceSwap: { submit: { ok: swapped.ok, code: swapped.code },
        close: { ok: closeAfterSwap.ok, code: closeAfterSwap.code }, staleBindingAttempt: adoptionCode, freshReadiness },
      rotation: { setAssurance: rotated, close: { ok: closeAfterRotate.ok, code: closeAfterRotate.code } },
    },
    events: snapshot(g5).events.length,
  };
}
