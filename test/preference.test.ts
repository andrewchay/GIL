import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { link } from '../src/checker.ts';
import { rank, objectives } from '../src/preference.ts';
import { GilError } from '../src/ast.ts';
import type { Ontology, Spec } from '../src/ast.ts';

const ontology = parse(`ontology "shop/core" version "1" {
  concept Quote { identity quoteId: Text; price: Int; days: Int; }
}`) as Ontology;

const program = (goals: string): ReturnType<typeof link> => link(parse(`spec s version "1" {
  use ontology "shop/core@1" as H;
  input { quote: H.Quote; }
  ${goals}
}`) as Spec, [ontology]);

const quote = (price: number, days: number): { state: {}; inputs: { quote: { quoteId: string; price: number; days: number } } } =>
  ({ state: {}, inputs: { quote: { quoteId: 'Q', price, days } } });

const rejected = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => {
  assert.ok(error instanceof GilError, `expected GilError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
});

test('priority order decides the lexicographic comparison before direction', () => {
  const linked = program('goals { prefer cheap: minimize quote.price priority 1; prefer fast: minimize quote.days priority 2; }');
  // 声明顺序与优先级相反：优先级 1 的 cheap 先比较。
  assert.deepEqual(objectives(linked.spec.goals).map(entry => entry.name), ['cheap', 'fast']);
  const result = rank(linked, [
    { label: 'slowCheap', env: quote(100, 9) as never },
    { label: 'fastPricey', env: quote(200, 1) as never },
  ]);
  // 低价优先于快，即使后者天数更少。
  assert.deepEqual(result.order.map(entry => entry.label), ['slowCheap', 'fastPricey']);
  assert.equal(result.complete, true);
  assert.equal(result.ranking, 'preference-only');
});

test('maximize reverses direction without touching priority', () => {
  const linked = program('goals { prefer roomy: maximize quote.days priority 1; }');
  const result = rank(linked, [
    { label: 'short', env: quote(100, 2) as never },
    { label: 'long', env: quote(100, 7) as never },
  ]);
  assert.deepEqual(result.order.map(entry => entry.label), ['long', 'short']);
});

test('an Unknown objective makes the candidate incomparable instead of worst', () => {
  const linked = program('goals { prefer cheap: minimize quote.price priority 1; }');
  const missing = { state: {}, inputs: { quote: { quoteId: 'Q' } } };
  const result = rank(linked, [
    { label: 'known', env: quote(500, 1) as never },
    { label: 'unknown', env: missing as never },
  ]);
  // 取不到值不等于值很差：它排在后面，但 complete 为 false。
  assert.deepEqual(result.order.map(entry => entry.label), ['known', 'unknown']);
  assert.equal(result.complete, false);
});

test('a non-numeric objective is rejected rather than silently skipped', () => {
  const linked = program('goals { prefer weird: minimize quote.quoteId priority 1; }');
  rejected(() => rank(linked, [{ label: 'a', env: quote(1, 1) as never }]), 'INVALID_PREFERENCE');
});

test('duplicate priorities, missing direction and missing priority are rejected', () => {
  rejected(() => objectives([{ name: 'a', expr: { kind: 'literal', value: 1 }, kind: 'prefer', direction: 'minimize', priority: 1 },
    { name: 'b', expr: { kind: 'literal', value: 1 }, kind: 'prefer', direction: 'minimize', priority: 1 }]), 'DUPLICATE_PRIORITY');
  rejected(() => objectives([{ name: 'a', expr: { kind: 'literal', value: 1 }, kind: 'prefer', priority: 1 }]), 'INVALID_PREFERENCE');
  rejected(() => objectives([{ name: 'a', expr: { kind: 'literal', value: 1 }, kind: 'prefer', direction: 'minimize' }]), 'INVALID_PREFERENCE');
});

test('candidate labels must be unique, so a ranking cannot hide one option', () => {
  const linked = program('goals { prefer cheap: minimize quote.price priority 1; }');
  rejected(() => rank(linked, [{ label: 'same', env: quote(1, 1) as never }, { label: 'same', env: quote(2, 1) as never }]),
    'INVALID_PREFERENCE');
});

test('achieved goals never enter the preference ordering', () => {
  const linked = program('goals { achieve booked: quote.price > 0; prefer cheap: minimize quote.price priority 1; }');
  // 只有 prefer 参与排序；achieve 是约束式目标，不产生分数。
  assert.deepEqual(objectives(linked.spec.goals).map(entry => entry.name), ['cheap']);
});
