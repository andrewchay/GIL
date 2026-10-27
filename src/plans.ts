import { GilError } from './ast.ts';
import type { Linked } from './ast.ts';
import { contentHash } from './canonical.ts';
import type { BoundPlan, Scope } from './delegation-ast.ts';
import { resolvedHash } from './exchange.ts';
import { hashValue } from './interpretation.ts';
import type { Session } from './interpretation-ast.ts';

const VERSION = 'gil-bound-plan-0.1';
const issued = new WeakMap<BoundPlan, { session: Session; seal: string; linkedSeal: string }>();
const fail = (code: string, message: string): never => { throw new GilError(code, message); };

/** Validate before JSON reflection: hashValue rejects Proxy, getters and unsafe keys. */
function copy<T>(value: T): T {
  hashValue(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Content checksum, not authority. sourceHash commits source id, version and text. */
export function planHash(plan: BoundPlan): string {
  const { hash: _hash, ...content } = copy(plan);
  return hashValue(content);
}

function acceptedResolution(session: Session): string {
  // Must be first: WeakMap provenance is checked before reading any Session property.
  const resolved = resolvedHash(session);
  const accepted = session.accepted;
  if (!accepted) fail('PLAN_NOT_ACCEPTED', 'The current Session snapshot must have an exact acceptance');
  if (accepted.interpretationHash !== session.interpretationHash || accepted.planHash !== session.planHash
      || accepted.resolvedHash !== resolved || hashValue(session.candidate.plan) !== session.planHash) {
    fail('STALE_PLAN_ACCEPTANCE', 'Acceptance must bind the current interpretation, template and resolution');
  }
  if (session.questions.some(question => !Object.hasOwn(session.answers, question.id))) {
    fail('UNRESOLVED_PLAN', 'Every open and ambiguous question must have an answer');
  }
  const latestAnswers = new Map<string, string>();
  for (const [index, event] of session.events.entries()) {
    const { id, ...content } = event;
    const parents = index ? [session.events[index - 1].id] : [];
    if (hashValue(content) !== id || hashValue(event.parents) !== hashValue(parents)) {
      fail('INVALID_PLAN_EVENT', 'Exchange events must preserve exact content hashes and parent references');
    }
    if (event.type === 'Answer' && event.payload.interpretationHash === session.interpretationHash
        && event.payload.planHash === session.planHash) {
      latestAnswers.set(event.payload.questionId as string, event.payload.value as string);
    }
  }
  if (session.questions.some(question => latestAnswers.get(question.id) !== session.answers[question.id])) {
    fail('INVALID_PLAN_EVENT', 'Resolved answers must reference matching Answer events');
  }
  const event = session.events.at(-1);
  const expected = { interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolved };
  if (!event || event.type !== 'Accept' || event.id !== accepted.eventId
      || hashValue(event.payload) !== hashValue(expected)
      || session.events.filter(item => item.id === accepted.eventId).length !== 1) {
    fail('INVALID_PLAN_EVENT', 'Acceptance must reference the final exact Accept event');
  }
  return resolved;
}

function template(value: unknown, parameters: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value;
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (!match) fail('INVALID_PLAN_TEMPLATE', 'Only whole-string ${name} references are supported; interpolation is forbidden');
    if (!Object.hasOwn(parameters, match[1])) fail('UNKNOWN_PLAN_PARAMETER', `Unknown plan parameter ${match[1]}`);
    const answer = parameters[match[1]];
    if (typeof answer === 'string' && answer.includes('${')) {
      fail('UNRESOLVED_PLAN_TEMPLATE', 'An answer cannot introduce an unresolved template reference');
    }
    return answer;
  }
  if (Array.isArray(value)) return value.map(item => template(item, parameters));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key.includes('${')) fail('INVALID_PLAN_TEMPLATE', 'Template references are not allowed in property names');
      return [key, template(item, parameters)];
    }));
  }
  return value;
}

function build(session: Session, linked: Linked, scope: Scope, requirementHash: string): BoundPlan {
  const resolved = acceptedResolution(session);
  const cleanLinked = copy(linked);
  const cleanScope = copy(scope);
  if (!cleanScope || typeof cleanScope !== 'object' || Array.isArray(cleanScope)
      || Object.keys(cleanScope).some(key => !['studyId', 'siteId', 'findingId'].includes(key))
      || !['studyId', 'siteId', 'findingId'].every(key => nonempty(cleanScope[key as keyof Scope]))) {
    fail('INVALID_PLAN_SCOPE', 'Scope requires nonempty studyId, siteId and findingId only');
  }
  if (!nonempty(requirementHash)) fail('INVALID_REQUIREMENT_HASH', 'requirementHash must be a nonempty string');
  if (session.answers.findingId !== cleanScope.findingId) fail('PLAN_SCOPE_MISMATCH', 'Scope findingId must match the resolved answer');
  for (const key of ['studyId', 'siteId'] as const) {
    if (Object.hasOwn(session.answers, key) && session.answers[key] !== cleanScope[key]) {
      fail('PLAN_SCOPE_MISMATCH', `Scope ${key} must match its resolved answer`);
    }
  }
  if (!nonempty(session.answers.applicableProtocolVersion)) {
    fail('MISSING_PROTOCOL_VERSION', 'A resolved applicableProtocolVersion is required');
  }
  const parameters: Record<string, unknown> = Object.fromEntries(session.questions.map(question => {
    const value = session.answers[question.id];
    return [question.target, question.kind === 'open' && question.type === 'Bool' ? value === 'true'
      : question.kind === 'open' && question.type === 'Int' ? Number(value) : value];
  }));
  const body = template(copy(session.candidate.plan), parameters) as Record<string, unknown>;
  for (const [key, value] of Object.entries({ applicableProtocolVersion: session.answers.applicableProtocolVersion, requirementHash })) {
    if (Object.hasOwn(body, key) && body[key] !== value) fail('PLAN_BODY_MISMATCH', `Plan body ${key} must match its binding`);
    body[key] = value;
  }
  for (const key of ['findingId', 'studyId', 'siteId'] as const) {
    if (Object.hasOwn(body, key) && body[key] !== cleanScope[key]) fail('PLAN_SCOPE_MISMATCH', `Plan body ${key} must match scope`);
  }
  const plan: BoundPlan = { kind: 'bound-plan', version: VERSION, hash: '', interpretationHash: session.interpretationHash,
    templateHash: session.planHash, resolvedHash: resolved, acceptanceEventId: session.accepted!.eventId,
    sourceHash: session.source.hash, scope: cleanScope, specHash: contentHash(cleanLinked.spec),
    ontologyHashes: Object.values(cleanLinked.ontologies).map(ontology => contentHash(ontology)).sort(), requirementHash, body };
  plan.hash = planHash(plan);
  return plan;
}

/** Agreement is not a Grant or real authentication. Old snapshots are historical branches. */
export function bindPlan(session: Session, linked: Linked, scope: Scope, requirementHash: string): BoundPlan {
  const plan = freeze(build(session, linked, scope, requirementHash));
  issued.set(plan, { session, seal: plan.hash, linkedSeal: hashValue(linked) });
  return plan;
}

/** JSON audit output cannot be imported as authority; only unchanged in-process plans work. */
export function validatePlan(plan: BoundPlan, linked: Linked): void {
  // WeakMap lookup precedes reflection, including for revoked or hostile Proxy objects.
  const record = issued.get(plan);
  if (!record) fail('UNTRUSTED_PLAN', 'Use a BoundPlan issued in this process; fabricated and deserialized plans are rejected');
  if (planHash(plan) !== record.seal || plan.hash !== record.seal) fail('PLAN_HASH_MISMATCH', 'Plan content does not match its issued seal');
  if (hashValue(linked) !== record.linkedSeal) fail('PLAN_LINK_MISMATCH', 'The exact linked spec and ontology content must match the issued plan');
  const expected = build(record.session, linked, plan.scope, plan.requirementHash);
  if (expected.hash !== plan.hash || hashValue(expected) !== hashValue(plan)) {
    fail('PLAN_HASH_MISMATCH', 'Plan must match its accepted Session, scope, requirements and linked artifacts');
  }
}
