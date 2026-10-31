import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.ts';
import { link } from '../src/checker.ts';
import { simulate } from '../src/runtime.ts';
import { GilError } from '../src/ast.ts';
import type { Ontology, Spec } from '../src/ast.ts';

const ontology = parse(`ontology "shop/core" version "1" {
  concept Booking { identity bookingId: Text; status: Text; }
}`) as Ontology;

const program = (action: string): ReturnType<typeof link> => link(parse(`spec s version "1" {
  use ontology "shop/core@1" as H;
  input { requested: Text; }
  output { chosen: H.Booking; }
  state { chosen: H.Booking; }
  action { ${action} }
}`) as Spec, [ontology]);

const booking = (status: string) => ({ bookingId: 'B1', status });
const rejected = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => {
  assert.ok(error instanceof GilError, `expected GilError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
});

test('a declared return value must be supplied; the simulator never invents one', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires true writes chosen ensures chosen' == result;`);
  rejected(() => simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'B1' }), 'MISSING_RESULT');
});

test('an undeclared return value is rejected instead of silently ignored', () => {
  const linked = program(`action cancel(r: Text) requires true writes chosen ensures chosen' == result;`);
  rejected(() => simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'cancel', { r: 'B1' },
    { result: booking('CANCELLED') } as never), 'UNEXPECTED_RESULT');
});

test('result participates in ensures with its declared type', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires true writes chosen ensures chosen' == result;`);
  const outcome = simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'B1' },
    { result: booking('CONFIRMED') });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.state.chosen, booking('CONFIRMED'));
  assert.deepEqual(outcome.result, booking('CONFIRMED'));
});

test('a return value of the wrong type is a type error, not a failed contract', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires true writes chosen ensures chosen' == result;`);
  rejected(() => simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'B1' },
    { result: 'not-a-booking' as never }), 'TYPE_ERROR');
  rejected(() => simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'B1' },
    { result: { bookingId: 'B1', extra: 1 } as never }), 'TYPE_ERROR');
});

test('declared failures are reported as candidates, never picked as the reason', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires r == "available"
    writes chosen
    ensures chosen' == result
    failure RoomUnavailable, PaymentRejected;`);
  const outcome = simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'busy' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'requires');
  // 规约没有说明是"房间不可用"还是"支付被拒"；模拟器不得二选一。
  assert.deepEqual(outcome.declaredFailures, ['RoomUnavailable', 'PaymentRejected']);
});

test('retryable is surfaced as a declaration, and the simulator does not retry', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires r == "available" writes chosen ensures chosen' == result retryable false;`);
  const outcome = simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'busy' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.retryable, false);
  // 结果里没有重试计数或重放痕迹：重试语义未实现。
  assert.equal(Object.hasOwn(outcome, 'attempts'), false);
});

test('reversibility and compensate stay declarations with no execution path', () => {
  const linked = program(`action confirm(r: Text) -> H.Booking
    requires true
    writes chosen
    ensures chosen' == result
    reversibility compensable
    compensate cancel(result);`);
  const action = linked.spec.actions[0];
  assert.equal(action.reversibility, 'compensable');
  assert.equal(action.compensate?.kind, 'call');
  const outcome = simulate(linked, { chosen: booking('OPEN') }, { requested: 'B1' }, 'confirm', { r: 'B1' },
    { result: booking('CONFIRMED') });
  // 成功模拟不等于补偿可用：没有任何字段声称可以自动撤销。
  assert.equal(outcome.ok, true);
  assert.equal(Object.hasOwn(outcome, 'compensation'), false);
});
