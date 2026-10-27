import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Expr, Linked, Spec, Ontology, Action } from '../src/ast.ts';
import { GilError } from '../src/ast.ts';
import { parse } from '../src/parser.ts';
import { link } from '../src/checker.ts';
import { evaluate, unknown, isUnknown, initialize, simulate, monitor } from '../src/runtime.ts';
import type { State } from '../src/runtime.ts';

const lit = (value: string | boolean | number): Expr => ({ kind: 'literal', value });
const ref = (name: string, next = false): Expr => ({ kind: 'ref', path: name.split('.'), next });
const bin = (op: string, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const empty = (): Linked => ({ spec: { kind: 'spec', name: 'test', version: '1', imports: [], context: [], input: [], state: [], goals: [], constraints: [], actions: [] }, ontologies: {} });
const error = (code: string) => (err: unknown) => err instanceof GilError && err.code === code;
const call = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', path: name.split('.'), args });
const values = [true, false, unknown('unknown input')];
const symbol = (value: unknown) => isUnknown(value) ? 'U' : value === true ? 'T' : 'F';

test('Strong Kleene complete truth tables: and/or/implication/not', () => {
  const tables: Record<string, string[]> = {
    '&&': ['TFU', 'FFF', 'UFU'],
    '||': ['TTT', 'TFU', 'TUU'],
    '=>': ['TFU', 'TTT', 'TUU'],
  };
  for (const [op, rows] of Object.entries(tables)) {
    values.forEach((a, i) => values.forEach((b, j) => {
      const result = evaluate(bin(op, ref('a'), ref('b')), empty(), { state: { a, b } });
      assert.equal(symbol(result), rows[i][j], `${symbol(a)} ${op} ${symbol(b)}`);
    }));
  }
  assert.deepEqual(values.map(a => symbol(evaluate({ kind: 'unary', op: '!', arg: ref('a') }, empty(), { state: { a } }))), ['F', 'T', 'U']);
  assert.deepEqual(JSON.parse(JSON.stringify(unknown('coverage gap'))), { kind: 'unknown', reason: 'coverage gap' });
});

test('partial refs are Unknown, but malformed types and operators throw GilError', () => {
  assert.ok(isUnknown(evaluate(ref('absent'), empty(), { state: {} })));
  assert.ok(isUnknown(evaluate(ref('partial.field'), empty(), { state: { partial: {} } })));
  assert.throws(() => evaluate(ref('text.field'), empty(), { state: { text: 'not a record' } }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(bin('+', lit('2'), lit(3)), empty(), { state: {} }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(bin('&&', lit(false), lit('invalid')), empty(), { state: {} }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(bin('==', lit('2'), lit(2)), empty(), { state: {} }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(bin('/', lit(2), lit(0)), empty(), { state: {} }), error('ARITHMETIC_ERROR'));
  assert.throws(() => evaluate(bin('???', lit(1), lit(1)), empty(), { state: {} }), error('UNSUPPORTED_PROFILE'));
  assert.equal(evaluate(bin('+', lit(2), lit(3)), empty(), { state: {} }), 5);
  assert.equal(evaluate(bin('<', lit(2), lit(3)), empty(), { state: {} }), true);
  assert.ok(isUnknown(evaluate(bin('==', ref('a'), ref('b')), empty(), { state: { a: { field: unknown('missing') }, b: { field: unknown('missing') } } })));
  assert.throws(() => evaluate(bin('<', ref('a'), lit('invalid')), empty(), { state: { a: unknown('missing') } }), error('TYPE_ERROR'));
});

function clinical(): Linked {
  const folder = new URL('../docs/clinical-operations/monitoring-remediation/', import.meta.url);
  const spec = parse(readFileSync(new URL('workflow.gil', folder), 'utf8')) as Spec;
  const ontology = parse(readFileSync(new URL('ontology.gil', folder), 'utf8')) as Ontology;
  return link(spec, [ontology]);
}
const requirement: State = {
  requirementId: 'REQ-DEMO', contentHash: 'REQ-H1', studyId: 'STUDY-DEMO', siteId: 'SITE-DEMO',
  findingId: 'FINDING-DEMO', staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3',
};
const evidence: State = {
  bundleId: 'E-DEMO', contentHash: 'E-H1', requirementHash: 'REQ-H1', studyId: 'STUDY-DEMO', siteId: 'SITE-DEMO',
  findingId: 'FINDING-DEMO', staffId: 'STAFF-DEMO', protocolVersion: 'PROTOCOL-V3',
  complete: true, readable: true, authenticityEstablished: true, policyChecksPass: true,
};
const inputs: State = { stagedEvidence: evidence, blockingItemsResolved: true, reviewStillValid: true, evaluatedReviewHash: 'REVIEW-H1' };
function step(linked: Linked, state: State, name: string, params: State = {}, input: State = inputs): State {
  const before = structuredClone(state);
  const result = simulate(linked, state, input, name, params);
  assert.deepEqual(state, before);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected simulation success');
  assert.equal(result.authorization, 'not-implemented');
  return result.state;
}

test('clinical full Core path: explicit requirement, accept, submit, review, close', () => {
  const linked = clinical();
  assert.ok(isUnknown(initialize(linked).requirement));
  let state = initialize(linked, { requirement });
  assert.equal(state.phase, 'OPEN');
  assert.notEqual(state.requirement, requirement);
  state = step(linked, state, 'recordAcceptedPlan', { planHash: 'PLAN-H1' });
  assert.equal(state.phase, 'IN_REMEDIATION');
  state = step(linked, state, 'submitEvidence');
  assert.equal(state.phase, 'SUBMITTED');
  assert.equal(state.activeReviewHash, '');
  state = step(linked, state, 'recordReviewPass');
  assert.equal(state.phase, 'REVIEWED');
  assert.equal(state.activeReviewHash, 'REVIEW-H1');
  state = step(linked, state, 'closeFinding');
  assert.equal(state.phase, 'CLOSED');
  const result = monitor(linked, state, inputs);
  assert.equal(result.semantics, 'finite-prefix');
  assert.equal(result.goals[0].value, true);
  assert.ok(result.constraints.every(c => isUnknown(c.value) && c.current === true));
});

test('relation purity, Unknown missing fields, type validation, old version False', () => {
  const linked = clinical();
  const before = structuredClone(evidence);
  const expr = call('C.evidenceReady', ref('stagedEvidence'), ref('requirement'));
  const state = initialize(linked, { requirement });
  assert.equal(evaluate(expr, linked, { state, inputs }), true);
  assert.equal(evaluate(expr, linked, { state, inputs: { stagedEvidence: { ...evidence, protocolVersion: 'PROTOCOL-V2' } } }), false);
  const partial = { ...evidence };
  delete partial.authenticityEstablished;
  assert.ok(isUnknown(evaluate(expr, linked, { state, inputs: { stagedEvidence: partial } })));
  assert.throws(() => evaluate(expr, linked, { state, inputs: { stagedEvidence: { ...evidence, complete: 'true' } } }), error('TYPE_ERROR'));
  assert.deepEqual(evidence, before);
  const ontology = linked.ontologies.C;
  ontology.relations.push({ name: 'recursive', params: [], type: 'Bool', body: call('recursive') });
  assert.throws(() => evaluate(call('C.recursive'), linked, { state }), error('UNSUPPORTED_PROFILE'));
});

test('missing and False preconditions block without committing; invalid types throw', () => {
  const linked = clinical();
  let state = initialize(linked, { requirement });
  state = step(linked, state, 'recordAcceptedPlan', { planHash: 'PLAN-H1' });
  state = step(linked, state, 'submitEvidence');
  const before = structuredClone(state);
  const partial = { ...inputs }; delete partial.blockingItemsResolved;
  const result = simulate(linked, state, partial, 'recordReviewPass');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.stage, 'requires');
  assert.ok(result.checks.some(c => isUnknown(c.value)));
  assert.ok(!('state' in result));
  const wrong = simulate(linked, state, { ...inputs, reviewStillValid: false }, 'recordReviewPass');
  assert.equal(wrong.ok, false);
  assert.throws(() => simulate(linked, state, { ...inputs, blockingItemsResolved: 'true' }, 'recordReviewPass'), error('TYPE_ERROR'));
  assert.deepEqual(state, before);
});

test('replace evidence clears review; requirement updates use explicit fixture and preserve evidence frame', () => {
  const linked = clinical();
  let state = initialize(linked, { requirement });
  state = step(linked, state, 'recordAcceptedPlan', { planHash: 'PLAN-H1' });
  state = step(linked, state, 'submitEvidence');
  state = step(linked, state, 'recordReviewPass');
  state = step(linked, state, 'submitEvidence', {}, { ...inputs, stagedEvidence: { ...evidence, contentHash: 'E-H2' } });
  assert.equal(state.phase, 'SUBMITTED');
  assert.equal(state.activeReviewHash, '');
  const nextRequirement = { ...requirement, contentHash: 'REQ-H2', protocolVersion: 'PROTOCOL-V4' };
  state = step(linked, state, 'updateRequirement', { nextRequirement });
  assert.equal(state.phase, 'OPEN');
  assert.equal(state.currentEvidenceHash, 'E-H2');
  assert.deepEqual(state.requirement, nextRequirement);
  assert.notEqual(state.requirement, nextRequirement);
});

function assignmentFixture(): Linked {
  const linked = empty();
  linked.spec.state = [{ name: 'x', type: 'Int', value: lit(1) }, { name: 'y', type: 'Int', value: lit(2) }, { name: 'z', type: 'Text', value: lit('fixed') }];
  linked.spec.actions = [{ name: 'swap', params: [], requires: [], ensures: [bin('==', ref('x', true), ref('y')), bin('==', ref('y', true), ref('x'))], writes: ['x', 'y'], atomic: true }];
  return linked;
}

test('all RHS see pre-state, writes retain omitted frame fields, originals immutable', () => {
  const linked = assignmentFixture();
  const state = initialize(linked);
  const next = step(linked, state, 'swap', {}, {});
  assert.deepEqual(next, { x: 2, y: 1, z: 'fixed' });
  assert.deepEqual(state, { x: 1, y: 2, z: 'fixed' });
});

test('unsupported ensures, next-state RHS, contradictory assignments and frame escape explicitly reject', () => {
  const cases: [Expr[], string[], string][] = [
    [[bin('>', ref('x', true), lit(2))], ['x'], 'UNSUPPORTED_POSTCONDITION'],
    [[bin('==', ref('x', true), ref('y', true))], ['x'], 'UNSUPPORTED_POSTCONDITION'],
    [[bin('==', ref('x', true), lit(2)), bin('==', ref('x', true), lit(3))], ['x'], 'CONFLICTING_ASSIGNMENT'],
    [[bin('==', ref('x', true), lit(2))], ['y'], 'FRAME_VIOLATION'],
    [[bin('==', ref('absent', true), lit(2))], ['absent'], 'FRAME_VIOLATION'],
    [[bin('==', ref('x.field', true), lit(2))], ['x'], 'UNSUPPORTED_POSTCONDITION'],
  ];
  for (const [ensures, writes, code] of cases) {
    const linked = assignmentFixture();
    Object.assign(linked.spec.actions[0], { ensures, writes });
    const state = initialize(linked), before = structuredClone(state);
    assert.throws(() => simulate(linked, state, {}, 'swap'), error(code));
    assert.deepEqual(state, before);
  }
});

test('Unknown assignment or False/Unknown candidate hard constraint never returns a successful state', () => {
  const linked = assignmentFixture();
  const action: Action = linked.spec.actions[0];
  action.ensures = [bin('==', ref('x', true), ref('missing'))];
  let state = initialize(linked);
  const missing = simulate(linked, state, {}, 'swap');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.stage, 'assignment');
  action.ensures = [bin('==', ref('x', true), lit(4))];
  for (const expr of [bin('<', ref('x'), lit(3)), ref('missing')]) {
    linked.spec.constraints = [{ name: 'hard', expr: { kind: 'unary', op: 'always', arg: expr } }];
    const before = structuredClone(state);
    const failed = simulate(linked, state, {}, 'swap');
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      if (expr.kind === 'ref') { assert.equal(failed.stage, 'pre-constraints'); assert.ok(!('candidate' in failed)); }
      else { assert.equal(failed.stage, 'constraints'); assert.equal(failed.candidate?.x, 4); }
    }
    assert.ok(!('state' in failed));
    assert.deepEqual(state, before);
  }
});

test('finite-prefix monitor never treats always True or eventually False as complete trace facts', () => {
  const linked = empty();
  linked.spec.goals = [{ name: 'future', expr: { kind: 'unary', op: 'eventually', arg: lit(false) } }];
  linked.spec.constraints = [{ name: 'safety', expr: { kind: 'unary', op: 'always', arg: lit(true) } }];
  const result = monitor(linked, {}, {});
  assert.ok(isUnknown(result.goals[0].value));
  assert.ok(isUnknown(result.constraints[0].value));
  assert.throws(() => evaluate(linked.spec.goals[0].expr, linked, { state: {} }), error('UNSUPPORTED_PROFILE'));
  linked.spec.constraints[0].expr = { kind: 'unary', op: 'always', arg: lit(false) };
  assert.equal(monitor(linked, {}, {}).constraints[0].value, false);
});

test('dangerous own keys survive context, state, relation locals and assignment without prototype mutation', () => {
  const linked = empty();
  const keys = ['__proto__', 'constructor', 'toString'];
  linked.spec.context = keys.map(name => ({ name, type: 'Text', value: lit(`context:${name}`) }));
  for (const name of keys) assert.equal(evaluate(ref(name), linked, { state: {} }), `context:${name}`);
  linked.spec.context = [];
  linked.spec.state = keys.map(name => ({ name, type: 'Text', value: lit(`state:${name}`) }));
  linked.spec.actions = [{ name: 'change', params: [], requires: [], ensures: keys.map(name => bin('==', ref(name, true), lit(`next:${name}`))), writes: keys, atomic: false }];
  const state = initialize(linked);
  const result = simulate(linked, state, {}, 'change');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected success');
  for (const name of keys) {
    assert.ok(Object.hasOwn(state, name)); assert.equal(state[name], `state:${name}`);
    assert.ok(Object.hasOwn(result.state, name)); assert.equal(result.state[name], `next:${name}`);
  }
  assert.equal(Object.getPrototypeOf(state), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.state), Object.prototype);
  const ontology: Ontology = { kind: 'ontology', name: 'keys', version: '1', concepts: [], relations: keys.map(name => ({ name: `read_${name}`, params: [{ name, type: 'Text' }], type: 'Text', body: ref(name) })) };
  linked.ontologies.K = ontology;
  for (const name of keys) assert.equal(evaluate(call(`K.read_${name}`, lit('local')), linked, { state: {} }), 'local');
  const initial = JSON.parse('{"__proto__":"fixture"}');
  assert.equal(initialize(linked, initial).__proto__, 'fixture');
  assert.equal(Object.getPrototypeOf(initial), Object.prototype);
});

test('prototype-inherited fields and bindings are never read as own knowledge', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'inherited']) {
    const inherited = Object.create({ [name]: 'not-owned' });
    assert.ok(isUnknown(evaluate(ref(name), empty(), { state: {}, inputs: inherited })));
  }
  const linked = empty();
  linked.spec.input = [{ name: 'inherited', type: 'Text' }];
  assert.throws(() => monitor(linked, {}, Object.create({ inherited: 'not-owned' })), error('TYPE_ERROR'));
  assert.ok(isUnknown(evaluate(ref('obj.constructor'), empty(), { state: { obj: {} } })));
  assert.throws(() => evaluate(call('constructor.missing'), empty(), { state: {} }), error('UNKNOWN_RELATION'));
});

test('Int input, defaults, literals and intermediate arithmetic reject unsafe integers', () => {
  const linked = assignmentFixture();
  linked.spec.input = [{ name: 'n', type: 'Int' }];
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => initialize(linked, { x: unsafe }), error('TYPE_ERROR'));
  assert.throws(() => monitor(linked, initialize(linked), { n: unsafe }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(lit(unsafe), linked, { state: {} }), error('TYPE_ERROR'));
  assert.throws(() => evaluate(bin('+', lit(Number.MAX_SAFE_INTEGER), lit(1)), linked, { state: {} }), error('ARITHMETIC_ERROR'));
  assert.throws(() => evaluate(bin('*', lit(Number.MAX_SAFE_INTEGER), lit(2)), linked, { state: {} }), error('ARITHMETIC_ERROR'));
  assert.throws(() => evaluate(bin('-', lit(-Number.MAX_SAFE_INTEGER), lit(1)), linked, { state: {} }), error('ARITHMETIC_ERROR'));
  const roundedBack = bin('-', bin('+', lit(Number.MAX_SAFE_INTEGER), lit(2)), lit(2));
  assert.throws(() => evaluate(roundedBack, linked, { state: {} }), error('ARITHMETIC_ERROR'));
  linked.spec.actions[0].ensures = [bin('==', ref('x', true), bin('+', ref('n'), lit(1)))];
  assert.throws(() => simulate(linked, initialize(linked), { n: Number.MAX_SAFE_INTEGER }, 'swap'), error('ARITHMETIC_ERROR'));
  assert.equal(evaluate(bin('/', lit(1), lit(2)), linked, { state: {} }), 0.5);
  linked.spec.input[0].type = 'Decimal';
  assert.equal(evaluate(bin('+', ref('n'), lit(1)), linked, { state: {}, inputs: { n: Number.MAX_SAFE_INTEGER } }), unsafe);
});

test('negative zero equals zero in numeric/concept comparisons and duplicate assignments', () => {
  assert.equal(evaluate(bin('==', lit(-0), lit(0)), empty(), { state: {} }), true);
  assert.equal(evaluate(bin('!=', lit(-0), lit(0)), empty(), { state: {} }), false);
  assert.equal(evaluate(bin('==', ref('a'), ref('b')), empty(), { state: { a: { n: -0 }, b: { n: 0 } } }), true);
  const linked = assignmentFixture();
  linked.spec.actions[0].ensures = [bin('==', ref('x', true), lit(-0)), bin('==', ref('x', true), lit(0))];
  assert.equal(simulate(linked, initialize(linked), {}, 'swap').ok, true);
});

test('invalid or Unknown pre-state invariants cannot be hidden by a repairing transition', () => {
  const linked = assignmentFixture();
  linked.spec.constraints = [{ name: 'positive', expr: { kind: 'unary', op: 'always', arg: bin('>', ref('x'), lit(0)) } }];
  linked.spec.actions[0].ensures = [bin('==', ref('x', true), lit(1))];
  for (const x of [0, unknown('not established')]) {
    const state = initialize(linked, { x }), before = structuredClone(state);
    const result = simulate(linked, state, {}, 'swap');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, 'pre-constraints');
    assert.ok(!('state' in result)); assert.ok(!('candidate' in result));
    assert.deepEqual(state, before);
  }
  linked.spec.constraints[0].expr = { kind: 'unary', op: 'eventually', arg: lit(true) };
  assert.throws(() => simulate(linked, initialize(linked), {}, 'swap'), error('UNSUPPORTED_PROFILE'));
  linked.spec.constraints[0].expr = { kind: 'unary', op: 'always', arg: { kind: 'unary', op: 'eventually', arg: lit(true) } };
  assert.throws(() => simulate(linked, initialize(linked), {}, 'swap'), error('UNSUPPORTED_PROFILE'));
});

test('initialization resolves ordered context defaults, leaves missing input dependencies Unknown, and does not certify invariants', () => {
  const linked = empty();
  linked.spec.context = [{ name: 'constant', type: 'Int', value: lit(3) }, { name: 'unbound', type: 'Int' }];
  linked.spec.input = [{ name: 'incoming', type: 'Int' }];
  linked.spec.state = [
    { name: 'a', type: 'Int', value: ref('constant') },
    { name: 'b', type: 'Int', value: ref('a') },
    { name: 'c', type: 'Int', value: ref('incoming') },
    { name: 'd', type: 'Int', value: ref('unbound') },
  ];
  linked.spec.constraints = [{ name: 'inputsRequired', expr: bin('>', ref('incoming'), lit(0)) }];
  linked.spec.actions = [{ name: 'noop', params: [], requires: [], ensures: [], writes: [], atomic: false }];
  const state = initialize(linked);
  assert.equal(state.a, 3); assert.equal(state.b, 3);
  assert.ok(isUnknown(state.c)); assert.ok(isUnknown(state.d));
  const blocked = simulate(linked, state, {}, 'noop');
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.stage, 'pre-constraints');
  assert.equal(simulate(linked, state, { incoming: 1 }, 'noop').ok, true);
});
