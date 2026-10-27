import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/parser.ts';
import { canonical, contentHash, PROFILE } from '../src/canonical.ts';
import { GilError } from '../src/ast.ts';
import type { Document, Expr, Spec } from '../src/ast.ts';

const clinical = new URL('../docs/clinical-operations/monitoring-remediation/', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, clinical), 'utf8');
const expression = (text: string): Expr => (parse(`spec test version "0.1" { goals { achieve g: ${text}; } }`) as Spec).goals[0].expr;
const ref = (name: string): Expr => ({ kind: 'ref', path: [name] });
const literal = (value: string | number | boolean): Expr => ({ kind: 'literal', value });
const binary = (op: string, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const rejected = (text: string, code?: string) => assert.throws(() => parse(text), (error: unknown) => {
  assert.ok(error instanceof GilError);
  assert.match(error.message, /at \d+:\d+$/);
  if (code) assert.equal(error.code, code);
  return true;
});

test('parses the actual clinical ontology, including identity and relation calls', () => {
  const doc = parse(source('ontology.gil'));
  assert.equal(doc.kind, 'ontology');
  if (doc.kind !== 'ontology') return;
  assert.equal(doc.name, 'clinical/training-remediation');
  assert.equal(doc.concepts.length, 2);
  assert.equal(doc.concepts[0].identity, 'requirementId');
  assert.equal(doc.concepts[0].fields.length, 7);
  assert.equal(doc.concepts[1].identity, 'bundleId');
  assert.equal(doc.relations.length, 2);
  assert.deepEqual(doc.relations[0].params, [{ name: 'e', type: 'EvidenceBundle' }, { name: 'r', type: 'Requirement' }]);
  assert.equal(doc.relations[1].body.kind, 'binary');
});

test('parses actual workflow; clause boundaries do not need semicolons/newlines', () => {
  const doc = parse(source('workflow.gil'));
  assert.equal(doc.kind, 'spec');
  if (doc.kind !== 'spec') return;
  assert.equal(doc.name, 'clinical.TrainingRemediation');
  assert.deepEqual(doc.imports, [{ name: 'clinical/training-remediation@0.1', alias: 'C' }]);
  assert.equal(doc.context.length, 6);
  assert.equal(doc.input.length, 4);
  assert.equal(doc.state.length, 7);
  assert.equal(doc.goals.length, 1);
  assert.equal(doc.constraints.length, 3);
  assert.equal(doc.actions.length, 8);
  const close = doc.actions.find(action => action.name === 'closeFinding')!;
  assert.equal(close.requires.length, 10);
  assert.equal(close.ensures.length, 1);
  assert.equal(close.atomic, true);
  assert.deepEqual(close.writes, ['phase']);
  assert.deepEqual(close.ensures[0], binary('==', { kind: 'ref', path: ['phase'], next: true }, ref('CLOSED')));
  assert.deepEqual(parse(source('workflow.gil').replace(/\s+/g, ' ')), doc);
});

test('canonical JSON and hash ignore formatting and both comment forms', () => {
  for (const name of ['ontology.gil', 'workflow.gil']) {
    const text = source(name), original = parse(text);
    const reformatted = parse(`(* profile test *)\n// header\n${text.replace(/\n/g, '\n  // line\n')}`);
    assert.equal(canonical(reformatted), canonical(original));
    assert.equal(contentHash(reformatted), contentHash(original));
    assert.match(contentHash(original), /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.parse(canonical(original)).profile, PROFILE);
  }
});

test('canonical recursively sorts object keys but does not reorder lists', () => {
  const original = parse(source('ontology.gil'));
  const reversedKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversedKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]));
    return value;
  };
  assert.equal(canonical(original), canonical(reversedKeys(original) as Document));
  const reordered = structuredClone(original);
  if (reordered.kind === 'ontology') reordered.concepts.reverse();
  assert.notEqual(contentHash(original), contentHash(reordered));
  assert.notEqual(contentHash(parse('spec s version "1" {}')), contentHash(parse('spec s version "2" {}')));
});

test('expression precedence follows Core EBNF, implication is right-associative', () => {
  assert.deepEqual(expression('a => b => c'), binary('=>', ref('a'), binary('=>', ref('b'), ref('c'))));
  assert.deepEqual(expression('a || b && c == d + e * f'),
    binary('||', ref('a'), binary('&&', ref('b'), binary('==', ref('c'), binary('+', ref('d'), binary('*', ref('e'), ref('f')))))));
  assert.deepEqual(expression('a - b - c'), binary('-', binary('-', ref('a'), ref('b')), ref('c')));
  assert.deepEqual(expression('a < b == c >= d'), binary('==', binary('<', ref('a'), ref('b')), binary('>=', ref('c'), ref('d'))));
  assert.deepEqual(expression('!a == b'), binary('==', { kind: 'unary', op: '!', arg: ref('a') }, ref('b')));
  assert.deepEqual(expression('not a'), expression('!a'));
  assert.deepEqual(expression('always a == b'), binary('==', { kind: 'unary', op: 'always', arg: ref('a') }, ref('b')));
  assert.deepEqual(expression('eventually (a == b)'), { kind: 'unary', op: 'eventually', arg: binary('==', ref('a'), ref('b')) });
  assert.deepEqual(expression('-2 * (3 + 4) / 2'), binary('/', binary('*', { kind: 'unary', op: '-', arg: literal(2) }, binary('+', literal(3), literal(4))), literal(2)));
});

test('qualified calls, field prime and JSON string escapes', () => {
  assert.deepEqual(expression("C.ready(e.field', f(1.25, true), false)"), { kind: 'call', path: ['C', 'ready'], args: [
    { kind: 'ref', path: ['e', 'field'], next: true }, { kind: 'call', path: ['f'], args: [literal(1.25), literal(true)] }, literal(false),
  ] });
  assert.deepEqual(expression('"a\\n\\t\\u4e2d\\\"\\\\//(* *)"'), literal('a\n\t中"\\//(* *)'));
  assert.deepEqual(expression('"always"'), literal('always'));
});

test('rejects duplicate singleton clauses and declarations; repeated contracts remain legal', () => {
  const cases = [
    'spec s version "1" { state {} state {} }',
    'spec s version "1" { use ontology "o@1" as O; use ontology "o@1" as O; }',
    'spec s version "1" { state { x: Bool; x: Bool; } }',
    'spec s version "1" { goals { achieve g: true; achieve g: false; } }',
    'spec s version "1" { action { action a() atomic atomic; } }',
    'spec s version "1" { action { action a() writes x writes y; } }',
    'spec s version "1" { action { action a() writes x, x; } }',
    'spec s version "1" { action { action a(x: Bool, x: Bool); } }',
    'ontology "o" version "1" { concept C { identity x: Text; identity y: Text; } }',
    'ontology "o" version "1" { concept C { identity x: Text; x: Text; } }',
  ];
  for (const text of cases) rejected(text, 'DUPLICATE_CLAUSE');
  const doc = parse('spec s version "1" { action { action a() requires true requires false ensures true ensures false; } }') as Spec;
  assert.equal(doc.actions[0].requires.length, 2);
  assert.equal(doc.actions[0].ensures.length, 2);
});

test('bad syntax always throws a located GilError', () => {
  for (const text of [
    '', 'spec s version "1" {} spec t version "1" {}', 'spec s version "1" {',
    'spec s version "1" { state { x: Bool = ; } }',
    'spec s version "1" { goals { achieve g: (true; } }',
    'spec s version "1" { action { action a() requires ensures true; } }',
    'ontology "o" version "1" { concept C { x: Text; } }',
    '(* missing end', 'spec s version "\\q" {}', 'spec s version "line\nbreak" {}',
    'spec s version "1" { state { x: Text = "missing; } }',
  ]) rejected(text);
  assert.throws(() => parse('// header\nspec s version "1" {\n  state { x: Bool = ; }\n}'), /at 3:21$/);
});

test('unsupported Core and outer-layer constructs are explicitly rejected', () => {
  for (const text of [
    'lexicon "l" version "1" {}', 'environment e {}', 'delegate d {}',
    'ontology "o" version "1" { type T = Text; }',
    'ontology "o" version "1" { relation p(): Bool; }',
    'spec s version "1" { use lexicon "l" as L; }',
    'spec s version "1" { knowledge {} }', 'spec s version "1" { output {} }',
    'spec s version "1" { verification {} }',
    'spec s version "1" { state { x: Option<Text>; } }',
    'spec s version "1" { goals { prefer g: minimize x priority 1; } }',
    'spec s version "1" { goals { achieve g: forall x: Bool. x; } }',
    'spec s version "1" { goals { achieve g: eventually within 2 true; } }',
    'spec s version "1" { goals { achieve g: x[0]; } }',
    'spec s version "1" { goals { achieve g: x in y; } }',
    'spec s version "1" { goals { achieve g: 2 % 1 == 0; } }',
    'spec s version "1" { context { x: Bool = true source evidence; } }',
    'spec s version "1" { action { action a() preserves true; } }',
    'spec s version "1" { action { action a() -> Bool; } }',
  ]) rejected(text, 'UNSUPPORTED_SYNTAX');
});

test('canonical rejects non-finite numeric AST values', () => {
  const doc = parse('spec s version "1" { state { x: Real = 1; } }') as Spec;
  doc.state[0].value = literal(Infinity);
  assert.throws(() => canonical(doc), (error: unknown) => error instanceof GilError && error.code === 'CANONICAL_ERROR');
});
