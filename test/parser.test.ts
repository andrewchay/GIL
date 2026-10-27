import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, parseBundle } from '../src/parser.ts';
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
  assert.equal(doc.concepts.length, 5);
  assert.equal(doc.concepts[0].identity, 'requirementId');
  assert.equal(doc.concepts[0].fields.length, 7);
  assert.equal(doc.concepts[1].identity, 'bundleId');
  assert.deepEqual(doc.concepts.map(concept => concept.name),
    ['Requirement', 'EvidenceBundle', 'BlockerStatus', 'Obligation', 'EscalationAck']);
  assert.equal(doc.concepts[2].identity, 'ledgerHash');
  assert.equal(doc.concepts[2].fields.length, 4);
  assert.equal(doc.relations.length, 4);
  assert.deepEqual(doc.relations[0].params, [{ name: 'e', type: 'EvidenceBundle' }, { name: 'r', type: 'Requirement' }]);
  assert.equal(doc.relations[1].body.kind, 'binary');
  assert.deepEqual(doc.relations[2].params, [{ name: 'b', type: 'BlockerStatus' }]);
  assert.deepEqual(doc.relations[3].params,
    [{ name: 'o', type: 'Obligation' }, { name: 'at', type: 'Int' }, { name: 'esc', type: 'EscalationAck' }]);
});

test('parses actual workflow; clause boundaries do not need semicolons/newlines', () => {
  const doc = parse(source('workflow.gil'));
  assert.equal(doc.kind, 'spec');
  if (doc.kind !== 'spec') return;
  assert.equal(doc.name, 'clinical.TrainingRemediation');
  assert.deepEqual(doc.imports, [{ name: 'clinical/training-remediation@0.1', alias: 'C' }]);
  assert.equal(doc.context.length, 6);
  assert.equal(doc.input.length, 8);
  assert.deepEqual(doc.input.map(binding => binding.name),
    ['stagedEvidence', 'blockers', 'deadline', 'escalation', 'businessDate', 'actionAt', 'reviewStillValid', 'evaluatedReviewHash']);
  assert.equal(doc.state.length, 8);
  assert.equal(doc.goals.length, 1);
  assert.equal(doc.constraints.length, 3);
  assert.equal(doc.actions.length, 8);
  const close = doc.actions.find(action => action.name === 'closeFinding')!;
  assert.equal(close.requires.length, 12);
  assert.equal(close.ensures.length, 2);
  assert.equal(close.atomic, true);
  assert.deepEqual(close.writes, ['phase', 'lastBusinessDate']);
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

test('constructs still outside the implemented profile are explicitly rejected', () => {
  // 仍是未实现能力：细分类型声明、无体关系、索引、Core 中的 in、取模。
  for (const text of [
    'ontology "o" version "1" { type T = Text; }',
    'ontology "o" version "1" { relation p(): Bool; }',
    'spec s version "1" { goals { achieve g: x[0]; } }',
    'spec s version "1" { goals { achieve g: x in y; } }',
    'spec s version "1" { goals { achieve g: 2 % 1 == 0; } }',
  ]) rejected(text, 'UNSUPPORTED_SYNTAX');
  // 语法不完整：缺 for / 缺 reward / 缺参数表 / 缺界限单位。
  for (const text of [
    'lexicon "l" version "1" {}', 'environment e {}', 'delegate d {}',
    'spec s version "1" { goals { achieve g: eventually within 2 true; } }',
  ]) rejected(text);
});

test('type constructors are parsed, and Entity/Option keep their arguments', () => {
  const doc = parse(`spec s version "1" { state { a: Option<Text>; b: Entity<H.Customer>; c: Set<Order>; d: A | B; } }`) as Spec;
  assert.equal(doc.state[0].type, 'Option<Text>');
  assert.equal(doc.state[1].type, 'Entity<H.Customer>');
  assert.equal(doc.state[2].type, 'Set<Order>');
  assert.equal(doc.state[3].type, 'A | B');
  // 简单名字不保留冗余结构；构造类型才带 typeExpr。
  const simple = parse('spec s version "1" { state { x: Bool; } }') as Spec;
  assert.equal(simple.state[0].typeExpr, undefined);
  assert.deepEqual(doc.state[1].typeExpr, { kind: 'apply', name: ['Entity'], args: [{ kind: 'name', path: ['H', 'Customer'] }] });
});

test('output, knowledge and verification sections are parsed with their own semantics', () => {
  const doc = parse(`spec s version "1" {
    output { chosen: Booking; }
    knowledge {
      open policy: CancellationPolicy;
      assert open24: hotel.isOpen == true source "feed" as asserted;
      ambiguous changeMeaning { candidates ChangeIn, ChangeOut; }
      assume travel: slot <= 24.hours source "policy" as inferred;
    }
    verification { verify noDouble by modelCheck("m") under a, b; }
  }`) as Spec;
  assert.equal(doc.output[0].name, 'chosen');
  assert.equal(doc.knowledge.length, 4);
  const claim = doc.knowledge[1];
  assert.equal(claim.kind, 'claim');
  if (claim.kind !== 'claim') return;
  assert.equal(claim.modality, 'assert');
  // 知识标签不是真值：asserted 只说明谁断言，不说明命题为真。
  assert.equal(claim.provenance?.label, 'asserted');
  assert.equal(doc.verification[0].verifier.name[0], 'modelCheck');
  assert.equal(doc.verification[0].under.length, 2);
});

test('prefer carries direction and priority, while achieve stays a plain claim', () => {
  const doc = parse(`spec s version "1" { goals {
    achieve booked: eventually within 2.minutes x == 1;
    prefer cost: minimize total priority 1;
  } }`) as Spec;
  assert.equal(doc.goals[0].kind, undefined);
  assert.deepEqual(doc.goals[0].expr, { kind: 'unary', op: 'eventually',
    arg: { kind: 'bounded', value: 2, unit: 'minutes', arg: { kind: 'binary', op: '==', left: ref('x'), right: literal(1) } } });
  assert.equal(doc.goals[1].kind, 'prefer');
  assert.equal(doc.goals[1].direction, 'minimize');
  assert.equal(doc.goals[1].priority, 1);
});

test('quantifiers accept shared types and do not confuse the separator dot with a qualified name', () => {
  const doc = parse(`spec s version "1" { goals { achieve g:
    exists b: H.Booking. chosen == b; } constraints { require r:
    always forall b1 b2: H.Booking. b1.room == b2.room; } }`) as Spec;
  assert.deepEqual(doc.goals[0].expr, { kind: 'quantifier', quantifier: 'exists',
    bindings: [{ name: 'b', type: 'H.Booking' }],
    body: { kind: 'binary', op: '==', left: ref('chosen'), right: ref('b') } });
  const always = doc.constraints[0].expr;
  assert.equal(always.kind, 'unary');
  if (always.kind !== 'unary' || always.arg.kind !== 'quantifier') return assert.fail('expected quantified constraint');
  assert.equal(always.arg.bindings.length, 2);
  assert.equal(always.arg.bindings[0].type, 'H.Booking');
});

test('action contracts carry returns, preserves, failures and reversibility', () => {
  const doc = parse(`spec s version "1" { action { action confirm(r: Request) -> Booking
    requires available(r)
    ensures result == r
    writes bookings
    preserves everythingExcept(bookings)
    atomic
    failure RoomUnavailable, PaymentRejected
    retryable false
    reversibility compensable
    compensate cancel(result); } }`) as Spec;
  const action = doc.actions[0];
  assert.equal(action.returns, 'Booking');
  assert.deepEqual(action.preserves, [{ kind: 'call', path: ['everythingExcept'], args: [ref('bookings')] }]);
  assert.deepEqual(action.failures, ['RoomUnavailable', 'PaymentRejected']);
  assert.equal(action.retryable, false);
  assert.equal(action.reversibility, 'compensable');
  assert.equal(action.compensate?.kind, 'call');
  // 具名结果是显式契约，不是异常。
  assert.equal(action.atomic, true);
});

test('lexicon definitions map phrases to candidates without assigning meaning', () => {
  const doc = parse('lexicon "hotel/english@2" version "1" for "hotel/core@3" { phrase "book" => candidate H.Book; phrase "change" => candidates H.ChangeIn, H.ChangeOut; }');
  assert.equal(doc.kind, 'lexicon');
  if (doc.kind !== 'lexicon') return;
  assert.equal(doc.ontology, 'hotel/core@3');
  assert.deepEqual(doc.entries[0].candidates, [['H', 'Book']]);
  assert.equal(doc.entries[1].candidates.length, 2);
});

test('the hotel example parses as a bundle of spec, interpretation and delegate', () => {
  const items = parseBundle(readFileSync(new URL('../examples/酒店预订.gil', import.meta.url), 'utf8'));
  assert.deepEqual(items.map(item => item.kind), ['spec', 'interpretation', 'delegate']);
  const spec = items[0];
  if (spec.kind !== 'spec') return assert.fail('expected spec');
  assert.equal(spec.name, 'HotelBooking');
  assert.equal(spec.imports[0].layer, undefined);
  assert.equal(spec.context[0].type, 'Entity<H.Customer>');
  // 来源标签只记录谁断言，不提升为已验证。
  assert.equal(spec.context[0].provenance?.label, 'asserted');
  assert.equal(spec.knowledge[0].kind, 'open');
  assert.equal(spec.actions[0].failures?.length, 2);
  const interpretation = items[1];
  if (interpretation.kind !== 'interpretation') return assert.fail('expected interpretation');
  // assume 是已声明的假设，不进入待澄清队列。
  assert.equal(interpretation.items.filter(item => item.kind === 'assume').length, 1);
  assert.equal(interpretation.imports[1].layer, 'lexicon');
  const delegation = items[2];
  if (delegation.kind !== 'delegate') return assert.fail('expected delegate');
  assert.equal(delegation.scope[0], 'TravelScope');
  assert.equal(delegation.autonomy, 'bounded');
  assert.deepEqual(delegation.budget, { amount: 300, currency: 'USD' });
  // 语法里的 scope/budget/autonomy 是请求，不是授权。
  assert.equal(delegation.expires?.unit, 'hours');
});

test('parse still rejects a file holding more than one top-level document', () => {
  assert.throws(() => parse('ontology "a" version "1" {} ontology "b" version "1" {}'),
    (error: unknown) => error instanceof GilError && /Only one top-level document/.test(error.message));
});

test('canonical rejects non-finite numeric AST values', () => {
  const doc = parse('spec s version "1" { state { x: Real = 1; } }') as Spec;
  doc.state[0].value = literal(Infinity);
  assert.throws(() => canonical(doc), (error: unknown) => error instanceof GilError && error.code === 'CANONICAL_ERROR');
});

test('parse CLI reports top-level items and never claims verification', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = (file: string) => JSON.parse(spawnSync(process.execPath, ['src/cli.ts', 'parse', file],
    { cwd: root, encoding: 'utf8' }).stdout);
  const hotel = run('examples/酒店预订.gil');
  assert.equal(hotel.ok, true);
  assert.equal(hotel.mode, 'parse-only');
  assert.match(hotel.warning, /PARSED ONLY/);
  assert.deepEqual(hotel.items, [
    { kind: 'spec', name: 'HotelBooking' },
    { kind: 'interpretation', name: 'I17' },
    { kind: 'delegate', name: 'reschedule' },
  ]);
  assert.deepEqual(run('examples/机器人导航.gil').items, [{ kind: 'environment', name: 'RobotNavigation' }]);
});
