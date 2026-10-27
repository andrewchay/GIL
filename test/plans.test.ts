import test from 'node:test';
import assert from 'node:assert/strict';
import { GilError } from '../src/ast.ts';
import type { Linked } from '../src/ast.ts';
import type { BoundPlan, Scope } from '../src/delegation-ast.ts';
import type { ActorContext, Candidate, Session } from '../src/interpretation-ast.ts';
import { contentHash } from '../src/canonical.ts';
import { hashValue, sourceArtifact } from '../src/interpretation.ts';
import { startSession, answer, accept, resolvedHash, revise } from '../src/exchange.ts';
import { bindPlan, validatePlan, planHash } from '../src/plans.ts';

const human: ActorContext = { actorId: 'synthetic-human', kind: 'human', mayAnswer: true, mayAccept: true };
const agent: ActorContext = { actorId: 'synthetic-agent', kind: 'agent', mayAnswer: true, mayAccept: true };
const scope: Scope = { studyId: 'STUDY-1', siteId: 'SITE-1', findingId: 'FINDING-1' };
const requirementHash = hashValue({ protocolVersion: 'P3', training: true });
const error = (code: string) => (err: unknown) => err instanceof GilError && err.code === code;
const expected = (s: Session) => ({ interpretationHash: s.interpretationHash, planHash: s.planHash, resolvedHash: resolvedHash(s) });
function linked(): Linked {
  return { spec: { kind: 'spec', name: 'Training', version: '1', imports: [], context: [], input: [], state: [], goals: [], constraints: [], actions: [] },
    ontologies: { Z: { kind: 'ontology', name: 'Z', version: '2', concepts: [], relations: [] },
      A: { kind: 'ontology', name: 'A', version: '1', concepts: [], relations: [] } } };
}
function fixture(plan: Record<string, unknown> = { findingId: '${findingId}', applicableProtocolVersion: '${applicableProtocolVersion}',
  nested: { items: ['${count}', '${enabled}', '${operation}'] } }, version = '1', includeScope = false) {
  const source = sourceArtifact('REQUEST-1', version, 'Resolve training finding');
  const values = { findingId: scope.findingId, applicableProtocolVersion: 'P3', count: '2', enabled: 'false', operation: 'Clinical.Prepare',
    ...(includeScope ? { studyId: scope.studyId, siteId: scope.siteId } : {}) };
  const candidate: Candidate = { id: 'candidate', plan, interpretation: { kind: 'interpretation', name: 'Training', sourceText: source.text,
    imports: [{ name: 'Clinical@1', alias: 'Clinical' }], items: Object.keys(values).map(name => name === 'operation'
      ? { kind: 'ambiguous', name, candidates: [['Clinical', 'Prepare'], ['Clinical', 'Submit']] }
      : { kind: 'open', name, type: name === 'count' ? 'Int' : name === 'enabled' ? 'Bool' : 'Text' }) },
    affects: Object.fromEntries(Object.keys(values).map(name => [name, ['prepare']])) };
  const grounding = { sources: [source], references: ['Clinical.Prepare', 'Clinical.Submit'], types: ['Text', 'Bool', 'Int'] };
  const initial = startSession(source, candidate, agent, grounding);
  let completed = initial;
  for (const [id, value] of Object.entries(values)) completed = answer(completed, id, value, human);
  const accepted = accept(completed, expected(completed), human);
  return { initial, completed, accepted, candidate, source, grounding };
}

test('bound plan commits acceptance, source version, spec, sorted ontologies and resolved typed body', () => {
  const f = fixture();
  const l = linked();
  const plan = bindPlan(f.accepted, l, scope, requirementHash);
  assert.equal(plan.kind, 'bound-plan');
  assert.equal(plan.interpretationHash, f.accepted.interpretationHash);
  assert.equal(plan.templateHash, f.accepted.planHash);
  assert.equal(plan.resolvedHash, resolvedHash(f.accepted));
  assert.equal(plan.sourceHash, f.source.hash);
  assert.equal(plan.specHash, contentHash(l.spec));
  assert.deepEqual(plan.ontologyHashes, Object.values(l.ontologies).map(contentHash).sort());
  assert.deepEqual(plan.body, { findingId: 'FINDING-1', applicableProtocolVersion: 'P3', nested: { items: [2, false, 'Clinical.Prepare'] }, requirementHash });
  assert.equal(plan.hash, planHash(plan));
  validatePlan(plan, l);
  validatePlan(plan, structuredClone(l));
});

test('stale acceptance, partial resolution, changed answers and revision cannot bind', () => {
  const f = fixture();
  for (const session of [f.initial, f.completed, answer(f.accepted, 'count', '3', human), revise(f.accepted, f.candidate, agent, f.grounding)]) {
    assert.throws(() => bindPlan(session, linked(), scope, requirementHash), error('PLAN_NOT_ACCEPTED'));
  }
  for (const key of ['interpretationHash', 'planHash', 'resolvedHash'] as const) {
    assert.throws(() => accept(f.completed, { ...expected(f.completed), [key]: 'stale' }, human), error('STALE_ACCEPTANCE'));
  }
  // Historical accepted snapshots remain valid branches; caller/gate owns the current pointer.
  validatePlan(bindPlan(f.accepted, linked(), scope, requirementHash), linked());
});

test('agents cannot supply Answer or Accept even with true permission flags', () => {
  const f = fixture();
  assert.throws(() => answer(f.initial, 'findingId', 'FINDING-1', agent), error('ACTOR_FORBIDDEN'));
  assert.throws(() => accept(f.completed, expected(f.completed), agent), error('ACTOR_FORBIDDEN'));
});

test('session provenance checked first: fabricated acceptance, tampered event references and JSON sessions rejected', () => {
  const f = fixture();
  const forged = structuredClone(f.accepted);
  forged.accepted!.eventId = 'fake';
  for (const session of [structuredClone(f.accepted), forged, { ...f.accepted, events: [] }, Object.create(f.accepted)]) {
    assert.throws(() => bindPlan(session, linked(), scope, requirementHash), error('UNTRUSTED_SESSION'));
  }
});

test('plans are deeply frozen and retain no mutable scope or linked alias', () => {
  const l = linked();
  const inputScope = { ...scope };
  const plan = bindPlan(fixture().accepted, l, inputScope, requirementHash);
  inputScope.findingId = 'OTHER';
  assert.equal(plan.scope.findingId, scope.findingId);
  assert.throws(() => { plan.hash = 'forged'; }, TypeError);
  assert.throws(() => { plan.body.requirementHash = 'changed'; }, TypeError);
  assert.throws(() => { plan.scope.findingId = 'changed'; }, TypeError);
  assert.throws(() => { (plan.body.nested as { items: unknown[] }).items.push('close'); }, TypeError);
  assert.throws(() => { plan.ontologyHashes.push('fake'); }, TypeError);
  l.spec.version = '2';
  assert.throws(() => validatePlan(plan, l), error('PLAN_LINK_MISMATCH'));
});

test('planHash is only a checksum: copied, inherited and recomputed forged plans cannot validate', () => {
  const plan = bindPlan(fixture().accepted, linked(), scope, requirementHash);
  const modified = structuredClone(plan);
  modified.body.nested = { items: ['close'] };
  modified.hash = planHash(modified);
  for (const fake of [structuredClone(plan), modified, Object.create(plan)]) {
    assert.throws(() => validatePlan(fake, linked()), error('UNTRUSTED_PLAN'));
  }
  assert.notEqual(modified.hash, plan.hash);
});

test('scope finding must match; optional question study/site must also match; malformed scopes fail', () => {
  const plain = fixture().accepted;
  assert.throws(() => bindPlan(plain, linked(), { ...scope, findingId: 'OTHER' }, requirementHash), error('PLAN_SCOPE_MISMATCH'));
  for (const malformed of [{ ...scope, siteId: '' }, { findingId: scope.findingId }, { ...scope, extra: true }, null]) {
    assert.throws(() => bindPlan(plain, linked(), malformed as Scope, requirementHash), error('INVALID_PLAN_SCOPE'));
  }
  const scoped = fixture(undefined, '1', true).accepted;
  for (const key of ['studyId', 'siteId'] as const) {
    assert.throws(() => bindPlan(scoped, linked(), { ...scope, [key]: 'OTHER' }, requirementHash), error('PLAN_SCOPE_MISMATCH'));
  }
  assert.throws(() => bindPlan(fixture({ findingId: 'OTHER' }).accepted, linked(), scope, requirementHash), error('PLAN_SCOPE_MISMATCH'));
});

test('requirements, protocol binding, scope and source revision change exact plan hashes', () => {
  const f = fixture();
  const first = bindPlan(f.accepted, linked(), scope, requirementHash);
  const nextRequirement = hashValue({ protocolVersion: 'P4', training: true });
  const changed = bindPlan(f.accepted, linked(), scope, nextRequirement);
  assert.equal(changed.body.requirementHash, nextRequirement);
  assert.notEqual(changed.hash, first.hash);
  assert.notEqual(bindPlan(f.accepted, linked(), { ...scope, siteId: 'SITE-2' }, requirementHash).hash, first.hash);
  const revisedSource = bindPlan(fixture(undefined, '2').accepted, linked(), scope, requirementHash);
  assert.notEqual(revisedSource.sourceHash, first.sourceHash);
  assert.notEqual(revisedSource.resolvedHash, first.resolvedHash);
  assert.notEqual(revisedSource.hash, first.hash);
  for (const bad of ['', ' ', undefined]) assert.throws(() => bindPlan(f.accepted, linked(), scope, bad as string), error('INVALID_REQUIREMENT_HASH'));
  for (const body of [{ applicableProtocolVersion: 'P9' }, { requirementHash: 'wrong' }]) {
    assert.throws(() => bindPlan(fixture(body).accepted, linked(), scope, requirementHash), error('PLAN_BODY_MISMATCH'));
  }
  const withoutProtocol = { ...f.candidate, interpretation: { ...f.candidate.interpretation,
    items: f.candidate.interpretation.items.filter(item => item.kind === 'ground' || item.name !== 'applicableProtocolVersion') } };
  let s = startSession(f.source, withoutProtocol, agent, f.grounding);
  for (const [id, value] of Object.entries(f.completed.answers)) if (id !== 'applicableProtocolVersion') s = answer(s, id, value, human);
  s = accept(s, expected(s), human);
  assert.throws(() => bindPlan(s, linked(), scope, requirementHash), error('MISSING_PROTOCOL_VERSION'));
});

test('cross-spec, changed ontology, alias changes and added ontology cannot validate old plan', () => {
  const f = fixture();
  const original = linked();
  const plan = bindPlan(f.accepted, original, scope, requirementHash);
  const otherSpec = linked(); otherSpec.spec.name = 'Other';
  const otherOntology = linked(); otherOntology.ontologies.A.version = '2';
  const renamed = linked(); renamed.ontologies.Other = renamed.ontologies.A; delete renamed.ontologies.A;
  const added = linked(); added.ontologies.Extra = { kind: 'ontology', name: 'Extra', version: '1', concepts: [], relations: [] };
  for (const l of [otherSpec, otherOntology, renamed, added]) assert.throws(() => validatePlan(plan, l), error('PLAN_LINK_MISMATCH'));
  assert.notEqual(bindPlan(f.accepted, otherSpec, scope, requirementHash).hash, plan.hash);
  assert.notEqual(bindPlan(f.accepted, otherOntology, scope, requirementHash).hash, plan.hash);
});

test('template rejects unknown, malformed, mixed interpolation, key references and answer-introduced references', () => {
  for (const token of ['prefix ${findingId}', '${findingId} suffix', '${findingId}${count}', '${}', '${findingId', '${a.b}']) {
    assert.throws(() => bindPlan(fixture({ nested: [token] }).accepted, linked(), scope, requirementHash), error('INVALID_PLAN_TEMPLATE'));
  }
  assert.throws(() => bindPlan(fixture({ value: '${unknown}' }).accepted, linked(), scope, requirementHash), error('UNKNOWN_PLAN_PARAMETER'));
  assert.throws(() => bindPlan(fixture({ '${findingId}': true }).accepted, linked(), scope, requirementHash), error('INVALID_PLAN_TEMPLATE'));
  const f = fixture();
  const s = answer(f.accepted, 'findingId', '${count}', human);
  const accepted = accept(s, expected(s), human);
  assert.throws(() => bindPlan(accepted, linked(), { ...scope, findingId: '${count}' }, requirementHash), error('UNRESOLVED_PLAN_TEMPLATE'));
});

test('acceptance event is exact final event with content-addressed history and matching Answer references', () => {
  const f = fixture();
  const second = accept(f.accepted, expected(f.accepted), human);
  const firstPlan = bindPlan(f.accepted, linked(), scope, requirementHash);
  const secondPlan = bindPlan(second, linked(), scope, requirementHash);
  assert.equal(firstPlan.acceptanceEventId, f.accepted.events.at(-1)!.id);
  assert.equal(secondPlan.acceptanceEventId, second.events.at(-1)!.id);
  assert.notEqual(firstPlan.acceptanceEventId, secondPlan.acceptanceEventId);
  assert.notEqual(firstPlan.hash, secondPlan.hash);
  for (const [index, event] of second.events.entries()) {
    const { id, ...content } = event;
    assert.equal(id, hashValue(content));
    assert.deepEqual(event.parents, index ? [second.events[index - 1].id] : []);
  }
});

test('unsafe JSON boundaries reject getters and Proxy before reflection without invoking traps', () => {
  const session = fixture().accepted;
  const plan = bindPlan(session, linked(), scope, requirementHash);
  let traps = 0;
  const trap = (): never => { traps++; throw new Error('must not execute'); };
  const wrap = <T extends object>(value: T): T => new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  assert.throws(() => bindPlan(wrap(session), linked(), scope, requirementHash), error('UNTRUSTED_SESSION'));
  assert.throws(() => bindPlan(session, wrap(linked()), scope, requirementHash), error('CANONICAL_ERROR'));
  assert.throws(() => bindPlan(session, linked(), wrap(scope), requirementHash), error('CANONICAL_ERROR'));
  assert.throws(() => validatePlan(wrap(plan), linked()), error('UNTRUSTED_PLAN'));
  assert.throws(() => validatePlan(plan, wrap(linked())), error('CANONICAL_ERROR'));
  assert.throws(() => planHash(wrap(plan)), error('CANONICAL_ERROR'));
  const getterLinked = linked();
  Object.defineProperty(getterLinked.spec, 'name', { enumerable: true, get: trap });
  assert.throws(() => bindPlan(session, getterLinked, scope, requirementHash), error('CANONICAL_ERROR'));
  const getterScope = { ...scope };
  Object.defineProperty(getterScope, 'findingId', { enumerable: true, get: trap });
  assert.throws(() => bindPlan(session, linked(), getterScope, requirementHash), error('CANONICAL_ERROR'));
  const revoked = Proxy.revocable(plan, {}); revoked.revoke();
  assert.throws(() => validatePlan(revoked.proxy as BoundPlan, linked()), error('UNTRUSTED_PLAN'));
  assert.equal(traps, 0);
});
