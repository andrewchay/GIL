import { types } from 'node:util';
import { GilError } from './ast.ts';
import { check } from './checker.ts';
import { contentHash } from './canonical.ts';
import { hashValue } from './interpretation.ts';
import { simulate } from './runtime.ts';
import { validatePlan } from './plans.ts';
import { evaluate, inspect } from './assurance.ts';
import type { State } from './runtime.ts';
import type { Approval, ActionRequest, AssuranceBinding, AuditEvent, BoundPlan, Decision, GateConfig, GateSnapshot, Grant, Identity, Scope } from './delegation-ast.ts';

export type { Approval, ActionRequest, AssuranceBinding, BoundPlan, Decision, GateConfig, GateSnapshot, Grant, Identity, Scope } from './delegation-ast.ts';
/** Process-local synthetic authority. JSON cannot recreate this capability. */
export interface Gate { readonly kind: 'delegation-gate' }
interface RememberedRequest { request: ActionRequest; version: number }
interface StoredApproval { approval: Approval; grantId: string; version: number }
interface Internal {
  linked: GateConfig['linked']; state: State; plan: BoundPlan; identities: Identity[]; grants: Grant[];
  now: () => number; submitterId: string; reviewerId: string; version: number; taskCount: number;
  usage: Record<string, number>; revokedGrants: string[]; revokedApprovals: string[];
  approvals: StoredApproval[]; requests: Record<string, RememberedRequest>; events: AuditEvent[];
  assurance: AssuranceBinding | null;
}
interface Cell { value: Internal; busy: boolean; lastTime: number; reentered: boolean }
const gates = new WeakMap<Gate, Cell>();
const roles: Record<string, readonly string[]> = {
  Coordinator: ['submitEvidence'], CRA: ['recordReviewPass', 'requestChanges'],
  CTM: ['closeFinding', 'reopenFinding', 'updateRequirement', 'approveClosure'],
  Agent: ['dispatchTask'], Service: ['recordAcceptedPlan', 'invalidateReview'],
};
const fail = (code: string, message: string): never => { throw new GilError(code, message); };
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const used = (usage: Record<string, number>, id: string): number => Object.hasOwn(usage, id) ? usage[id] : 0;
function copy<T>(v: T): T { hashValue(v); return structuredClone(v); }
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
function safeScope(v: unknown): v is Scope {
  return record(v) && text(v.studyId) && text(v.siteId) && text(v.findingId)
    && Object.keys(v).length === 3;
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.studyId === b.studyId && a.siteId === b.siteId && a.findingId === b.findingId;
}
function scopeRecord(v: unknown, scope: Scope): boolean {
  return record(v) && v.studyId === scope.studyId && v.siteId === scope.siteId && v.findingId === scope.findingId;
}
function cellFor(gate: Gate): Cell {
  // WeakMap lookup does not invoke traps on fabricated objects.
  const cell = gates.get(gate);
  if (!cell) fail('UNTRUSTED_GATE', 'Use createGate; serialized gates convey no authority');
  if (cell.busy) { cell.reentered = true; fail('REENTRANT_GATE', 'Reentrant gate operations are not trusted'); }
  return cell;
}
function locked<T>(gate: Gate, fn: (cell: Cell) => T): T {
  const cell = cellFor(gate); cell.busy = true; cell.reentered = false;
  try { return fn(cell); } finally { cell.busy = false; }
}
function clock(cell: Cell): number {
  const time = cell.value.now();
  if (cell.reentered) fail('REENTRANT_GATE', 'Clock attempted a reentrant operation');
  if (!finite(time) || time < cell.lastTime) fail('INVALID_CLOCK', 'Clock must return finite monotonic times');
  cell.lastTime = time; return time;
}
function commit(cell: Cell, changes: Partial<Internal>): void {
  cell.value = Object.freeze({ ...cell.value, ...changes });
}
function stateDigest(s: Internal): string {
  return hashValue({ state: s.state, version: s.version, taskCount: s.taskCount });
}
function digest(s: Internal, req: ActionRequest): string {
  return hashValue({ request: req, stateHash: stateDigest(s), planHash: s.plan.hash,
    specHash: s.plan.specHash, ontologyHashes: s.plan.ontologyHashes, version: s.version,
    // 凭证内容进入请求摘要：更换凭证或证据摘要后旧批准不再适用。
    assurance: s.assurance ? { attestationHash: s.assurance.attestationHash,
      evidenceHash: s.assurance.evidenceHash, requirementHash: s.assurance.requirementHash } : null });
}
/**
 * 凭证门：只有受信注册表签发的凭证、对当前证据/要求/规约有效且为 Pass 才通过。
 * 调用者自报的 reviewStillValid 不参与判定；Core 的该输入由本结果覆盖。
 */
function attestationCheck(s: Internal): { ok: boolean; code: string; reasons: string[] } {
  if (!s.assurance) return { ok: false, code: 'ASSURANCE_NOT_CONFIGURED', reasons: [] };
  if (s.assurance.requirementHash !== s.plan.requirementHash) return { ok: false, code: 'ATTESTATION_REQUIREMENT_MISMATCH', reasons: [] };
  const currentEvidence = typeof s.state.currentEvidenceHash === 'string' ? s.state.currentEvidenceHash : '';
  try {
    const evaluation = evaluate(s.assurance.registry, s.assurance.attestationHash, {
      targetHash: currentEvidence, contextHash: s.plan.requirementHash,
      specHash: s.plan.specHash, evidenceHash: s.assurance.evidenceHash });
    if (evaluation.result !== 'Pass' || !evaluation.active) return { ok: false, code: 'ATTESTATION_INVALID', reasons: evaluation.reasons };
    return { ok: true, code: 'ATTESTATION_VALID', reasons: [] };
  } catch (error) {
    return { ok: false, code: error instanceof GilError ? error.code : 'ATTESTATION_INVALID', reasons: [] };
  }
}
const ASSURED_ACTIONS: readonly string[] = ['recordReviewPass', 'closeFinding'];
function event(cell: Cell, type: AuditEvent['type'], actorId: string, time: number, payload: Record<string, unknown>): void {
  const events = cell.value.events;
  const body = { parent: events.length ? events[events.length - 1].id : null, type, actorId, time, payload };
  commit(cell, { events: freeze([...events, { id: hashValue(body), ...body }]) });
}
function validRequest(v: unknown): ActionRequest {
  const clean = copy(v);
  if (!record(clean) || !text(clean.actorId) || !text(clean.action) || !record(clean.params)
      || !record(clean.inputs) || !text(clean.expectedStateHash) || !text(clean.expectedPlanHash)) {
    fail('INVALID_REQUEST', 'Request requires actor, action, params, inputs and exact current hashes');
  }
  return clean as unknown as ActionRequest;
}
function planCheck(plan: BoundPlan, linked: GateConfig['linked']): void {
  // plans.validatePlan owns the content-addressed accepted-plan boundary.
  validatePlan(plan, linked);
  if (!safeScope(plan.scope) || plan.specHash !== contentHash(linked.spec)
    || hashValue(plan.ontologyHashes) !== hashValue(Object.values(linked.ontologies).map(contentHash).sort())) {
    fail('PLAN_LINK_MISMATCH', 'Plan must bind the exact spec and all linked ontologies');
  }
}
/** now is the only non-JSON adapter member and is never included in a digest. */
export function createGate(config: GateConfig): Gate {
  if (!record(config) || types.isProxy(config)) fail('INVALID_CONFIG', 'Plain gate configuration required');
  const proto = Object.getPrototypeOf(config);
  if (proto !== Object.prototype && proto !== null) fail('INVALID_CONFIG', 'Plain gate configuration required');
  if (Object.getOwnPropertySymbols(config).length) fail('INVALID_CONFIG', 'Symbols are not configuration');
  const descriptors = Object.getOwnPropertyDescriptors(config);
  const data: Record<string, unknown> = Object.create(null);
  let now: (() => number) | undefined;
  for (const [key, d] of Object.entries(descriptors)) {
    if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('INVALID_CONFIG', 'Accessors are not configuration');
    if (key === 'now') { if (typeof d.value !== 'function' || types.isProxy(d.value)) fail('INVALID_CLOCK', 'Plain clock function required'); now = d.value; }
    else { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_CONFIG', 'Unsafe configuration key'); data[key] = d.value; }
  }
  if (!now) fail('INVALID_CLOCK', 'Provide a trusted synthetic clock adapter');
  // The plan is an issued capability. Validate original provenance, not its JSON copy.
  // 能力对象（凭证注册表）不参与内容寻址，也不复制：JSON 摘要无法承载签发权威。
  const hashable: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(data)) if (key !== 'assurance') hashable[key] = value;
  hashValue(hashable);
  const originalPlan = data.plan as BoundPlan;
  validatePlan(originalPlan, data.linked as GateConfig['linked']);
  const clean = copy(hashable) as unknown as Omit<GateConfig, 'now'>;
  clean.plan = originalPlan;
  // 凭证注册表是过程内能力，structuredClone 会失去身份，必须保留原始引用。
  let assurance: AssuranceBinding | null = null;
  if (data.assurance !== undefined) {
    const raw = data.assurance as AssuranceBinding;
    if (!record(raw) || !text(raw.attestationHash) || !text(raw.evidenceHash) || !text(raw.requirementHash)) fail('INVALID_ASSURANCE', 'Assurance binding requires registry, attestation, evidence and requirement');
    try { inspect(raw.registry, raw.attestationHash); }
    catch (error) { fail('INVALID_ASSURANCE', error instanceof GilError ? error.message : 'Assurance must be issued in this process'); }
    if (raw.requirementHash !== clean.plan.requirementHash) fail('INVALID_ASSURANCE', 'Assurance must bind the plan requirement');
    assurance = Object.freeze({ registry: raw.registry, attestationHash: raw.attestationHash,
      evidenceHash: raw.evidenceHash, requirementHash: raw.requirementHash });
  }
  if (!record(clean.linked) || !record(clean.state) || !Array.isArray(clean.identities) || !Array.isArray(clean.grants)) fail('INVALID_CONFIG', 'Missing gate data');
  const diagnostics = check(clean.linked);
  if (diagnostics.length) fail('INVALID_LINKED', JSON.stringify(diagnostics));
  planCheck(clean.plan, clean.linked);
  const ids = new Set<string>(), grantIds = new Set<string>();
  for (const id of clean.identities) {
    if (!record(id) || !text(id.actorId) || !Object.hasOwn(roles, id.role) || !['human', 'agent'].includes(id.kind)
      || (id.kind === 'agent' && id.role !== 'Agent') || (id.role === 'Agent' && id.kind !== 'agent') || ids.has(id.actorId)) fail('INVALID_IDENTITY', 'Invalid or duplicate synthetic registry identity');
    ids.add(id.actorId);
  }
  for (const g of clean.grants) {
    if (!record(g) || !text(g.id) || grantIds.has(g.id) || !text(g.version) || !ids.has(g.actorId)
      || !safeScope(g.scope) || !Array.isArray(g.actions) || !g.actions.length || !g.actions.every(text)
      || !['allow', 'deny'].includes(g.effect) || !['Suggest', 'Execute'].includes(g.autonomy)
      || !finite(g.validFrom) || !finite(g.validUntil) || g.validFrom >= g.validUntil
      || !text(g.budgetId) || ['__proto__', 'constructor', 'prototype'].includes(g.budgetId)
      || !Number.isSafeInteger(g.maxActions) || g.maxActions < 0) fail('INVALID_GRANT', 'Invalid grant, validity interval or budget');
    grantIds.add(g.id);
  }
  if (!scopeRecord(clean.state.requirement, clean.plan.scope)
    || (clean.state.requirement as Record<string, unknown>).contentHash !== clean.plan.requirementHash
    || (clean.state.requirement as Record<string, unknown>).protocolVersion !== clean.plan.body.applicableProtocolVersion) fail('REQUIREMENT_MISMATCH', 'Current requirement must match plan');
  if (clean.submitterId !== undefined && (!text(clean.submitterId) || !ids.has(clean.submitterId))) fail('INVALID_IDENTITY', 'Unknown submitter');
  if (clean.reviewerId !== undefined && (!text(clean.reviewerId) || !ids.has(clean.reviewerId))) fail('INVALID_IDENTITY', 'Unknown reviewer');
  if (clean.reviewerId !== undefined && clean.identities.find(i => i.actorId === clean.reviewerId)?.role !== 'CRA') fail('REVIEW_SEPARATION', 'Initial reviewer must be a registry CRA');
  if ((clean.state.requirement as Record<string, unknown>).protocolVersion !== clean.plan.body.applicableProtocolVersion) fail('REQUIREMENT_MISMATCH', 'Applicable protocol must match the fixed plan');
  const gate: Gate = Object.freeze({ kind: 'delegation-gate' });
  const value: Internal = Object.freeze({ linked: freeze(clean.linked), state: freeze(clean.state), plan: freeze(clean.plan),
    identities: freeze(clean.identities), grants: freeze(clean.grants), now, submitterId: clean.submitterId ?? '', reviewerId: clean.reviewerId ?? '',
    version: 0, taskCount: 0, usage: freeze({}), revokedGrants: freeze([]), revokedApprovals: freeze([]), approvals: freeze([]), requests: freeze({}), events: freeze([]), assurance });
  gates.set(gate, { value, busy: false, lastTime: -Number.MAX_VALUE, reentered: false });
  // Validate the adapter while the capability is guarded; do not expose a half-created gate.
  try { locked(gate, clock); } catch (error) { gates.delete(gate); throw error; }
  return gate;
}
export function snapshot(gate: Gate): GateSnapshot & { taskCount: number } {
  return locked(gate, cell => {
    const s = cell.value;
    return freeze(copy({ state: s.state, stateHash: stateDigest(s), planHash: s.plan.hash,
      scope: s.plan.scope, usage: s.usage, events: s.events, taskCount: s.taskCount }));
  });
}
function decision(s: Internal, req: ActionRequest, time: number, needsApproval = true, checkBudget = true): Decision {
  const deny = (code: string): Decision => ({ outcome: 'Deny', code });
  const escalate = (code: string): Decision => ({ outcome: 'Escalate', code });
  const actor = s.identities.find(i => i.actorId === req.actorId);
  if (!actor) return deny('UNKNOWN_ACTOR');
  if (req.expectedPlanHash !== s.plan.hash || req.expectedStateHash !== stateDigest(s)) return deny('STALE_VERSION');
  if (!scopeRecord(s.state.requirement, s.plan.scope) || (s.state.requirement as Record<string, unknown>).contentHash !== s.plan.requirementHash
    || (s.state.requirement as Record<string, unknown>).protocolVersion !== s.plan.body.applicableProtocolVersion) return deny('REQUIREMENT_MISMATCH');
  if (!Object.values(roles).some(actions => actions.includes(req.action))) return escalate('UNKNOWN_ACTION');
  if (!Object.hasOwn(roles, actor.role) || !roles[actor.role].includes(req.action)) return deny('ROLE_FORBIDDEN');
  if (req.action === 'approveClosure' && actor.kind !== 'human') return deny('HUMAN_APPROVAL_REQUIRED');
  // Phase4：启用凭证门后，复核与关闭必须由受信凭证支撑，输入 Bool 不再是依据。
  if (s.assurance && ASSURED_ACTIONS.includes(req.action)) {
    const attestation = attestationCheck(s);
    if (!attestation.ok) return deny(attestation.code);
    if (s.state.currentEvidenceHash !== s.assurance.evidenceHash) return deny('EVIDENCE_CHANGED');
  }
  if (actor.role === 'CRA' && actor.actorId === s.submitterId) return deny('REVIEW_SEPARATION');
  if (req.action === 'recordAcceptedPlan' && req.params.planHash !== s.plan.hash) return deny('PLAN_MISMATCH');
  if (req.inputs.stagedEvidence !== undefined && (!scopeRecord(req.inputs.stagedEvidence, s.plan.scope)
    || (req.inputs.stagedEvidence as Record<string, unknown>).requirementHash !== s.plan.requirementHash)) return deny('INPUT_SCOPE_MISMATCH');
  if (req.params.nextRequirement !== undefined && !scopeRecord(req.params.nextRequirement, s.plan.scope)) return deny('INPUT_SCOPE_MISMATCH');
  const matching = s.grants.filter(g => g.actorId === actor.actorId && sameScope(g.scope, s.plan.scope) && g.actions.includes(req.action));
  const active = matching.filter(g => !s.revokedGrants.includes(g.id) && g.validFrom <= time && time < g.validUntil);
  if (active.some(g => g.effect === 'deny')) return deny('EXPLICIT_DENY');
  const allows = active.filter(g => g.effect === 'allow');
  if (!allows.length) return deny(matching.some(g => s.revokedGrants.includes(g.id)) ? 'GRANT_REVOKED' : 'NO_GRANT');
  const executable = allows.filter(g => g.autonomy === 'Execute');
  if (!executable.length) return escalate('SUGGEST_ONLY');
  const usable = executable.filter(g => !checkBudget || used(s.usage, g.budgetId) < Math.min(...s.grants.filter(x => x.budgetId === g.budgetId).map(x => x.maxActions)));
  if (!usable.length) return deny('BUDGET_EXHAUSTED');
  if (req.action === 'closeFinding' && needsApproval) {
    if (!s.submitterId || !s.reviewerId || s.submitterId === s.reviewerId
      || actor.actorId === s.submitterId || actor.actorId === s.reviewerId
      || s.identities.find(i => i.actorId === s.reviewerId)?.role !== 'CRA') return deny('CLOSURE_SEPARATION');
    const request = digest(s, req);
    if (s.approvals.some(a => a.version === s.version && a.approval.actorId === actor.actorId
      && a.approval.requestHash === request && s.revokedApprovals.includes(a.approval.id))) return deny('APPROVAL_REVOKED');
    const approval = s.approvals.find(a => a.approval.actorId === actor.actorId && a.version === s.version
      && a.approval.planHash === s.plan.hash && a.approval.requestHash === request
      && !s.revokedApprovals.includes(a.approval.id) && time < a.approval.validUntil
      && !s.revokedGrants.includes(a.grantId)
      && s.grants.some(g => g.id === a.grantId && g.actorId === actor.actorId
        && sameScope(g.scope, s.plan.scope) && g.actions.includes('approveClosure')
        && g.effect === 'allow' && g.autonomy === 'Execute' && g.validFrom <= time && time < g.validUntil));
    if (!approval) return escalate('APPROVAL_REQUIRED');
    // Approval grant must still be valid; a deny added to the static registry dominates it.
    const aReq = { ...req, action: 'approveClosure', params: {}, inputs: {} };
    const aDecision = decision(s, aReq, time, false, false);
    const approvingGrant = s.grants.find(g => g.id === approval.grantId);
    if (!approvingGrant || !(approvingGrant.validFrom <= time && time < approvingGrant.validUntil)
      || aDecision.outcome !== 'Allow') return deny('APPROVAL_AUTHORITY_INVALID');
  }
  const grant = usable.sort((a, b) => a.id.localeCompare(b.id))[0];
  return { outcome: 'Allow', code: 'AUTHORIZED', grantHash: hashValue(grant), budgetId: grant.budgetId };
}
export function requestHash(gate: Gate, request: ActionRequest): string {
  return locked(gate, cell => {
    const req = validRequest(request), s = cell.value;
    if (req.expectedPlanHash !== s.plan.hash || req.expectedStateHash !== stateDigest(s)) fail('STALE_VERSION', 'Request is not current');
    const hash = digest(s, req);
    commit(cell, { requests: freeze({ ...s.requests, [hash]: freeze({ request: req, version: s.version }) }) });
    return hash;
  });
}
export function authorize(gate: Gate, request: ActionRequest): Decision {
  return locked(gate, cell => {
    try { const req = validRequest(request); return freeze(decision(cell.value, req, clock(cell))); }
    catch (error) { return freeze({ outcome: 'Deny', code: error instanceof GilError ? error.code : 'INVALID_REQUEST' }); }
  });
}
export interface ExecutionResult { decision: Decision; stateHash: string; ok: boolean; code: string; taskCount?: number; checks?: unknown; mode: 'delegation-simulation' }
export function execute(gate: Gate, request: ActionRequest): ExecutionResult {
  return locked(gate, cell => {
    let req: ActionRequest | undefined, time = cell.lastTime, d: Decision = { outcome: 'Deny', code: 'INVALID_REQUEST' };
    const result = (ok: boolean, code: string, extra: Record<string, unknown> = {}): ExecutionResult =>
      freeze({ decision: d, stateHash: stateDigest(cell.value), ok, code, mode: 'delegation-simulation', ...extra });
    try { req = validRequest(request); time = clock(cell); }
    catch (error) {
      d = { outcome: 'Deny', code: error instanceof GilError ? error.code : 'INVALID_REQUEST' };
      event(cell, 'Attempt', '', time, { rejectedInput: true }); event(cell, 'Denied', '', time, { decision: d });
      return result(false, d.code);
    }
    event(cell, 'Attempt', req.actorId, time, { requestHash: digest(cell.value, req), request: req });
    d = decision(cell.value, req, time);
    if (d.outcome !== 'Allow') { event(cell, d.outcome === 'Deny' ? 'Denied' : 'Escalated', req.actorId, time, { decision: d }); return result(false, d.code); }
    const before = cell.value;
    try {
      let candidate = before.state, taskCount = before.taskCount, checks: unknown = [];
      if (req.action === 'dispatchTask') {
        if (!text(req.params.taskId)) fail('INVALID_TASK', 'Synthetic dispatch requires taskId');
        if (!Number.isSafeInteger(taskCount + 1)) fail('TASK_LIMIT', 'Task counter overflow');
        taskCount++;
      } else {
        // 凭证有效时以凭证结果覆盖调用者的 reviewStillValid，杜绝自报通过。
        const inputs = before.assurance && ASSURED_ACTIONS.includes(req.action)
          ? freeze({ ...req.inputs, reviewStillValid: true }) : req.inputs;
        const simulation = simulate(before.linked, before.state, inputs, req.action, req.params);
        checks = simulation.checks;
        if (!simulation.ok) { event(cell, 'Failed', req.actorId, time, { code: 'SIMULATION_FAILED', stage: simulation.stage, checks }); return result(false, 'SIMULATION_FAILED', { checks }); }
        candidate = freeze(copy(simulation.state));
      }
      // Guarded synchronous recheck immediately before transactional state/budget commit.
      time = clock(cell);
      const recheck = decision(cell.value, req, time);
      if (cell.value.version !== before.version || recheck.outcome !== 'Allow'
        || recheck.grantHash !== d.grantHash || recheck.budgetId !== d.budgetId) {
        event(cell, 'Failed', req.actorId, time, { code: 'AUTHORIZATION_CHANGED', decision: recheck }); return result(false, 'AUTHORIZATION_CHANGED');
      }
      const usage = freeze({ ...before.usage, [d.budgetId!]: used(before.usage, d.budgetId!) + 1 });
      const version = before.version + 1;
      const payload = { beforeStateHash: stateDigest(before), afterStateHash: hashValue({ state: candidate, version, taskCount }), decision: d, taskCount,
        assurance: before.assurance ? { attestationHash: before.assurance.attestationHash, evidenceHash: before.assurance.evidenceHash,
          requirementHash: before.assurance.requirementHash, overrodeSelfReport: ASSURED_ACTIONS.includes(req.action) } : null };
      // Prepare every fallible hash before changing domain state or its ledger.
      hashValue(payload);
      commit(cell, { state: candidate, taskCount, usage, version,
        submitterId: req.action === 'submitEvidence' ? req.actorId : before.submitterId,
        reviewerId: req.action === 'recordReviewPass' ? req.actorId : before.reviewerId });
      event(cell, 'Succeeded', req.actorId, time, payload);
      return result(true, 'SUCCEEDED', { checks, taskCount });
    } catch (error) {
      const code = error instanceof GilError ? error.code : 'SIMULATION_EXCEPTION';
      event(cell, 'Failed', req.actorId, time, { code }); return result(false, code);
    }
  });
}
export function approve(gate: Gate, approval: Approval): void {
  locked(gate, cell => {
    const a = copy(approval), s = cell.value;
    if (!record(a) || !text(a.id) || !text(a.version) || !text(a.actorId) || !text(a.planHash)
      || !text(a.requestHash) || !finite(a.validUntil) || s.approvals.some(x => x.approval.id === a.id)
      || s.revokedApprovals.includes(a.id)) fail('INVALID_APPROVAL', 'Approval must be new and exact');
    const time = clock(cell), actor = s.identities.find(i => i.actorId === a.actorId);
    if (!actor || actor.kind !== 'human' || actor.role !== 'CTM') fail('HUMAN_APPROVAL_REQUIRED', 'Only a registry human CTM can approve');
    const remembered = s.requests[a.requestHash];
    if (a.planHash !== s.plan.hash || !remembered || remembered.version !== s.version
      || remembered.request.action !== 'closeFinding' || remembered.request.actorId !== a.actorId
      || digest(s, remembered.request) !== a.requestHash || a.validUntil <= time) fail('STALE_APPROVAL', 'Approval must bind a current exact closure request');
    const request = { ...remembered.request, action: 'approveClosure', params: {}, inputs: {} };
    const d = decision(s, request, time, false);
    if (d.outcome !== 'Allow') fail(d.code, 'No executable approval authority');
    const grant = s.grants.find(g => hashValue(g) === d.grantHash)!;
    if (a.validUntil > grant.validUntil) fail('INVALID_APPROVAL', 'Approval cannot outlive its grant');
    // Recheck adapter just before committing approval and its shared budget usage.
    const recheck = decision(s, request, clock(cell), false);
    if (recheck.outcome !== 'Allow' || recheck.grantHash !== d.grantHash || a.validUntil <= cell.lastTime) fail('AUTHORIZATION_CHANGED', 'Approval authority changed');
    commit(cell, { approvals: freeze([...s.approvals, freeze({ approval: a, grantId: grant.id, version: s.version })]),
      usage: freeze({ ...s.usage, [d.budgetId!]: used(s.usage, d.budgetId!) + 1 }) });
    event(cell, 'Control', a.actorId, cell.lastTime, { control: 'Approve', approval: a, grantHash: d.grantHash! });
  });
}
export function revokeGrant(gate: Gate, id: string): void {
  locked(gate, cell => {
    if (!text(id) || !cell.value.grants.some(g => g.id === id)) fail('UNKNOWN_GRANT', 'Unknown grant');
    const time = clock(cell);
    commit(cell, { revokedGrants: freeze([...new Set([...cell.value.revokedGrants, id])]) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'RevokeGrant', id,
      grantHash: hashValue(cell.value.grants.find(g => g.id === id)!) });
  });
}
export function revokeApproval(gate: Gate, id: string): void {
  locked(gate, cell => {
    if (!text(id) || !cell.value.approvals.some(a => a.approval.id === id)) fail('UNKNOWN_APPROVAL', 'Unknown approval');
    const time = clock(cell);
    commit(cell, { revokedApprovals: freeze([...new Set([...cell.value.revokedApprovals, id])]) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'RevokeApproval', id });
  });
}
export function setCurrentPlan(gate: Gate, plan: BoundPlan): void {  locked(gate, cell => {
    hashValue(plan);
    const clean = plan, s = cell.value;
    planCheck(clean, s.linked);
    if (!sameScope(clean.scope, s.plan.scope) || !scopeRecord(s.state.requirement, clean.scope)
      || (s.state.requirement as Record<string, unknown>).contentHash !== clean.requirementHash
      || (s.state.requirement as Record<string, unknown>).protocolVersion !== clean.body.applicableProtocolVersion) fail('REQUIREMENT_MISMATCH', 'New plan must bind the current requirement and gate scope');
    const time = clock(cell);
    commit(cell, { plan: freeze(clean), version: s.version + 1, requests: freeze({}) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'SetCurrentPlan', previousPlanHash: s.plan.hash, planHash: clean.hash });
  });
}
/**
 * 由受信适配器切换当前凭证（例如 CRA 重新复核后）。旧批准因请求摘要含凭证而失效。
 * 撤销/过期由注册表自身评估，这里只更换引用，不产生新凭证。
 */
export function setAssurance(gate: Gate, binding: AssuranceBinding): void {
  locked(gate, cell => {
    const s = cell.value;
    if (!record(binding) || !text(binding.attestationHash) || !text(binding.evidenceHash) || !text(binding.requirementHash)) {
      fail('INVALID_ASSURANCE', 'Assurance binding requires registry, attestation, evidence and requirement');
    }
    try { inspect(binding.registry, binding.attestationHash); }
    catch (error) { fail('INVALID_ASSURANCE', error instanceof GilError ? error.message : 'Assurance must be issued in this process'); }
    if (binding.requirementHash !== s.plan.requirementHash) fail('REQUIREMENT_MISMATCH', 'Assurance must bind the current plan requirement');
    const time = clock(cell);
    // 只有对当前证据有效且为 Pass 的凭证才能成为当前凭证；撤销/过期/Unknown 均拒绝。
    const evidence = typeof s.state.currentEvidenceHash === 'string' ? s.state.currentEvidenceHash : '';
    if (binding.evidenceHash !== evidence) fail('EVIDENCE_CHANGED', 'Assurance must bind the currently submitted evidence');
    const candidate = { ...s, assurance: { registry: binding.registry, attestationHash: binding.attestationHash,
      evidenceHash: binding.evidenceHash, requirementHash: binding.requirementHash } } as Internal;
    const attestation = attestationCheck(candidate);
    if (!attestation.ok) fail(attestation.code, `Current attestation is not a valid pass: ${attestation.reasons.join(',')}`);
    commit(cell, { assurance: Object.freeze({ registry: binding.registry, attestationHash: binding.attestationHash,
      evidenceHash: binding.evidenceHash, requirementHash: binding.requirementHash }), version: s.version + 1, requests: freeze({}) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'SetAssurance',
      previousAttestationHash: s.assurance?.attestationHash ?? null, attestationHash: binding.attestationHash, evidenceHash: binding.evidenceHash });
  });
}
