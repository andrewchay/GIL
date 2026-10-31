import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { link, check } from '../src/checker.ts';
import { evaluate, initialize, monitor, unknown, isUnknown } from '../src/runtime.ts';
import type { State } from '../src/runtime.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GilError } from '../src/ast.ts';
import type { Ontology, Spec } from '../src/ast.ts';

const ontology = parse(`ontology "shop/core" version "1" {
  concept Order { identity orderId: Text; total: Int; status: Text; }
}`) as Ontology;

const spec = (body: string): Spec => parse(`spec s version "1" {
  use ontology "shop/core@1" as H;
  input { limit: Int; }
  state { orders: Text; }
  ${body}
}`) as Spec;

const linked = (body: string) => link(spec(body), [ontology]);
const domain = (orders: State[]): Record<string, State[]> => ({ 'H.Order': orders });
const order = (orderId: string, total: number, status = 'OPEN'): State => ({ orderId, total, status });

test('a quantifier without an explicit domain is ill-formed, not Unknown', () => {
  const env = { state: {}, locals: {} } as never;
  const program = linked('goals { achieve g: forall o: H.Order. o.total > 0; }');
  const goal = program.spec.goals[0].expr;
  // 没有域就无法判定：这是规约缺少可求值的域，不是"信息不足"。
  assert.throws(() => evaluate(goal, program, env), (error: unknown) =>
    error instanceof GilError && error.code === 'UNBOUNDED_DOMAIN');
});

test('empty domains follow the definition: forall is true, exists is false', () => {
  const program = linked('goals { achieve g: forall o: H.Order. o.total > 0; }');
  const forall = program.spec.goals[0].expr;
  assert.equal(evaluate(forall, program, { state: {}, locals: {}, domains: domain([]) }), true);
  const existsProgram = linked('goals { achieve g: exists o: H.Order. o.total > 0; }');
  assert.equal(evaluate(existsProgram.spec.goals[0].expr, existsProgram, { state: {}, locals: {}, domains: domain([]) }), false);
});

test('quantifiers short-circuit but Unknown outranks an undecided element', () => {
  const program = linked('goals { achieve g: forall o: H.Order. o.total > 0; }');
  const forall = program.spec.goals[0].expr;
  // 一条反例就足以判定为假，剩余元素不再求值。
  assert.equal(evaluate(forall, program, { state: {}, locals: {}, domains: domain([order('A', -1), order('B', 5)]) }), false);
  // 缺字段给 Unknown：既没有反例也没有全称证明。
  const partial = evaluate(forall, program, { state: {}, locals: {}, domains: domain([{ orderId: 'A' }, order('B', 5)]) });
  assert.ok(isUnknown(partial), 'missing field must stay Unknown');
  assert.match(String((partial as ReturnType<typeof unknown>).reason), /Missing field/);

  const existsProgram = linked('goals { achieve g: exists o: H.Order. o.total > 5; }');
  const exists = existsProgram.spec.goals[0].expr;
  assert.equal(evaluate(exists, existsProgram, { state: {}, locals: {}, domains: domain([order('A', 1), order('B', 9)]) }), true);
  assert.ok(isUnknown(evaluate(exists, existsProgram, { state: {}, locals: {}, domains: domain([{ orderId: 'A' }, order('B', 1)]) })));
});

test('nested quantifier bindings quantify over the product of domains', () => {
  const program = linked(`goals { achieve g: forall a b: H.Order. a.orderId == b.orderId || a.orderId != b.orderId; }`);
  const goal = program.spec.goals[0].expr;
  const value = evaluate(goal, program, { state: {}, locals: {}, domains: domain([order('A', 1), order('B', 2)]) });
  // 恒真式在二元域上成立；它证明的是求值器遍历了整个笛卡尔积，不是业务正确性。
  assert.equal(value, true);
});

test('quantifier domains are type-checked instead of trusted blindly', () => {
  const program = linked('goals { achieve g: forall o: H.Order. o.total > 0; }');
  const goal = program.spec.goals[0].expr;
  assert.throws(() => evaluate(goal, program, { state: {}, locals: {}, domains: { 'H.Order': [{ orderId: 'A', total: 'x' }] } }),
    (error: unknown) => error instanceof GilError && error.code === 'TYPE_ERROR');
  assert.throws(() => evaluate(goal, program, { state: {}, locals: {}, domains: { 'H.Order': [{ orderId: 'A', extra: 1 }] } }),
    (error: unknown) => error instanceof GilError && error.code === 'TYPE_ERROR');
});

test('open knowledge yields Unknown; a missing value never becomes success', () => {
  const program = linked(`knowledge { open policy: H.Order; }
    constraints { require r: policy.status == "OPEN"; }`);
  const result = monitor(program, { orders: 'x' });
  assert.ok(isUnknown(result.constraints[0].value), 'open parameter must stay Unknown');
  assert.match(result.constraints[0].value.reason ?? '', /Open parameter policy/);
});

test('ambiguous knowledge has no single candidate, so referencing it is ill-formed', () => {
  const program = linked(`knowledge { ambiguous change { candidates H.ChangeIn, H.ChangeOut; } }
    constraints { require r: change == 1; }`);
  assert.throws(() => monitor(program, { orders: 'x' }), (error: unknown) =>
    error instanceof GilError && error.code === 'AMBIGUOUS_REFERENCE');
});

test('asserted knowledge is usable as a value but stays a claim, not a fact', () => {
  const program = linked(`knowledge { assert cap: limit >= 0 source "config" as asserted; }
    constraints { require r: cap == true; }`);
  const result = monitor(program, { orders: 'x' }, { limit: 5 });
  // 名字能求值，说明 assert 提供了定义；值仍取决于它引用的输入。
  assert.equal(result.constraints[0].value, true);
  const negated = monitor(program, { orders: 'x' }, { limit: -1 });
  assert.equal(negated.constraints[0].value, false);
});

test('self-referential knowledge is rejected instead of looping', () => {
  const program = linked(`knowledge { assert loop: loop == 1 source "x" as asserted; }
    constraints { require r: loop == 1; }`);
  assert.throws(() => monitor(program, { orders: 'x' }), (error: unknown) =>
    error instanceof GilError && error.code === 'UNSUPPORTED_PROFILE');
});

test('unit quantities are parsed but have no dimension model yet', () => {
  const program = linked(`goals { achieve g: eventually within 2.minutes limit > 0; }`);
  const goal = program.spec.goals[0].expr;
  const bound = goal.kind === 'unary' ? goal.arg : undefined;
  assert.equal(bound?.kind, 'bounded');
  // 界限只被记录；Core 没有时间推进，不能把 2.minutes 当作可判定条件。
  assert.throws(() => evaluate(bound!, program, { state: {}, locals: {}, inputs: { limit: 1 } }),
    (error: unknown) => error instanceof GilError && error.code === 'UNSUPPORTED_PROFILE');
});

test('checker reports quantified and quantity expressions as outside the evaluated profile', () => {
  const program = linked('goals { achieve g: forall o: H.Order. o.total > 0; }');
  const diagnostics = check(program);
  assert.ok(diagnostics.some(entry => entry.code === 'UNSUPPORTED_EXPRESSION'));
});

test('initialize still resolves ordered context defaults without certifying invariants', () => {
  const program = linked('constraints { require r: orders == "x"; }');
  const state = initialize(program, {});
  assert.ok(isUnknown(state.orders), 'missing state stays Unknown until a fixture supplies it');
});

test('the evaluation CLI demo exercises every new decision path', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-evaluation'], { cwd: root, encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'synthetic-evaluation-simulation');
  assert.equal(out.authorization, 'not-implemented');
  assert.match(out.warning, /SYNTHETIC ONLY/);
  // 域缺失是 ill-formed，空域按定义为真。
  assert.equal(out.quantifier.withoutDomain, 'UNBOUNDED_DOMAIN');
  assert.equal(out.quantifier.emptyDomain, true);
  assert.equal(out.quantifier.onePending, false);
  // open 是缺值，ambiguous 没有单一候选。
  assert.equal(out.knowledge.openValue.value, 'Unknown');
  assert.equal(out.knowledge.ambiguousReference, 'AMBIGUOUS_REFERENCE');
  // 排序不完整时必须说 incomplete，而不是声称剩余候选更差。
  assert.equal(out.preference.complete, false);
  assert.deepEqual(out.preference.order, ['cheapSlow', 'priceyFast', 'incomplete']);
  assert.equal(out.contract.missingResult, 'MISSING_RESULT');
  assert.deepEqual(out.contract.requiresFailed.declaredFailures, ['OverBudget']);
  assert.equal(out.contract.requiresFailed.retryable, false);
});

test('a knowledge item cannot share a name with a global, so open is never shadowed', () => {
  const shadowed = link(parse(`spec s version "1" {
    input { limit: Int; } state { x: Int; }
    knowledge { open limit: Int; }
    constraints { require r: limit > 0; } }`) as Spec, []);
  assert.ok(check(shadowed).some(entry => entry.code === 'DUPLICATE_NAME' && /limit/.test(entry.message)));
  const output = link(parse(`spec s version "1" {
    output { chosen: Int; } state { x: Int; }
    knowledge { open chosen: Int; } }`) as Spec, []);
  assert.ok(check(output).some(entry => entry.code === 'DUPLICATE_NAME' && /chosen/.test(entry.message)));
});

test('operationalize items are keyed by phrase and never enter the name space', () => {
  const doc = parse(`spec s version "1" { state { x: Int; }
    knowledge { operationalize "soon" as x > 0; operationalize "late" as x > 9; } }`) as Spec;
  assert.equal(doc.knowledge.length, 2);
  assert.deepEqual(check(link(doc, [])).filter(entry => entry.code === 'DUPLICATE_NAME'), []);
  assert.throws(() => parse(`spec s version "1" { knowledge { operationalize "soon" as true; operationalize "soon" as false; } }`),
    (error: unknown) => error instanceof GilError && error.code === 'DUPLICATE_CLAUSE');
});

test('B1: temporal operators bind to the comparison level in Core', () => {
  const goal = (text: string) => (parse(`spec s version "1" { goals { achieve g: ${text}; } }`) as Spec).goals[0].expr;
  // eventually within 与 always 共用同一绑定规则。
  const bounded = goal('eventually within 2.minutes a == b');
  const plain = goal('always a == b');
  assert.equal(bounded.kind === 'unary' && bounded.arg.kind === 'bounded' && bounded.arg.arg.kind, 'binary');
  assert.equal(plain.kind === 'unary' && plain.arg.kind, 'binary');
  // && 仍在时序运算符之外，需要括号才能包进去。
  const conj = goal('always a == b && c');
  assert.equal(conj.kind === 'binary' && conj.op, '&&');
  // not 在 Core 仍只绑定 unary。
  const negated = goal('not a == b');
  assert.equal(negated.kind === 'binary' && negated.op, '==');
});
