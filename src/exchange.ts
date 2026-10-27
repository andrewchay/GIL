import { types } from 'node:util';
import { GilError } from './ast.ts';
import { hashValue, interpretationHash, validateInterpretation } from './interpretation.ts';
import type { ActorContext, Candidate, ExchangeEvent, GroundingContext, Question, Session, SourceArtifact } from './interpretation-ast.ts';

function fail(code: string, message: string): never { throw new GilError(code, message); }
const own = (value: object, key: string) => Object.hasOwn(value, key);

/** Only inert JSON data crosses this boundary: no accessors, prototypes or mutable aliases. */
function copy<T>(value: T): T {
  const seen = new Set<object>();
  function visit(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || input === null) return fail('EXCHANGE_INPUT', 'Expected finite JSON data');
    // Native detection must precede reflection: even getPrototypeOf can run a Proxy trap.
    if (types.isProxy(input)) return fail('EXCHANGE_INPUT', 'Proxy data is not trusted');
    if (seen.has(input)) return fail('EXCHANGE_INPUT', 'Cyclic data is not supported');
    const proto = Object.getPrototypeOf(input);
    if (Array.isArray(input) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      return fail('EXCHANGE_INPUT', 'Inherited data is not trusted');
    }
    seen.add(input);
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        return fail('EXCHANGE_INPUT', 'Unsafe JSON key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !own(descriptor, 'value')) return fail('EXCHANGE_INPUT', 'Accessors and hidden properties are not supported');
      entries.push([key, visit(descriptor.value)]);
    }
    let output: unknown;
    if (Array.isArray(input)) {
      if (entries.length !== input.length || entries.some(([key], index) => key !== String(index))) {
        return fail('EXCHANGE_INPUT', 'Expected a dense JSON array');
      }
      output = entries.map(([, item]) => item);
    } else output = Object.fromEntries(entries);
    seen.delete(input);
    return output;
  }
  return visit(value) as T;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// A Session is an opaque, in-process snapshot. JSON is audit output, not an import format.
// Adapters supply trusted simulated ActorContext; these flags are NOT real credentials.
const issued = new WeakMap<Session, { seal: string; grounding: GroundingContext }>();
function publish(session: Session, grounding: GroundingContext): Session {
  const snapshot = freeze(copy(session));
  issued.set(snapshot, { seal: hashValue(snapshot), grounding: freeze(copy(grounding)) });
  return snapshot;
}
function checkSession(session: Session): GroundingContext {
  const record = issued.get(session);
  if (!record || hashValue(copy(session)) !== record.seal) fail('UNTRUSTED_SESSION', 'Use an unchanged Session returned by exchange APIs; deserialized or fabricated sessions are rejected');
  return record.grounding;
}
function actor(context: ActorContext, permission?: 'mayAnswer' | 'mayAccept'): ActorContext {
  const result = copy(context);
  if (!result || typeof result.actorId !== 'string' || !result.actorId.trim() || !['human', 'agent'].includes(result.kind)
      || typeof result.mayAnswer !== 'boolean' || typeof result.mayAccept !== 'boolean') {
    fail('UNTRUSTED_ACTOR', 'An external adapter must supply a complete simulated actor context');
  }
  if (permission && (result.kind !== 'human' || result[permission] !== true)) {
    fail('ACTOR_FORBIDDEN', 'Only an explicitly permitted simulated human may answer or accept');
  }
  return result;
}
function append(events: ExchangeEvent[], type: ExchangeEvent['type'], actorId: string, payload: Record<string, unknown>): void {
  const content = { type, actorId, parents: events.length ? [events.at(-1)!.id] : [], payload: copy(payload) };
  events.push({ id: hashValue(content), ...content });
}
function questions(candidate: Candidate): Question[] {
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || !candidate.plan || typeof candidate.plan !== 'object' || Array.isArray(candidate.plan)
      || !candidate.affects || typeof candidate.affects !== 'object' || Array.isArray(candidate.affects)) {
    fail('INVALID_CANDIDATE', 'Candidate requires an id, plan object and explicit affects map');
  }
  const names = new Set<string>();
  // assume 是已声明的假设，不是待澄清问题；只有 open/ambiguous 进入问询队列。
  return candidate.interpretation.items.filter(item => item.kind !== 'ground' && item.kind !== 'assume').map(item => {
    if (item.kind === 'ground') return fail('INVALID_CANDIDATE', 'Unexpected grounding item');
    if (!item.name?.trim() || names.has(item.name)) fail('DUPLICATE_QUESTION', 'Question target names must be unique');
    names.add(item.name);
    const affects = own(candidate.affects, item.name) ? candidate.affects[item.name] : undefined;
    if (!Array.isArray(affects) || affects.length === 0 || affects.some(value => typeof value !== 'string' || !value.trim())
        || new Set(affects).size !== affects.length) {
      fail('MISSING_AFFECTS', `Question ${item.name} requires explicit nonempty affected scope`);
    }
    if (item.kind === 'open') {
      if (!['Text', 'Bool', 'Int'].includes(item.type)) fail('UNSUPPORTED_ANSWER_TYPE', `Unsupported open type ${item.type}`);
      return { id: item.name, target: item.name, kind: 'open', type: item.type, options: [], affects: [...affects] };
    }
    const options = item.candidates.map(path => path.join('.'));
    if (options.length < 2 || options.some(option => !option.trim()) || new Set(options).size !== options.length) {
      fail('INVALID_OPTIONS', `Question ${item.name} requires distinct explicit options`);
    }
    return { id: item.name, target: item.name, kind: 'ambiguous', options, affects: [...affects] };
  });
}
function proposal(source: SourceArtifact, candidate: Candidate, context: GroundingContext): Omit<Session, 'events'> {
  const cleanSource = copy(source);
  const cleanCandidate = copy(candidate);
  const cleanContext = copy(context);
  if (!cleanSource || typeof cleanSource !== 'object' || Array.isArray(cleanSource)
      || typeof cleanSource.id !== 'string' || typeof cleanSource.version !== 'string'
      || typeof cleanSource.text !== 'string' || typeof cleanSource.hash !== 'string') {
    fail('INVALID_SOURCE', 'Expected a complete source artifact');
  }
  if (!cleanCandidate || typeof cleanCandidate !== 'object' || Array.isArray(cleanCandidate)) {
    fail('INVALID_CANDIDATE', 'Expected a candidate object');
  }
  // validateInterpretation validates the content-addressed source catalog and exact source text.
  const diagnostics = validateInterpretation(cleanCandidate.interpretation, cleanContext);
  if (diagnostics.length) fail(diagnostics[0].code, diagnostics.map(item => item.message).join('; '));
  const matches = cleanContext.sources.filter(item => item.id === cleanSource.id && item.version === cleanSource.version);
  if (matches.length !== 1 || hashValue(matches[0]) !== hashValue(cleanSource)
      || cleanCandidate.interpretation.sourceText !== cleanSource.text) {
    fail('SOURCE_MISMATCH', 'Session source must match the validated catalog and interpretation text');
  }
  // This profile binds one source artifact in resolvedHash, not a multi-source catalog.
  if (cleanCandidate.interpretation.items.some(item => item.kind === 'ground' && item.source.artifactId !== cleanSource.id)) {
    fail('SOURCE_MISMATCH', 'All ground spans must reference the session source artifact');
  }
  return { source: cleanSource, candidate: cleanCandidate, interpretationHash: interpretationHash(cleanCandidate.interpretation),
    planHash: hashValue(cleanCandidate.plan), questions: questions(cleanCandidate), answers: {} };
}
function proposeEvents(session: Omit<Session, 'events'>, events: ExchangeEvent[], actorId: string): void {
  append(events, 'Propose', actorId, { source: session.source, candidate: session.candidate,
    interpretationHash: session.interpretationHash, planHash: session.planHash });
  for (const question of session.questions) append(events, 'Clarify', actorId, { question });
}

export function startSession(source: SourceArtifact, candidate: Candidate, actorContext: ActorContext, groundingContext: GroundingContext): Session {
  const author = actor(actorContext);
  const session = proposal(source, candidate, groundingContext);
  const events: ExchangeEvent[] = [];
  proposeEvents(session, events, author.actorId);
  return publish({ ...session, events }, groundingContext);
}

/** Text: non-whitespace; Bool: exact true/false; Int: canonical safe base-10 integer. */
export function answer(session: Session, questionId: string, value: string, actorContext: ActorContext): Session {
  const grounding = checkSession(session);
  const author = actor(actorContext, 'mayAnswer');
  const question = session.questions.find(item => item.id === questionId);
  if (!question) fail('UNKNOWN_QUESTION', `Unknown question ${questionId}`);
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ANSWER', 'Answer must be a nonempty string');
  if (question.kind === 'ambiguous') {
    if (!question.options.includes(value)) fail('INVALID_ANSWER', 'Answer must be one of the exact options');
  } else if (question.type === 'Bool') {
    if (value !== 'true' && value !== 'false') fail('INVALID_ANSWER', 'Bool uses exact true or false');
  } else if (question.type === 'Int') {
    if (!/^(0|-?[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_ANSWER', 'Int uses a canonical safe base-10 integer');
  } else if (question.type !== 'Text') fail('UNSUPPORTED_ANSWER_TYPE', 'Unknown open answer type');
  const next = copy(session);
  next.answers = Object.fromEntries([...Object.entries(next.answers).filter(([key]) => key !== questionId), [questionId, value]]);
  delete next.accepted;
  append(next.events, 'Answer', author.actorId, { questionId, value, interpretationHash: next.interpretationHash, planHash: next.planHash });
  return publish(next, grounding);
}

export function resolvedHash(session: Session): string {
  checkSession(session);
  return hashValue({ source: session.source, interpretationHash: session.interpretationHash, planHash: session.planHash,
    questions: session.questions, answers: session.answers });
}

/**
 * Accept records exact-content agreement only. It never authorizes an action.
 * Old snapshots remain usable as historical branches; accepting one does not make
 * it the current candidate. The caller tracks its current snapshot explicitly.
 */
export function accept(session: Session, expected: { interpretationHash: string; planHash: string; resolvedHash: string }, actorContext: ActorContext): Session {
  const grounding = checkSession(session);
  const author = actor(actorContext, 'mayAccept');
  const exact = copy(expected);
  if (session.questions.some(question => !own(session.answers, question.id))) fail('UNRESOLVED_SESSION', 'All open and ambiguous questions must be answered before acceptance');
  const resolved = resolvedHash(session);
  if (!exact || exact.interpretationHash !== session.interpretationHash || exact.planHash !== session.planHash || exact.resolvedHash !== resolved) {
    fail('STALE_ACCEPTANCE', 'Acceptance must bind the current interpretation, plan and resolved hashes');
  }
  const next = copy(session);
  append(next.events, 'Accept', author.actorId, { interpretationHash: next.interpretationHash, planHash: next.planHash, resolvedHash: resolved });
  next.accepted = { interpretationHash: next.interpretationHash, planHash: next.planHash, resolvedHash: resolved, eventId: next.events.at(-1)!.id };
  return publish(next, grounding);
}

export function revise(session: Session, newCandidate: Candidate, actorContext: ActorContext, groundingContext: GroundingContext): Session {
  checkSession(session);
  const author = actor(actorContext);
  const next = proposal(session.source, newCandidate, groundingContext);
  const events = copy(session.events);
  proposeEvents(next, events, author.actorId);
  return publish({ ...next, events }, groundingContext);
}
