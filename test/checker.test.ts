import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GilError } from '../src/ast.ts';
import type { Expr, Ontology, Spec } from '../src/ast.ts';
import { parse } from '../src/parser.ts';
import { check, link } from '../src/checker.ts';

function spec(body = '', imports = 'use ontology "test@0.1" as T;'): Spec {
  const document = parse(`spec demo version "0.1" { ${imports} ${body.replaceAll('writes ;', ';')} }`);
  assert.equal(document.kind, 'spec');
  return document as Spec;
}
function ontology(body = ''): Ontology {
  const document = parse(`ontology "test" version "0.1" { ${body} }`);
  assert.equal(document.kind, 'ontology');
  return document as Ontology;
}
function codes(body: string, declarations = ''): string[] {
  return check(link(spec(body), [ontology(declarations)])).map(d => d.code);
}
function error(code: string): (err: unknown) => boolean {
  return err => err instanceof GilError && err.code === code;
}
const entity = 'concept Item { identity id: Text; ready: Bool; quantity: Int; }';

test('links and checks both unmodified clinical GIL documents', () => {
  const base = new URL('../docs/clinical-operations/monitoring-remediation/', import.meta.url);
  const workflow = parse(readFileSync(new URL('workflow.gil', base), 'utf8')) as Spec;
  const domain = parse(readFileSync(new URL('ontology.gil', base), 'utf8')) as Ontology;
  const linked = link(workflow, [domain]);
  assert.equal(linked.ontologies.C, domain);
  assert.deepEqual(check(linked), []);
});

test('link requires exact matching name and version, not latest or ranges', () => {
  const domain = ontology();
  for (const version of ['latest', '^0.1', '~0.1', '*', '']) {
    assert.throws(() => link(spec('', `use ontology "test@${version}" as T;`), [domain]), error('IMPORT_VERSION_REQUIRED'));
  }
  assert.throws(() => link(spec('', 'use ontology "test" as T;'), [domain]), error('IMPORT_VERSION_REQUIRED'));
  assert.throws(() => link(spec('', 'use ontology "test@0.2" as T;'), [domain]), error('UNRESOLVED_IMPORT'));
  assert.throws(() => link(spec(), [domain, structuredClone(domain)]), error('AMBIGUOUS_IMPORT'));
  const duplicate = spec();
  duplicate.imports.push({ ...duplicate.imports[0] });
  assert.throws(() => link(duplicate, [domain]), error('DUPLICATE_ALIAS'));
});

test('different aliases of the same exact ontology retain nominal type identity', () => {
  const s = spec('input { a: T.Item; b: U.Item; } constraints { require same: a == b; }',
    'use ontology "test@0.1" as T; use ontology "test@0.1" as U;');
  assert.deepEqual(check(link(s, [ontology(entity)])), []);
});

test('basic types, numeric widening and pure relation parameter binding', () => {
  assert.deepEqual(codes(`context { label: Text = "ok"; flag: Bool = true; count: Int = 2; amount: Decimal = 2; }
    input { item: T.Item; } constraints { require ready: T.ready(item, count) && amount >= count; }`,
    `${entity} relation ready(value: Item, minimum: Int): Bool = value.ready && value.quantity >= minimum;`), []);
  assert.ok(codes('input { item: T.Item; } constraints { require ready: T.ready(true); }',
    `${entity} relation ready(value: Item): Bool = value.ready;`).includes('TYPE_MISMATCH'));
  assert.ok(codes('constraints { require ready: T.ready(); }',
    `${entity} relation ready(value: Item): Bool = value.ready;`).includes('RELATION_ARITY'));
});

test('unresolved refs, fields, relations and unsupported types are errors, never Unknown', () => {
  const results = [
    codes('constraints { require wrong: missing == true; }'),
    codes('input { item: T.Item; } constraints { require wrong: item.missing == true; }', entity),
    codes('constraints { require wrong: T.missing(); }'),
    codes('state { x: Unknown; }'),
    codes('state { x: Other.Item; }'),
  ];
  for (const result of results) {
    assert.ok(result.length > 0);
    assert.ok(!result.includes('Unknown'));
  }
  assert.ok(results[0].includes('UNRESOLVED_REFERENCE'));
  assert.ok(results[1].includes('UNRESOLVED_FIELD'));
  assert.ok(results[2].includes('UNRESOLVED_RELATION'));
  assert.ok(results[3].includes('UNSUPPORTED_TYPE'));
});

test('operators reject incompatible operands and contracts/claims must be Bool', () => {
  for (const expression of ['1 && true', '!1', '"a" + 2', '"a" < "b"', 'true == 1']) {
    assert.ok(codes(`constraints { require wrong: ${expression}; }`).includes('TYPE_MISMATCH'), expression);
  }
  for (const body of [
    'goals { achieve wrong: 1; }',
    'constraints { require wrong: "not bool"; }',
    'action { action wrong() requires 1 writes ; }',
    'state { x: Int; } action { action wrong() ensures x\' + 1 writes x; }',
    'context { x: Int = 1.5; }',
  ]) assert.ok(codes(body).includes('TYPE_MISMATCH'), body);
});

test('duplicate namespaces, fields, parameters, claims and actions are diagnosed', () => {
  for (const body of [
    'context { x: Text; } input { x: Text; }',
    'state { T: Text; }',
    'state { x: Text; } action { action a(x: Text); }',
    'goals { achieve c: true; } constraints { require c: true; }',
  ]) assert.ok(codes(body).includes('DUPLICATE_NAME'), body);
  // Parser also rejects source duplicates. Exercise checker independently on ASTs.
  for (const mutate of [
    (s: Spec, _o: Ontology) => s.state.push({ name: 'x', type: 'Text' }, { name: 'x', type: 'Text' }),
    (s: Spec, _o: Ontology) => s.actions.push({ name: 'a', params: [{ name: 'p', type: 'Text' }, { name: 'p', type: 'Text' }], requires: [], ensures: [], writes: [], atomic: false }),
    (s: Spec, _o: Ontology) => { const a = { name: 'a', params: [], requires: [], ensures: [], writes: [], atomic: false }; s.actions.push(a, structuredClone(a)); },
    (_s: Spec, o: Ontology) => o.concepts[0].fields.push({ name: 'id', type: 'Text' }),
    (_s: Spec, o: Ontology) => o.relations.push({ name: 'Item', params: [], type: 'Bool', body: { kind: 'literal', value: true } }),
  ]) {
    const s = spec(), o = ontology(entity);
    mutate(s, o);
    assert.ok(check(link(s, [o])).some(d => d.code === 'DUPLICATE_NAME'));
  }
});

test('writes targets must be distinct whole spec state bindings', () => {
  for (const target of ['flag', 'p', 'item.ready', 'missing']) {
    assert.ok(codes(`input { flag: Bool; } state { item: T.Item; } action { action a(p: Bool) writes ${target}; }`, entity).includes('INVALID_WRITE'), target);
  }
  const duplicate = spec('state { x: Text; } action { action a() writes x; }');
  duplicate.actions[0].writes.push('x');
  assert.ok(check(link(duplicate, [ontology()])).some(d => d.code === 'DUPLICATE_WRITE'));
});

test('prime scope is state in ensures only and must be included in writes', () => {
  assert.deepEqual(codes(`state { item: T.Item; } action { action a() ensures item.ready' == true writes item; }`, entity), []);
  assert.ok(codes('state { x: Bool; } action { action a() ensures x\' writes ; }').includes('NEXT_NOT_WRITTEN'));
  for (const body of [
    'input { x: Bool; } action { action a() ensures x\' writes ; }',
    'action { action a(p: Bool) ensures p\' writes ; }',
    'state { x: Bool; } action { action a() requires x\' writes x; }',
    'state { x: Bool; } constraints { require c: x\'; }',
    'state { x: Bool = x\'; }',
  ]) assert.ok(codes(body).includes('INVALID_NEXT_SCOPE'), body);
  assert.ok(codes('', 'relation r(p: Bool): Bool = p\';').includes('INVALID_NEXT_SCOPE'));
});

test('pure ontology relations cannot access spec bindings, recurse, or use temporal operators', () => {
  assert.ok(codes('state { ready: Bool; }', 'relation r(): Bool = ready;').includes('UNRESOLVED_REFERENCE'));
  assert.ok(codes('', 'relation r(): Bool = r();').includes('RECURSIVE_RELATION'));
  assert.ok(codes('', 'relation a(): Bool = b(); relation b(): Bool = a();').includes('RECURSIVE_RELATION'));
  assert.ok(codes('', 'relation r(): Bool = always true;').includes('UNSUPPORTED_TEMPORAL_SCOPE'));
  assert.ok(codes('', 'relation r(): Bool = 1;').includes('TYPE_MISMATCH'));
  assert.deepEqual(codes('', 'relation a(): Bool = b(); relation b(): Bool = true;'), []);
});

test('nominal concept types, declaration defaults and identity are checked', () => {
  const declarations = `${entity} concept Other { identity id: Text; } relation label(value: Item): Text = value.id;`;
  assert.ok(codes('input { a: T.Item; b: T.Other; } constraints { require same: a == b; }', declarations).includes('TYPE_MISMATCH'));
  assert.ok(codes('input { a: T.Item; } constraints { require c: T.label(a); }', declarations).includes('TYPE_MISMATCH'));
  assert.ok(codes('input { x: Bool = true; }').includes('UNSUPPORTED_DEFAULT'));
  const o = ontology(entity);
  o.concepts[0].identity = 'missing';
  assert.ok(check(link(spec(), [o])).some(d => d.code === 'INVALID_IDENTITY'));
  assert.ok(codes('state { x: Bool; } action { action a() requires always x; }').includes('UNSUPPORTED_TEMPORAL_SCOPE'));
});

test('root next-state assignment allows Int to Decimal but rejects Decimal to Int', () => {
  for (const rhs of ['1.5', 'amount', 'count / 2', 'T.amount()']) {
    const diagnostics = check(link(spec(`input { amount: Decimal; count: Int; }
      state { x: Int; } action { action a() ensures x' == ${rhs} writes x; }`),
      [ontology('relation amount(): Decimal = 1.5;')]));
    assert.ok(diagnostics.some(d => d.code === 'TYPE_MISMATCH' && d.message.includes('Assignment to x')), rhs);
  }
  for (const [type, rhs] of [['Int', '2'], ['Decimal', '2'], ['Decimal', '1.5'], ['Decimal', 'count']]) {
    assert.deepEqual(codes(`input { count: Int; } state { x: ${type}; }
      action { action a() ensures x' == ${rhs} writes x; }`), [], `${type} <- ${rhs}`);
  }
  // Ordinary numeric equality remains symmetric and is not an assignment.
  assert.deepEqual(codes(`state { x: Int; } constraints { require c: x == 1.5; }
    action { action a() requires x == 1.5 ensures x' == 1 writes x; }`), []);
});

test('dangerous dictionary keys are own entries and never prototype lookups', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const s = spec(`state { ${key}: Int; } action { action a() ensures ${key}' == 2 writes ${key}; }`, '');
    assert.deepEqual(check(link(s, [])), []);
    const aliasSpec = spec(`input { item: ${key}.Item; }
      constraints { require c: ${key}.ready(item); }`, `use ontology "test@0.1" as ${key};`);
    const domain = ontology(`${entity} relation ready(value: Item): Bool = value.ready;`);
    const linked = link(aliasSpec, [domain]);
    assert.equal(Object.getPrototypeOf(linked.ontologies), null);
    assert.ok(Object.hasOwn(linked.ontologies, key));
    assert.equal(linked.ontologies[key], domain);
    assert.deepEqual(check(linked), []);
    aliasSpec.imports.push({ ...aliasSpec.imports[0] });
    assert.throws(() => link(aliasSpec, [domain]), error('DUPLICATE_ALIAS'));
    // Even caller-created Linked objects must not expose inherited aliases.
    const missing = spec(`input { item: ${key}.Item; }
      constraints { require c: ${key}.ready(item); }`, '');
    const inherited = Object.create({ [key]: domain });
    const diagnostics = check({ spec: missing, ontologies: inherited });
    assert.ok(diagnostics.some(d => d.code === 'UNSUPPORTED_TYPE'));
    assert.ok(diagnostics.some(d => d.code === 'UNRESOLVED_RELATION'));
  }
});

test('unsupported AST forms and operators get explicit diagnostics', () => {
  for (const expr of [
    { kind: 'quantifier' },
    { kind: 'unary', op: 'within', arg: { kind: 'literal', value: true } },
    { kind: 'binary', op: 'union', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } },
  ]) {
    const s = spec();
    s.constraints.push({ name: 'unsupported', expr: expr as Expr });
    const result = check(link(s, [ontology()]));
    assert.ok(result.some(d => d.code.startsWith('UNSUPPORTED_')));
  }
});
