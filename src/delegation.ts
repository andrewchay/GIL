import { types } from 'node:util';
import { GilError } from './ast.ts';
import { check } from './checker.ts';
import { contentHash } from './canonical.ts';
import { hashValue } from './interpretation.ts';
import { simulate } from './runtime.ts';
import { validatePlan } from './plans.ts';
import { evaluate, inspect } from './assurance.ts';
import { blockerStatus, validateBlockerLedger } from './blockers.ts';
import { acknowledgeEscalation, deadlineStatus, escalationView, obligationView, recordBusinessDate, validateObligation } from './deadlines.ts';
import { emptyBusinessDates } from './deadlines.ts';
import type { BusinessDateRecord, EscalationAck, Obligation } from './deadlines.ts';
import type { BlockerLedger } from './blockers.ts';
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
  /** Phase5：受信阻断项台账，缺省表示未配置（复核/关闭一律拒绝）。 */
  blockers: BlockerLedger | null;
  /** Phase5：受信期限义务，缺省表示未配置。 */
  deadline: Obligation | null;
  /** Phase5：已签发的越期处置回执；撤销由重新签发替代。 */
  escalation: EscalationAck | null;
  /** Phase5：业务日期簿，真实执行时间另行保存在审计 time 字段。 */
  businessDates: BusinessDateRecord;
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
      evidenceHash: s.assurance.evidenceHash, requirementHash: s.assurance.requirementHash } : null,
    // Phase5：阻断项台账、期限义务与处置回执同样进入摘要，解除/换期后旧批准失效。
    blockers: s.blockers ? s.blockers.ledgerHash : null,
    deadline: s.deadline ? s.deadline.contentHash : null,
    escalation: s.escalation ? s.escalation.ackId : null });
}

/** 受信输入：只能由 gate 从受信工件注入，调用者提供即拒绝。 */
const TRUSTED_INPUT_KEYS: readonly string[] = ['actionAt', 'blockers', 'deadline', 'escalation'];
/** 需要阻断项台账的动作。 */
const BLOCKER_ACTIONS: readonly string[] = ['recordReviewPass', 'closeFinding'];
/** 需要期限义务的动作。 */
const DEADLINE_ACTIONS: readonly string[] = ['closeFinding'];

/** 回执只在属于当前义务时才算处置；换义务后旧回执必须失效。 */
function escalationApplies(s: Internal): EscalationAck | null {
  if (!s.escalation || !s.deadline) return null;
  return s.escalation.obligationHash === s.deadline.contentHash ? s.escalation : null;
}

function declaresInput(s: Internal, name: string): boolean {
  return s.linked.spec.input.some(binding => binding.name === name);
}

/**
 * 构造交给 Core 的输入：调用者字段 + 受信注入。
 * 真实执行时间、阻断状态、期限视图与处置回执全部来自受信工件，调用者无法自报。
 */
function trustedInputs(s: Internal, raw: State, time: number): State {
  const inputs: State = { ...raw };
  // 只注入 spec 真正声明的字段，避免向其他 spec 注入未声明绑定。
  if (s.blockers && declaresInput(s, 'blockers')) inputs.blockers = blockerStatus(s.blockers) as unknown as State;
  if (s.deadline) {
    if (declaresInput(s, 'deadline')) inputs.deadline = obligationView(s.deadline) as unknown as State;
    if (declaresInput(s, 'actionAt')) inputs.actionAt = time;
    const applicable = escalationApplies(s);
    if (applicable && declaresInput(s, 'escalation')) {
      inputs.escalation = escalationView(applicable, s.deadline) as unknown as State;
    } else delete inputs.escalation;
  }
  return inputs;
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
  // 能力与受信工件对象不参与内容寻址：JSON 摘要无法承载 provenance。
  const uncopyable = ['assurance', 'blockers', 'deadline'];
  for (const [key, value] of Object.entries(data)) if (!uncopyable.includes(key)) hashable[key] = value;
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
  // Phase5 受信工件：必须由本进程签发，且必须属于本 gate 的 finding。
  let blockers: BlockerLedger | null = null;
  if (data.blockers !== undefined) {
    const raw = data.blockers as BlockerLedger;
    try { validateBlockerLedger(raw); }
    catch (error) { fail('INVALID_BLOCKERS', error instanceof GilError ? error.message : 'Blocker ledger must be issued in this process'); }
    blockers = raw;
  }
  let deadline: Obligation | null = null;
  if (data.deadline !== undefined) {
    const raw = data.deadline as Obligation;
    try { validateObligation(raw); }
    catch (error) { fail('INVALID_DEADLINE', error instanceof GilError ? error.message : 'Obligation must be issued in this process'); }
    deadline = raw;
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
  if (blockers && blockers.findingId !== clean.plan.scope.findingId) fail('BLOCKER_SCOPE_MISMATCH', 'Blocker ledger must belong to the plan finding');
  if (deadline && deadline.findingId !== clean.plan.scope.findingId) fail('DEADLINE_SCOPE_MISMATCH', 'Obligation must belong to the plan finding');
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
    version: 0, taskCount: 0, usage: freeze({}), revokedGrants: freeze([]), revokedApprovals: freeze([]), approvals: freeze([]), requests: freeze({}), events: freeze([]),
    assurance, blockers, deadline, escalation: null, businessDates: emptyBusinessDates() });
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
  // Phase5：受信输入不可由调用者提供；缺失即拒绝，不做“默认已解除”的推断。
  for (const key of TRUSTED_INPUT_KEYS) {
    if (Object.hasOwn(req.inputs, key)) return deny('CALLER_CONTROLLED_TRUSTED_INPUT');
  }
  if (BLOCKER_ACTIONS.includes(req.action) && declaresInput(s, 'blockers')) {
    if (!s.blockers) return deny('BLOCKER_LEDGER_REQUIRED');
    if (s.blockers.openIds.length) return deny('BLOCKERS_OPEN');
  }
  if (DEADLINE_ACTIONS.includes(req.action) && declaresInput(s, 'deadline')) {
    if (!s.deadline) return deny('DEADLINE_REQUIRED');
    const deadline = deadlineStatus(s.deadline, time);
    // 逾期阻断只由同一义务的显式 ACCEPT-LATE 处置解除；REMEDIATE 不解除期限阻断。
    const applicable = escalationApplies(s);
    const acceptedLate = applicable !== null && applicable.disposition === 'ACCEPT-LATE';
    if (deadline.blocked && !acceptedLate) return deny('DEADLINE_EXCEEDED');
  }
  // 业务日期只能持平或前进：回填更早日期被拒绝，历史不可改写。
  const businessDate = req.inputs.businessDate;
  if (typeof businessDate === 'number' && Number.isFinite(businessDate)
    && businessDate < s.businessDates.lastBusinessDate) return deny('BACKDATED_BUSINESS_DATE');
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
    event(cell, 'Attempt', req.actorId, time, { requestHash: digest(cell.value, req), request: req,
      businessDate: typeof req.inputs.businessDate === 'number' ? req.inputs.businessDate : null });
    // 逾期只作为事实写入升级事件：不伪造复核结论，也不自动解除任何阻断。
    const overdue = cell.value.deadline && DEADLINE_ACTIONS.includes(req.action)
      ? deadlineStatus(cell.value.deadline, time) : null;
    if (overdue && overdue.overdue) {
      event(cell, 'Escalation', 'trusted-adapter', time, { escalation: 'OVERDUE', reason: overdue.reason,
        dueAt: overdue.dueAt, sourceRef: overdue.sourceRef, sourceVersion: overdue.sourceVersion, policy: overdue.policy });
    }
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
        // 凭证有效时以凭证结果覆盖调用者的 reviewStillValid，杜绝自报通过；
        // 阻断状态、期限视图与真实执行时间一律从受信工件注入，不采信调用者字段。
        const merged = before.assurance && ASSURED_ACTIONS.includes(req.action)
          ? { ...req.inputs, reviewStillValid: true } : { ...req.inputs };
        const inputs = freeze(trustedInputs(before, merged as State, time));
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
        // 真实执行时间就是事件 time；这里只额外记录声明的业务日期，两者不合并。
        businessDate: typeof req.inputs.businessDate === 'number' ? req.inputs.businessDate : null,
        blockers: before.blockers ? { ledgerHash: before.blockers.ledgerHash, openCount: before.blockers.openIds.length } : null,
        deadline: before.deadline ? { contentHash: before.deadline.contentHash, dueAt: before.deadline.dueAt, policy: before.deadline.policy } : null,
        assurance: before.assurance ? { attestationHash: before.assurance.attestationHash, evidenceHash: before.assurance.evidenceHash,
          requirementHash: before.assurance.requirementHash, overrodeSelfReport: ASSURED_ACTIONS.includes(req.action) } : null };
      // Prepare every fallible hash before changing domain state or its ledger.
      hashValue(payload);
      // 业务日期在关闭时落账：这里记录的是声明日期，真实时间另存于事件 time。
      const businessDates = req.action === 'closeFinding' && typeof req.inputs.businessDate === 'number'
        ? recordBusinessDate(before.businessDates, req.inputs.businessDate, time) : before.businessDates;
      commit(cell, { state: candidate, taskCount, usage, version, businessDates,
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

/**
 * Phase5：由受信适配器替换当前阻断项台账（例如政策阻断被逐项解除后）。
 * 旧台账不可变，旧批准因摘要含 ledgerHash 而失效；未解除的阻断项继续阻断复核与关闭。
 */
export function setBlockers(gate: Gate, ledger: BlockerLedger): void {
  locked(gate, cell => {
    const s = cell.value;
    let valid: BlockerLedger;
    try { valid = validateBlockerLedger(ledger); }
    catch (error) { fail('INVALID_BLOCKERS', error instanceof GilError ? error.message : 'Blocker ledger must be issued in this process'); }
    if (valid.findingId !== s.plan.scope.findingId) fail('BLOCKER_SCOPE_MISMATCH', 'Blocker ledger must belong to the plan finding');
    if (valid.ledgerHash === (s.blockers ? s.blockers.ledgerHash : '')) return;
    const time = clock(cell);
    commit(cell, { blockers: valid, version: s.version + 1, requests: freeze({}) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'SetBlockers',
      previousLedgerHash: s.blockers ? s.blockers.ledgerHash : null, ledgerHash: valid.ledgerHash,
      openCount: valid.openIds.length, total: valid.entries.length });
  });
}

/** Phase5：由受信适配器提供显式期限义务。没有来源的义务不可能被创建，因此这里只接受已签发工件。 */
export function setDeadline(gate: Gate, obligation: Obligation): void {
  locked(gate, cell => {
    const s = cell.value;
    let valid: Obligation;
    try { valid = validateObligation(obligation); }
    catch (error) { fail('INVALID_DEADLINE', error instanceof GilError ? error.message : 'Obligation must be issued in this process'); }
    if (valid.findingId !== s.plan.scope.findingId) fail('DEADLINE_SCOPE_MISMATCH', 'Obligation must belong to the plan finding');
    if (valid.contentHash === (s.deadline ? s.deadline.contentHash : '')) return;
    const time = clock(cell);
    // 换义务后旧处置回执不再适用：显式清空，避免跨义务复用。
    commit(cell, { deadline: valid, escalation: null, version: s.version + 1, requests: freeze({}) });
    event(cell, 'Control', 'trusted-adapter', time, { control: 'SetDeadline',
      previousObligationHash: s.deadline ? s.deadline.contentHash : null, obligationHash: valid.contentHash,
      dueAt: valid.dueAt, sourceRef: valid.sourceRef, sourceVersion: valid.sourceVersion, policy: valid.policy });
  });
}

/**
 * Phase5：登记越期处置回执。只有注册表内的具名 CTM 能处置，且回执必须属于当前义务。
 * ACCEPT-LATE 只解除期限阻断；证据、复核与批准要求完全不变。
 */
export function recordEscalation(gate: Gate, ack: EscalationAck): void {
  locked(gate, cell => {
    const s = cell.value;
    if (!s.deadline) fail('DEADLINE_REQUIRED', 'No obligation is configured on this gate');
    let view: ReturnType<typeof escalationView>;
    try { view = escalationView(ack, s.deadline); }
    catch (error) { fail('INVALID_ESCALATION', error instanceof GilError ? error.message : 'Escalation ack must be issued in this process'); }
    const actor = s.identities.find(identity => identity.actorId === view.authority);
    if (!actor || actor.kind !== 'human' || actor.role !== 'CTM') fail('HUMAN_APPROVAL_REQUIRED', 'Only a registry human CTM may dispose of an overdue obligation');
    const time = clock(cell);
    if (ack.at > time) fail('INVALID_ESCALATION', 'Escalation ack cannot come from the future');
    if (s.escalation && s.escalation.ackId === ack.ackId) return;
    commit(cell, { escalation: ack, version: s.version + 1, requests: freeze({}) });
    event(cell, 'Control', view.authority, time, { control: 'RecordEscalation', ackId: view.ackId,
      obligationHash: view.obligationHash, disposition: view.disposition });
  });
}

/** Phase5 诊断视图：仍被阻断的目标与各目的解除权限，用于向人解释"为什么不能关闭"。 */
export function blockerReport(gate: Gate): { ledgerHash: string; openCount: number; total: number;
  open: { id: string; target: string; kind: string; owner: string; resolutionAuthority: string }[] } | null {
  return locked(gate, cell => {
    const s = cell.value;
    if (!s.blockers) return null;
    return freeze({ ledgerHash: s.blockers.ledgerHash, openCount: s.blockers.openIds.length, total: s.blockers.entries.length,
      open: s.blockers.entries.filter(entry => entry.state === 'OPEN').map(entry => ({ id: entry.id, target: entry.target,
        kind: entry.kind, owner: entry.owner, resolutionAuthority: entry.resolutionAuthority })) });
  });
}

/** Phase5 期限诊断视图：真实执行时间与声明业务日期分开报告。 */
export function deadlineReport(gate: Gate): { dueAt: number; sourceRef: string; sourceVersion: string; policy: string;
  overdue: boolean; blocked: boolean; dispositionAccepted: boolean; reason: string;
  escalation: { ackId: string; disposition: string; authority: string } | null;
  lastBusinessDate: number } | null {
  return locked(gate, cell => {
    const s = cell.value;
    if (!s.deadline) return null;
    const status = deadlineStatus(s.deadline, clock(cell));
    // 只有 ACCEPT-LATE 处置才算越期放行；REMEDIATE 仍视为阻断。
    const applicable = escalationApplies(s);
    const dispositionAccepted = applicable !== null && applicable.disposition === 'ACCEPT-LATE';
    return freeze({ dueAt: status.dueAt, sourceRef: status.sourceRef, sourceVersion: status.sourceVersion, policy: status.policy,
      overdue: status.overdue, blocked: status.blocked && !dispositionAccepted, dispositionAccepted, reason: status.reason,
      escalation: applicable ? { ackId: applicable.ackId, disposition: applicable.disposition, authority: applicable.authority } : null,
      lastBusinessDate: s.businessDates.lastBusinessDate });
  });
}
