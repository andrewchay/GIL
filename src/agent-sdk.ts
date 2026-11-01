import { randomUUID } from 'node:crypto';
import { hashValue } from './interpretation.ts';
import { fail, freeze } from './artifact.ts';
import { evaluateSnapshot, validateClaim, validateSnapshot } from './agent-semantics.ts';
import type { Claim as AgentClaim, Snapshot as AgentSnapshot } from './agent-semantics.ts';

export const AGENT_PROFILE = 'gil-agent-contract-0.2-experimental';
export interface Draft {
  domain: string; goal: string; action: string; purpose: string;
  fields: string[]; recipient: string | null; destination: string;
  claim: AgentClaim; requiredReviews: string[];
}
export interface ModelProvider {
  /** No actor, grant, acceptance or approval capability is passed to the model. */
  propose(input: { instruction: string; domain: string; actions: string[] }): Promise<unknown>;
}
export interface Principal { id: string; kind: 'human' | 'agent'; canAccept: boolean; reviews: string[] }
export interface Grant {
  id: string; actor: string; domain: string; action: string; purpose: string;
  fields: string[]; recipient: string; destination: string;
  maxActions: number; validUntil: number;
}
export interface ExecutionRequest {
  idempotencyKey: string; requestHash: string; contractHash: string;
  snapshotHash: string; action: string; purpose: string; fields: string[];
  recipient: string; destination: string;
}
export interface Receipt { requestHash: string; status: 'Succeeded' | 'Failed'; output: Record<string, unknown> }
export interface ActionAdapter {
  execute(request: ExecutionRequest): Promise<unknown>;
  reconcile?(request: ExecutionRequest): Promise<unknown>;
  /** Only the trusted host configures this verifier; receipt success alone is insufficient. */
  verify(request: ExecutionRequest, receipt: Receipt): boolean | Promise<boolean>;
}
export interface HostConfig {
  principals: Principal[]; grants: Grant[]; adapters: Record<string, ActionAdapter>;
  now: () => number; timeoutMs?: number;
  /** Mandatory host policy: a model cannot remove required reviews from its candidate. */
  actionReviews: Record<string, string[]>;
  /** Exact domain/action claim policy, controlled by host rather than model. */
  actionClaims: Record<string, AgentClaim>;
}
interface Entry {
  id: string; draft: Draft; snapshot: AgentSnapshot; proposer: string; version: number;
  acceptance?: { by: string; binding: string };
  approvals: Record<string, { by: string; binding: string }>;
  events: { type: string; actor: string; binding: string }[];
  busy: boolean;
}
interface Attempt {
  actor: string; binding: string; request: ExecutionRequest; adapter: ActionAdapter;
  grantId: string; result: Record<string, unknown>; reconciling?: boolean;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  hashValue(value); // rejects Proxy/getters/cycles/non-JSON before reflection
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CONTRACT', 'Expected object');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(r, k))) fail('INVALID_CONTRACT', 'Exact fields required');
  return r;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail('INVALID_CONTRACT', 'Expected bounded nonempty text');
  return value;
}
function identifier(value: unknown): string {
  const v=text(value); if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(v)) fail('INVALID_CONTRACT','Domain/action must be identifiers'); return v;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) fail('INVALID_CONTRACT', 'Expected bounded string list');
  const list = value.map(text);
  if (new Set(list).size !== list.length) fail('INVALID_CONTRACT', 'Duplicate list entries');
  return list;
}
export function validateDraft(value: unknown): Draft {
  const r = object(value, ['domain', 'goal', 'action', 'purpose', 'fields', 'recipient', 'destination', 'claim', 'requiredReviews']);
  const d: Draft = { domain: identifier(r.domain), goal: text(r.goal), action: identifier(r.action), purpose: text(r.purpose),
    fields: strings(r.fields), recipient: r.recipient === null ? null : text(r.recipient), destination: text(r.destination),
    claim: validateClaim(r.claim), requiredReviews: strings(r.requiredReviews) };
  return freeze(d);
}
export class FixtureModel implements ModelProvider {
  private readonly draft: unknown;
  constructor(draft: unknown) { this.draft = draft; }
  async propose(): Promise<unknown> { hashValue(this.draft); return structuredClone(this.draft); }
}

/** Process-local orchestration. Principal/grant/adapter configuration is trusted host input. */
export class AgentService {
  private entries = new Map<string, Entry>();
  private attempts = new Map<string, Attempt>();
  private reservations = new Map<string, number>();
  private revoked = new Set<string>();
  private lastTime = -Infinity;
  private config: HostConfig;
  constructor(config: HostConfig) {
    hashValue({ principals: config.principals, grants: config.grants });
    const principals = structuredClone(config.principals), grants = structuredClone(config.grants);
    if (new Set(principals.map(p => p.id)).size !== principals.length || new Set(grants.map(g => g.id)).size !== grants.length) fail('INVALID_HOST', 'Duplicate identities/grants');
    for (const p of principals) {
      text(p.id); strings(p.reviews);
      if (!['human', 'agent'].includes(p.kind) || typeof p.canAccept !== 'boolean') fail('INVALID_HOST', 'Invalid principal');
    }
    for (const g of grants) {
      if (!principals.some(p => p.id === g.actor) || !Number.isSafeInteger(g.maxActions) || g.maxActions < 0 || !Number.isFinite(g.validUntil)) fail('INVALID_HOST', 'Invalid grant');
      [g.id,g.domain,g.action,g.purpose,g.recipient,g.destination].forEach(text); strings(g.fields);
    }
    const timeoutMs = config.timeoutMs ?? 1000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('INVALID_HOST', 'Invalid timeout');
    hashValue(config.actionReviews); hashValue(config.actionClaims);
    for (const claim of Object.values(config.actionClaims)) validateClaim(claim);
    for (const action of Object.keys(config.adapters)) {
      if (!Object.hasOwn(config.actionReviews, action)) fail('INVALID_HOST', 'Each adapter needs explicit review policy');
      strings(config.actionReviews[action]);
    }
    this.config = { ...config, principals: freeze(principals), grants: freeze(grants), adapters: { ...config.adapters },
      actionReviews: freeze(structuredClone(config.actionReviews)), actionClaims: freeze(structuredClone(config.actionClaims)), timeoutMs };
  }
  private clock(): number {
    const time = this.config.now();
    if (!Number.isFinite(time) || time < this.lastTime) fail('CLOCK_REGRESSION', 'Trusted clock regressed');
    this.lastTime = time; return time;
  }
  private principal(id: string): Principal {
    const p = this.config.principals.find(p => p.id === id);
    if (!p) fail('UNKNOWN_ACTOR', 'No host-authenticated principal'); return p;
  }
  private entry(id: string): Entry {
    const e = this.entries.get(id); if (!e) fail('NOT_FOUND', 'Unknown contract'); return e;
  }
  private hashes(e: Entry) {
    const contractHash = hashValue({ profile: AGENT_PROFILE, draft: e.draft });
    const snapshotHash = hashValue({ profile: AGENT_PROFILE, snapshot: e.snapshot });
    return { contractHash, snapshotHash, binding: hashValue({ contractHash, snapshotHash, version: e.version, id: e.id }) };
  }
  private editable(e: Entry) { if (e.busy) fail('EXECUTION_PENDING', 'Reconcile pending action before changing its inputs'); }
  private event(e: Entry, type: string, actor: string) { e.events.push({ type, actor, binding: this.hashes(e).binding }); }
  create(actor: string, draft: unknown, snapshot: unknown): Record<string, unknown> {
    this.principal(actor);
    const e: Entry = { id: randomUUID(), draft: validateDraft(draft), snapshot: validateSnapshot(snapshot), proposer: actor,
      version: 1, approvals: Object.create(null), events: [], busy: false };
    if (!Object.hasOwn(this.config.actionReviews, e.draft.action)) fail('UNSUPPORTED_ACTION', 'Undeclared action');
    const policyKey = `${e.draft.domain}:${e.draft.action}`;
    if (!Object.hasOwn(this.config.actionClaims, policyKey) || hashValue(e.draft.claim) !== hashValue(this.config.actionClaims[policyKey])) {
      fail('MODEL_CONTRACT_REJECTED', 'Candidate changed mandatory host claim contract');
    }
    if (!this.config.actionReviews[e.draft.action].every(r => e.draft.requiredReviews.includes(r))) fail('MODEL_CONTRACT_REJECTED', 'Candidate omitted mandatory host reviews');
    this.entries.set(e.id, e); this.event(e, 'Propose', actor); return this.get(e.id);
  }
  async propose(actor: string, instruction: string, snapshot: unknown, domain: string, model: ModelProvider): Promise<Record<string, unknown>> {
    this.principal(actor); text(instruction); text(domain);
    const actions = Object.keys(this.config.adapters);
    const draft = validateDraft(await model.propose(freeze({ instruction, domain, actions })));
    if (draft.domain !== domain || !actions.includes(draft.action)) fail('MODEL_CONTRACT_REJECTED', 'Model selected undeclared domain/action');
    return this.create(actor, draft, snapshot);
  }
  get(id: string): Record<string, unknown> {
    const e = this.entry(id), h = this.hashes(e);
    return freeze(structuredClone({ id, profile: AGENT_PROFILE, mode: 'process-local-simulation', productionAuthorization: false,
      version: e.version, draft: e.draft, snapshot: e.snapshot, ...h,
      questions: e.draft.recipient === null ? [{ target: 'recipient', affects: [e.draft.action] }] : [],
      report: evaluateSnapshot(e.snapshot, e.draft.claim), acceptance: e.acceptance ?? null, approvals: e.approvals,
      events: e.events, busy: e.busy }));
  }
  answer(actor: string, id: string, binding: string, recipient: unknown): Record<string, unknown> {
    const e = this.entry(id); this.editable(e);
    if (this.principal(actor).kind !== 'human') fail('HUMAN_REQUIRED', 'Agent cannot answer for a human');
    if (binding !== this.hashes(e).binding) fail('STALE_BINDING', 'Question belongs to another version');
    if (e.draft.recipient !== null) fail('NO_OPEN_QUESTION', 'Recipient is already resolved');
    e.draft = validateDraft({ ...e.draft, recipient: text(recipient) }); e.version++;
    e.acceptance = undefined; e.approvals = Object.create(null); this.event(e, 'Answer', actor); return this.get(id);
  }
  accept(actor: string, id: string, binding: string): Record<string, unknown> {
    const e = this.entry(id); this.editable(e); const p = this.principal(actor);
    if (p.kind !== 'human' || !p.canAccept) fail('HUMAN_REQUIRED', 'Only a configured human may accept');
    if (binding !== this.hashes(e).binding) fail('STALE_BINDING', 'Acceptance must bind exact contract and inputs');
    if (e.draft.recipient === null) fail('UNRESOLVED', 'Answer required before acceptance');
    e.acceptance = { by: actor, binding }; e.approvals = Object.create(null); this.event(e, 'Accept', actor); return this.get(id);
  }
  approve(actor: string, id: string, binding: string, review: string): Record<string, unknown> {
    const e = this.entry(id); this.editable(e); const p = this.principal(actor);
    if (p.kind !== 'human' || !p.reviews.includes(review)) fail('REVIEW_DENIED', 'Reviewer lacks host-configured review capability');
    if (!e.draft.requiredReviews.includes(review)) fail('UNKNOWN_REVIEW', 'Review is not declared');
    if (actor === e.proposer || actor === e.acceptance?.by) fail('SELF_REVIEW', 'Reviewer must be separate from proposer/acceptor');
    if (!e.acceptance || binding !== this.hashes(e).binding || e.acceptance.binding !== binding) fail('STALE_BINDING', 'Current accepted binding required');
    e.approvals[review] = { by: actor, binding }; this.event(e, 'Approve', actor); return this.get(id);
  }
  /** Trusted ingestion, not a model tool or public HTTP endpoint. */
  replaceSnapshot(id: string, snapshot: unknown): Record<string, unknown> {
    const e = this.entry(id); this.editable(e); e.snapshot = validateSnapshot(snapshot); e.version++;
    e.acceptance = undefined; e.approvals = Object.create(null); this.event(e, 'ReplaceSnapshot', 'host'); return this.get(id);
  }
  revoke(grantId: string): void { this.revoked.add(grantId); }
  private gate(actor: string, e: Entry, reserve: boolean, grantId?: string): Grant {
    this.principal(actor); const { binding } = this.hashes(e), report = evaluateSnapshot(e.snapshot, e.draft.claim);
    if (!e.acceptance || e.acceptance.binding !== binding) fail('ACCEPTANCE_REQUIRED', 'Current exact acceptance required');
    if (report.truth !== 'True' || report.issues.length || report.reviewRequired) fail('SEMANTIC_GATE_DENIED', 'Claim has unresolved truth, issues or conflict');
    for (const review of e.draft.requiredReviews) if (e.approvals[review]?.binding !== binding) fail('REVIEW_REQUIRED', `Missing ${review}`);
    const now = this.clock();
    const g = this.config.grants.find(g => (!grantId || g.id === grantId) && !this.revoked.has(g.id) && g.actor === actor && g.domain === e.draft.domain && g.action === e.draft.action
      && g.purpose === e.draft.purpose && g.recipient === e.draft.recipient && g.destination === e.draft.destination
      && e.draft.fields.every(f => g.fields.includes(f)) && now < g.validUntil
      && (!reserve || (this.reservations.get(g.id) ?? 0) < g.maxActions));
    if (!g) fail('EFFECT_NOT_GRANTED', 'No current scoped grant/budget');
    if (!Object.hasOwn(this.config.adapters, e.draft.action)) fail('UNSUPPORTED_ACTION', 'No declared adapter');
    return g;
  }
  private receipt(raw: unknown, a: Attempt): Receipt {
    const r = object(raw, ['requestHash','status','output']);
    if (r.requestHash !== a.request.requestHash || !['Succeeded','Failed'].includes(String(r.status))) fail('INVALID_RECEIPT', 'Receipt request binding/status mismatch');
    hashValue(r.output);
    if (!r.output || typeof r.output !== 'object' || Array.isArray(r.output)) fail('INVALID_RECEIPT', 'Object output required');
    return freeze(structuredClone(r as unknown as Receipt));
  }
  private async bounded<T>(call: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => {
      timer=setTimeout(()=>reject(new Error('capability timeout')),this.config.timeoutMs);
    })]); } finally { if(timer) clearTimeout(timer); }
  }
  private async settle(e: Entry, a: Attempt, raw: unknown): Promise<Record<string, unknown>> {
    try {
      const receipt = this.receipt(raw, a);
      const verified = receipt.status === 'Succeeded' && await this.bounded(() => a.adapter.verify(a.request, receipt)) === true;
      a.result = { status: receipt.status === 'Failed' ? 'Failed' : verified ? 'Succeeded' : 'Unknown', request: a.request, receipt, verified,
        issues: receipt.status === 'Succeeded' && !verified ? ['OUTCOME_UNCONFIRMED'] : [] };
      // A success receipt without verification remains pending and cannot be retried.
      e.busy = a.result.status === 'Unknown'; this.event(e, `Receipt:${a.result.status}`, a.actor);
    } catch { a.result = { status: 'Unknown', request: a.request, verified: false, issues: ['INVALID_OR_UNVERIFIED_RECEIPT'] }; e.busy = true; }
    return freeze(structuredClone(a.result));
  }
  async execute(actor: string, id: string, binding: string, key: string): Promise<Record<string, unknown>> {
    text(key); const e = this.entry(id); this.principal(actor);
    if (binding !== this.hashes(e).binding) fail('STALE_BINDING', 'Execution must bind current version');
    const prior = this.attempts.get(key);
    if (prior) {
      if (prior.actor !== actor || prior.binding !== binding) fail('IDEMPOTENCY_CONFLICT', 'Key reused for another request');
      return freeze(structuredClone(prior.result));
    }
    this.editable(e); const g = this.gate(actor, e, true), h = this.hashes(e);
    const body = { contractHash: h.contractHash, snapshotHash: h.snapshotHash, action: e.draft.action, purpose: e.draft.purpose,
      fields: e.draft.fields, recipient: e.draft.recipient!, destination: e.draft.destination };
    const request: ExecutionRequest = freeze({ ...body, idempotencyKey: key, requestHash: hashValue({ ...body, binding, actor, grant: g.id, key }) });
    const adapter = this.config.adapters[e.draft.action];
    const a: Attempt = { actor, binding, grantId: g.id, adapter, request, result: { status: 'Pending', request, verified: false } };
    // No await between final policy check and reservation/adapter invocation.
    this.gate(actor, e, true, g.id); e.busy = true; this.reservations.set(g.id, (this.reservations.get(g.id) ?? 0) + 1);
    this.attempts.set(key, a); this.event(e, 'Execute', actor);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([Promise.resolve().then(() => { this.gate(actor, e, false, g.id); return adapter.execute(request); }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), this.config.timeoutMs);
      })]);
      return await this.settle(e, a, raw);
    } catch {
      a.result = { status: 'Unknown', request, verified: false, issues: ['OUTCOME_UNCONFIRMED'] }; e.busy = true;
      this.event(e, 'ExecutionUnknown', actor); return freeze(structuredClone(a.result));
    } finally { if (timer) clearTimeout(timer); }
  }
  async reconcile(actor: string, id: string, binding: string, key: string): Promise<Record<string, unknown>> {
    const e = this.entry(id); this.principal(actor); const a = this.attempts.get(key);
    if (!a || a.actor !== actor || a.binding !== binding || binding !== this.hashes(e).binding) fail('IDEMPOTENCY_CONFLICT', 'No matching attempt');
    if (a.result.status === 'Pending') fail('EXECUTION_PENDING', 'Wait for initial attempt');
    if (a.result.status !== 'Unknown') return freeze(structuredClone(a.result));
    if (!a.adapter.reconcile) fail('RECONCILIATION_UNAVAILABLE', 'No host reconciliation capability');
    if (a.reconciling) fail('RECONCILIATION_PENDING', 'An attempt has only one reconciliation in flight');
    a.reconciling = true;
    // Timeout only stops waiting; keep the single-flight lock until the underlying call ends.
    let underlyingDone = false, settlementDone = false;
    const release = () => { if (underlyingDone && settlementDone) a.reconciling = false; };
    const underlying = Promise.resolve().then(() => a.adapter.reconcile!(a.request));
    underlying.then(() => { underlyingDone = true; release(); }, () => { underlyingDone = true; release(); });
    try { return await this.settle(e, a, await this.bounded(() => underlying)); }
    catch { return freeze(structuredClone(a.result)); }
    finally { settlementDone = true; release(); }
  }
}
