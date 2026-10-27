import test from 'node:test';
import assert from 'node:assert/strict';
import { GilError } from '../src/ast.ts';
import { hashValue } from '../src/interpretation.ts';
import { startSession, answer, accept, resolvedHash, revise } from '../src/exchange.ts';
import type { ActorContext, Candidate, GroundingContext, Session, SourceArtifact } from '../src/interpretation-ast.ts';

const human: ActorContext = { actorId: 'simulated-human', kind: 'human', mayAnswer: true, mayAccept: true };
const agent: ActorContext = { actorId: 'simulated-agent', kind: 'agent', mayAnswer: true, mayAccept: true };
const error = (code: string) => (err: unknown) => err instanceof GilError && err.code === code;
function fixture(type = 'Text') {
  const body = { id: 'training-request', version: '1', text: 'Resolve the training finding.' };
  const source: SourceArtifact = { ...body, hash: hashValue(body) };
  const candidate: Candidate = { id: 'candidate-1', interpretation: { kind: 'interpretation', name: 'Training', sourceText: source.text,
    imports: [{ name: 'Training@1', alias: 'Training' }], items: [{ kind: 'open', name: 'deadline', type },
      { kind: 'ambiguous', name: 'scope', candidates: [['Training', 'Review'], ['Training', 'Submit']] }] },
    plan: { operation: 'suggest-remediation', authorization: 'not-implemented' },
    affects: { deadline: ['remediation.schedule'], scope: ['remediation.operation'] } };
  const grounding: GroundingContext = { sources: [source], references: ['Training.Review', 'Training.Submit'], types: ['Text', 'Bool', 'Int'] };
  return { source, candidate, grounding };
}
function start(type = 'Text') {
  const f = fixture(type);
  return startSession(f.source, f.candidate, agent, f.grounding);
}
const expected = (session: Session) => ({ interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolvedHash(session) });
const complete = (session = start()) => answer(answer(session, 'deadline', '2026-11-01', human), 'scope', 'Training.Review', human);

test('A17/A24: explicit open and ambiguity Clarify scopes block unresolved acceptance', () => {
  const session = start();
  assert.deepEqual(session.events.map(event => event.type), ['Propose', 'Clarify', 'Clarify']);
  assert.deepEqual(session.questions.map(question => question.affects), [['remediation.schedule'], ['remediation.operation']]);
  assert.deepEqual(session.answers, {});
  assert.throws(() => accept(session, expected(session), human), error('UNRESOLVED_SESSION'));
  const partial = answer(session, 'deadline', '2026-11-01', human);
  assert.throws(() => accept(partial, expected(partial), human), error('UNRESOLVED_SESSION'));
  assert.throws(() => answer(partial, 'scope', 'Training.Close', human), error('INVALID_ANSWER'));
});

test('A25: agents never answer or accept even when simulated flags are true', () => {
  assert.throws(() => answer(start(), 'deadline', 'tomorrow', agent), error('ACTOR_FORBIDDEN'));
  const session = complete();
  assert.throws(() => accept(session, expected(session), agent), error('ACTOR_FORBIDDEN'));
  assert.throws(() => answer(session, 'deadline', 'tomorrow', { ...human, mayAnswer: false }), error('ACTOR_FORBIDDEN'));
  assert.throws(() => accept(session, expected(session), { ...human, mayAccept: false }), error('ACTOR_FORBIDDEN'));
});

test('acceptance binds all three hashes; changed answers clear acceptance and preserve history', () => {
  const session = complete();
  for (const key of ['interpretationHash', 'planHash', 'resolvedHash'] as const) {
    assert.throws(() => accept(session, { ...expected(session), [key]: 'sha256:stale' }, human), error('STALE_ACCEPTANCE'));
  }
  const accepted = accept(session, expected(session), human);
  assert.equal(accepted.accepted?.eventId, accepted.events.at(-1)!.id);
  assert.equal(accepted.candidate.plan.authorization, 'not-implemented');
  const changed = answer(accepted, 'deadline', '2026-11-02', human);
  assert.equal(changed.accepted, undefined);
  assert.ok(accepted.accepted);
  assert.deepEqual(changed.events.slice(0, accepted.events.length), accepted.events);
  assert.notEqual(resolvedHash(changed), resolvedHash(accepted));
  assert.throws(() => accept(changed, expected(accepted), human), error('STALE_ACCEPTANCE'));
});

test('content-addressed event parents and divergent answers retain immutable old histories', () => {
  const session = start();
  const a = answer(session, 'deadline', 'Monday', human);
  const b = answer(session, 'deadline', 'Tuesday', human);
  assert.notEqual(a.events.at(-1)!.id, b.events.at(-1)!.id);
  assert.equal(session.events.length, 3);
  for (const snapshot of [a, b]) {
    snapshot.events.forEach((event, index) => {
      const { id, ...content } = event;
      assert.equal(id, hashValue(content));
      assert.deepEqual(event.parents, index ? [snapshot.events[index - 1].id] : []);
    });
  }
});

test('Text, Bool and Int answers enforce exact nonempty canonical string conventions', () => {
  assert.throws(() => answer(start(), 'deadline', '  ', human), error('INVALID_ANSWER'));
  assert.throws(() => answer(start(), 'absent', 'x', human), error('UNKNOWN_QUESTION'));
  const bool = start('Bool');
  for (const value of ['True', '0', ' true ']) assert.throws(() => answer(bool, 'deadline', value, human), error('INVALID_ANSWER'));
  for (const value of ['true', 'false']) assert.equal(answer(bool, 'deadline', value, human).answers.deadline, value);
  const int = start('Int');
  for (const value of ['01', '-0', '+1', '1.0', '1e2', '9007199254740992']) assert.throws(() => answer(int, 'deadline', value, human), error('INVALID_ANSWER'));
  for (const value of ['0', '-1', '9007199254740991']) assert.equal(answer(int, 'deadline', value, human).answers.deadline, value);
  assert.throws(() => start('Date'), (err: unknown) => err instanceof GilError);
});

test('questions need unique names and explicit nonempty affects, never silent empty scope', () => {
  for (const affects of [{}, { deadline: [] }, { deadline: [''] }]) {
    const f = fixture();
    f.candidate.affects = { scope: ['remediation.operation'], ...affects };
    assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), error('MISSING_AFFECTS'));
  }
  const f = fixture();
  f.candidate.interpretation.items.push({ kind: 'open', name: 'deadline', type: 'Text' });
  assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), (err: unknown) => err instanceof GilError);
});

test('forged source hashes or catalogs and interpretation/source mismatches are rejected', () => {
  const f = fixture();
  f.source.hash = 'sha256:forged';
  assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), (err: unknown) => err instanceof GilError);
  const another = fixture();
  const stale = { ...another.source, text: 'Changed source' };
  assert.throws(() => startSession(stale, another.candidate, agent, another.grounding), (err: unknown) => err instanceof GilError);
});

test('snapshot deep cloning and freezing prevent source, answer, plan and event mutation', () => {
  const f = fixture();
  const session = startSession(f.source, f.candidate, agent, f.grounding);
  f.source.text = 'mutated';
  f.candidate.plan.operation = 'close';
  f.candidate.affects.deadline.push('close');
  f.grounding.references.push('Training.Close');
  assert.equal(session.source.text, 'Resolve the training finding.');
  assert.equal(session.candidate.plan.operation, 'suggest-remediation');
  assert.throws(() => { session.answers.deadline = 'forged'; }, TypeError);
  assert.throws(() => { session.events[0].payload.candidate = {}; }, TypeError);
  assert.throws(() => { session.questions[0].affects.push('close'); }, TypeError);
  assert.throws(() => { session.candidate.plan.operation = 'close'; }, TypeError);
});

test('fabricated accepted caches, altered answers/events and inherited session/actor values are rejected', () => {
  const valid = complete();
  for (const forged of [structuredClone(valid), { ...valid, answers: { deadline: 'forged', scope: 'Training.Review' } },
    { ...valid, events: [] }, { ...valid, accepted: { ...expected(valid), eventId: 'fake' } }, Object.create(valid)]) {
    assert.throws(() => resolvedHash(forged), error('UNTRUSTED_SESSION'));
    assert.throws(() => accept(forged, expected(valid), human), error('UNTRUSTED_SESSION'));
  }
  assert.throws(() => answer(valid, 'deadline', 'tomorrow', Object.create(human)), error('EXCHANGE_INPUT'));
  const f = fixture();
  f.candidate.affects = Object.create({ deadline: ['close'], scope: ['close'] });
  assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), error('EXCHANGE_INPUT'));
  const dangerous = fixture();
  dangerous.candidate.plan = JSON.parse('{"__proto__":{"mayAccept":true}}');
  assert.throws(() => startSession(dangerous.source, dangerous.candidate, agent, dangerous.grounding), error('EXCHANGE_INPUT'));
});

test('revise adds Propose/Clarify, keeps old accepted history and resets every answer and acceptance', () => {
  const resolved = complete();
  const previous = accept(resolved, expected(resolved), human);
  const f = fixture();
  f.candidate.id = 'candidate-2';
  f.candidate.plan.operation = 'suggest-only';
  const revised = revise(previous, f.candidate, agent, f.grounding);
  assert.deepEqual(revised.answers, {});
  assert.equal(revised.accepted, undefined);
  assert.deepEqual(revised.events.slice(0, previous.events.length), previous.events);
  assert.deepEqual(revised.events.slice(previous.events.length).map(event => event.type), ['Propose', 'Clarify', 'Clarify']);
  assert.deepEqual(revised.events[previous.events.length].parents, [previous.events.at(-1)!.id]);
  assert.notEqual(revised.planHash, previous.planHash);
  assert.throws(() => accept(revised, expected(previous), human), error('UNRESOLVED_SESSION'));
  assert.ok(previous.accepted);
  const completedRevision = complete(revised);
  assert.throws(() => accept(completedRevision, expected(previous), human), error('STALE_ACCEPTANCE'));
  const unchanged = revise(previous, previous.candidate, agent, f.grounding);
  assert.deepEqual(unchanged.answers, {});
  assert.equal(unchanged.accepted, undefined);
});

test('malformed candidates and accessor inputs fail with GilError without running getters', () => {
  const f = fixture();
  assert.throws(() => startSession(f.source, null as unknown as Candidate, agent, f.grounding), error('INVALID_CANDIDATE'));
  f.candidate.id = 1 as unknown as string;
  assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), error('INVALID_CANDIDATE'));
  let invoked = false;
  const getterActor = { ...human };
  Object.defineProperty(getterActor, 'mayAnswer', { enumerable: true, get() { invoked = true; return true; } });
  assert.throws(() => answer(start(), 'deadline', 'tomorrow', getterActor), error('EXCHANGE_INPUT'));
  assert.equal(invoked, false);
});

test('Proxy inputs are rejected before reflection and never execute traps', () => {
  let traps = 0;
  const trap = (): never => { traps++; throw new Error('Proxy trap must not execute'); };
  const wrap = <T extends object>(value: T): T => new Proxy(value, {
    get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap,
  });
  const f = fixture();
  const session = complete();
  const attempts = [
    () => startSession(wrap(f.source), f.candidate, agent, f.grounding),
    () => startSession(f.source, wrap(f.candidate), agent, f.grounding),
    () => startSession(f.source, f.candidate, wrap(agent), f.grounding),
    () => startSession(f.source, f.candidate, agent, wrap(f.grounding)),
    () => startSession(f.source, { ...f.candidate, plan: { nested: wrap({ operation: 'close' }) } }, agent, f.grounding),
    () => startSession(f.source, f.candidate, agent, { ...f.grounding, sources: wrap(f.grounding.sources) }),
    () => answer(session, 'deadline', 'tomorrow', wrap(human)),
    () => accept(session, wrap(expected(session)), human),
    () => revise(session, wrap(f.candidate), agent, f.grounding),
  ];
  for (const attempt of attempts) assert.throws(attempt, error('EXCHANGE_INPUT'));
  assert.throws(() => resolvedHash(wrap(session)), error('UNTRUSTED_SESSION'));
  const revoked = Proxy.revocable(f.source, {});
  revoked.revoke();
  assert.throws(() => startSession(revoked.proxy, f.candidate, agent, f.grounding), error('EXCHANGE_INPUT'));
  assert.equal(traps, 0);
});

test('single-source grounding rejects same-text A/B references, including after B version changes', () => {
  const f = fixture();
  const body = { id: 'source-B', version: '1', text: f.source.text };
  const b: SourceArtifact = { ...body, hash: hashValue(body) };
  f.grounding.sources.push(b);
  const baseline = startSession(f.source, f.candidate, agent, f.grounding);
  f.candidate.interpretation.items.push({ kind: 'ground', source: { artifactId: b.id, start: 0, end: 7 },
    target: { kind: 'ref', path: ['Training', 'Review'], next: false } });
  for (const version of ['1', '2']) {
    const changed = { ...body, version };
    f.grounding.sources[1] = { ...changed, hash: hashValue(changed) };
    assert.throws(() => startSession(f.source, f.candidate, agent, f.grounding), error('SOURCE_MISMATCH'));
    assert.throws(() => revise(baseline, f.candidate, agent, f.grounding), error('SOURCE_MISMATCH'));
  }
  const ground = f.candidate.interpretation.items.at(-1)!;
  if (ground.kind !== 'ground') assert.fail('Expected ground item');
  ground.source.artifactId = f.source.id;
  const bound = startSession(f.source, f.candidate, agent, f.grounding);
  const changedA = { id: f.source.id, version: '2', text: f.source.text };
  const sourceV2 = { ...changedA, hash: hashValue(changedA) };
  f.grounding.sources[0] = sourceV2;
  const rebound = startSession(sourceV2, f.candidate, agent, f.grounding);
  assert.notEqual(resolvedHash(bound), resolvedHash(rebound));
});

test('accepting an old snapshot is historical agreement, not current candidate authority', () => {
  const historical = complete();
  const f = fixture();
  f.candidate.id = 'new-current-candidate';
  f.candidate.plan.operation = 'suggest-new-plan';
  const current = revise(historical, f.candidate, agent, f.grounding);
  const currentEvents = structuredClone(current.events);
  const oldAccepted = accept(historical, expected(historical), human);
  assert.ok(oldAccepted.accepted);
  assert.equal(oldAccepted.candidate.id, historical.candidate.id);
  assert.equal(current.candidate.id, 'new-current-candidate');
  assert.equal(current.accepted, undefined);
  assert.deepEqual(current.answers, {});
  assert.deepEqual(current.events, currentEvents);
  assert.equal(current.candidate.plan.authorization, 'not-implemented');
});
