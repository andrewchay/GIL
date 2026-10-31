/**
 * 求值层演示：量词、knowledge、偏好排序与动作返回值。
 *
 * 所有数据都是合成夹具。这里演示的是**判定行为**，不是业务正确性，也不是
 * 授权结论。每个场景都在输出里标明它证明了什么、没证明什么。
 */
import { parse } from './parser.ts';
import { link, check } from './checker.ts';
import { monitor, simulate, evaluate, isUnknown } from './runtime.ts';
import { rank } from './preference.ts';
import { GilError } from './ast.ts';
import type { Ontology, Spec } from './ast.ts';
import type { Check, Value } from './runtime.ts';

const ontology = parse(`ontology "procurement/core" version "1" {
  concept Quote { identity quoteId: Text; price: Int; leadDays: Int; approved: Text; }
}`) as Ontology;

const spec = parse(`spec QuoteSelection version "1" {
  use ontology "procurement/core@1" as P;

  input { budget: Int; }
  state { selected: P.Quote; }

  knowledge {
    open freightPolicy: Int;
  }

  constraints {
    // Core 的 always 只绑定紧随的 unary 表达式，包住比较必须加括号。
    require withinBudget: always (budget > 0);
  }

  goals {
    prefer cheap: minimize quote.price priority 1;
    prefer fast: minimize quote.leadDays priority 2;
  }

  action {
    action choose(q: P.Quote) -> P.Quote
      requires q.price <= budget
      writes selected
      ensures selected' == result
      atomic
      failure OverBudget
      retryable false
      reversibility reversible;
  }
}`) as Spec;

const program = link(spec, [ontology]);
const quote = (quoteId: string, price: number, leadDays: number, approved = 'PENDING') => ({ quoteId, price, leadDays, approved });

function reasonOf(value: Value): string | null {
  return isUnknown(value) ? value.reason : null;
}
function checks(entries: Check[]): { name: string; value: unknown; reason?: string }[] {
  return entries.map(entry => ({
    name: entry.name,
    value: isUnknown(entry.value) ? 'Unknown' : entry.value,
    ...(isUnknown(entry.value) ? { reason: entry.value.reason } : {}),
  }));
}
function capture(run: () => unknown): string {
  try { run(); return 'no-error'; }
  catch (error) { return error instanceof GilError ? error.code : 'UNEXPECTED'; }
}

export function evaluationDemo(): Record<string, unknown> {
  const warning = 'SYNTHETIC ONLY: these are decision traces over fixture data, not pricing, procurement or authorization outcomes';

  /* 1. 量词：域必须显式提供。 */
  const quantified = link(parse(`spec Q version "1" {
    use ontology "procurement/core@1" as P;
    input { quotes: Text; }
    state { note: Text; }
    constraints { require allApproved: forall q: P.Quote. q.approved == "APPROVED"; }
  }`) as Spec, [ontology]);
  const quantifiedGoal = quantified.spec.constraints[0].expr;
  const quantifier = {
    withoutDomain: capture(() => evaluate(quantifiedGoal, quantified, { state: {}, locals: {} })),
    emptyDomain: evaluate(quantifiedGoal, quantified, { state: {}, locals: {}, domains: { 'P.Quote': [] } }),
    allApproved: evaluate(quantifiedGoal, quantified, {
      state: {}, locals: {}, domains: { 'P.Quote': [quote('A', 10, 1, 'APPROVED'), quote('B', 20, 2, 'APPROVED')] } }),
    onePending: evaluate(quantifiedGoal, quantified, {
      state: {}, locals: {}, domains: { 'P.Quote': [quote('A', 10, 1, 'APPROVED'), quote('B', 20, 2)] } }),
  };

  /* 2. knowledge：open 是缺值，不是"已满足"。 */
  const openSpec = link(parse(`spec K version "1" {
    use ontology "procurement/core@1" as P;
    input { budget: Int; }
    state { note: Text; }
    knowledge { open freightPolicy: Int; }
    constraints { require knownFreight: freightPolicy == 0; }
  }`) as Spec, [ontology]);
  const openResult = monitor(openSpec, { note: 'n' }, { budget: 100 });
  const ambiguous = link(parse(`spec K version "1" {
    use ontology "procurement/core@1" as P;
    state { note: Text; }
    knowledge { ambiguous shipMode { candidates P.AirFreight, P.SeaFreight; } }
    constraints { require chosen: shipMode == 1; }
  }`) as Spec, [ontology]);
  const knowledge = {
    openValue: openResult.constraints.map(entry => ({ value: isUnknown(entry.value) ? 'Unknown' : entry.value, reason: reasonOf(entry.value) }))[0],
    ambiguousReference: capture(() => monitor(ambiguous, { note: 'n' })),
  };

  /* 3. 偏好：只给顺序，不给许可。 */
  const ranked = rank(program, [
    { label: 'cheapSlow', env: { state: {}, inputs: { budget: 500 }, quote: quote('A', 100, 9) } as never },
    { label: 'priceyFast', env: { state: {}, inputs: { budget: 500 }, quote: quote('B', 300, 1) } as never },
    { label: 'incomplete', env: { state: {}, inputs: { budget: 500 }, quote: { quoteId: 'C' } } as never },
  ]);
  const preference = {
    objectives: ranked.objectives,
    order: ranked.order.map(entry => entry.label),
    complete: ranked.complete,
    note: 'priority 1 compares price first, so cheapSlow wins even though priceyFast is faster; incomplete has an Unknown objective and is not ranked against them',
  };

  /* 4. 动作返回值与具名失败。 */
  const blocked = simulate(program, { selected: quote('A', 100, 9) }, { budget: 50 }, 'choose', { q: quote('A', 100, 9) });
  const missingResult = capture(() => simulate(program, { selected: quote('A', 100, 9) }, { budget: 500 }, 'choose', { q: quote('A', 100, 9) }));
  const succeeded = simulate(program, { selected: quote('A', 100, 9) }, { budget: 500 }, 'choose', { q: quote('A', 100, 9) },
    { result: quote('A', 100, 9, 'SELECTED') });
  const action = program.spec.actions[0];
  const contract = {
    requiresFailed: blocked.ok ? 'unexpected-success' : { stage: blocked.stage, declaredFailures: blocked.declaredFailures, retryable: blocked.retryable },
    missingResult,
    succeeded: succeeded.ok ? { selected: succeeded.state.selected, result: succeeded.result } : { stage: succeeded.stage },
    declarationsOnly: { reversibility: action.reversibility, compensate: action.compensate ?? null },
    note: 'requires failure never chooses one named failure; the simulator also does not retry or compensate',
  };

  const diagnostics = check(program).map(entry => entry.code);

  return {
    ok: quantifier.withoutDomain === 'UNBOUNDED_DOMAIN'
      && quantifier.emptyDomain === true
      && quantifier.onePending === false
      && knowledge.ambiguousReference === 'AMBIGUOUS_REFERENCE'
      && preference.complete === false
      && contract.missingResult === 'MISSING_RESULT'
      && !blocked.ok,
    mode: 'synthetic-evaluation-simulation',
    authorization: 'not-implemented',
    warning,
    quantifier,
    knowledge,
    preference,
    contract,
    checkerDiagnostics: diagnostics,
    boundaries: [
      'a quantifier domain must be supplied by the host; Core never infers "all orders" from state',
      'open knowledge is a missing value, ambiguous knowledge has no single candidate',
      'ranking compares preferences only; it never authorizes execution',
      'unit quantities such as 2.minutes have no dimension model and are not evaluated',
      'compensation and retry are declarations only; no execution path exists',
    ],
  };
}
