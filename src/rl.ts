// GIL-RL 运行时：有限随机环境的确定性回放。
// 所有随机性来自显式种子；转移概率与奖励值全部取自声明，运行时不发明数值。
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import { checkEnvironment } from './rl-checker.ts';
import type { Expr } from './ast.ts';
import type { Environment, Primitives, RewardTerm } from './rl-ast.ts';

export type RlState = Record<string, unknown>;
export type Terminal = 'success' | 'failure' | 'cutoff';
export interface PolicyDecision { action: string; params?: RlState }
/** 策略是宿主提供的搜索/学习结果；GIL 只声明它必须满足的边界。 */
export type Policy = (state: Readonly<RlState>, step: number) => PolicyDecision;

export interface StepRecord {
  index: number;
  action: string;
  params: RlState;
  probability: number;
  before: RlState;
  after: RlState;
  reward: number;
  rewardTerms: Record<string, number>;
  violations: string[];
}

export interface Episode {
  seed: number;
  steps: StepRecord[];
  terminal: Terminal;
  /** 折扣回报，按声明顺序累加。 */
  return: number;
  violations: string[];
  goalsSatisfied: string[];
  traceHash: string;
}

export interface Runtime { env: Environment; primitives: Primitives; initialState: RlState }

export interface RolloutOptions { seed: number; maxSteps: number }

export interface EvaluationReport {
  episodes: number;
  meanReturn: number;
  successRate: number;
  failureRate: number;
  cutoffRate: number;
  violationRate: number;
  /** 评估绑定：环境/奖励版本、种子与覆盖范围。 */
  bindings: {
    environment: string; environmentVersion: string; rewardVersion: string;
    discount: number; seeds: number[]; maxSteps: number; episodes: number;
    observation: 'full' | 'partial';
  };
}

const fail = (code: string, message: string): never => { throw new GilError(code, message); };

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** mulberry32：小、确定、可复现；仅用于合成环境，不是密码学随机源。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRuntime(env: Environment, primitives: Primitives): Runtime {
  const diagnostics = checkEnvironment(env);
  if (diagnostics.length) fail('INVALID_ENVIRONMENT', `Environment failed static checks: ${JSON.stringify(diagnostics)}`);
  const state: RlState = {};
  for (const assertion of env.initial) {
    // checker 已保证形状：根引用 == 表达式。
    if (assertion.kind !== 'binary' || assertion.left.kind !== 'ref') fail('INVALID_INITIAL', 'Initial condition is not an equality');
    state[assertion.left.path[0]] = evaluate(assertion.right, state, {}, primitives);
  }
  return { env, primitives, initialState: state };
}

function primitive(primitives: Primitives, name: string): unknown {
  if (Object.hasOwn(primitives.constants, name)) return primitives.constants[name];
  return fail('UNKNOWN_PRIMITIVE', `Environment primitive ${name} was not supplied by the host`);
}

/** 单步求值：时序外壳（always/eventually/within）由回放层处理，这里只看当前值。 */
export function evaluate(expr: Expr, state: RlState, params: RlState, primitives: Primitives): unknown {
  switch (expr.kind) {
    case 'literal': return expr.value;
    case 'ref': {
      if (expr.next) fail('INVALID_EXPRESSION', 'Next-state reference outside a transition');
      const root = expr.path[0];
      if (Object.hasOwn(params, root)) return params[root];
      if (Object.hasOwn(state, root)) return state[root];
      return primitive(primitives, root);
    }
    case 'call': {
      const name = expr.path.join('.');
      if (!Object.hasOwn(primitives.relations, name)) fail('UNKNOWN_PRIMITIVE', `Environment relation ${name} was not supplied by the host`);
      const args = expr.args.map(arg => evaluate(arg, state, params, primitives));
      return primitives.relations[name](...args);
    }
    case 'bounded': return evaluate(expr.arg, state, params, primitives);
    case 'unary': {
      if (expr.op === 'always' || expr.op === 'eventually') return evaluate(expr.arg, state, params, primitives);
      const value = evaluate(expr.arg, state, params, primitives);
      if (expr.op === '!') return !truthy(value, '!');
      if (expr.op === '-') return -number(value);
      return fail('UNSUPPORTED_EXPRESSION', `Unsupported unary operator ${expr.op}`);
    }
    case 'binary': {
      if (expr.op === 'in') {
        const value = evaluate(expr.left, state, params, primitives);
        if (expr.right.kind !== 'ref') fail('INVALID_EXPRESSION', 'The right side of `in` must name a host set');
        const setName = expr.right.path[0];
        if (!Object.hasOwn(primitives.membership, setName)) fail('UNKNOWN_PRIMITIVE', `Host set ${setName} was not supplied`);
        return primitives.membership[setName](value);
      }
      if (expr.op === '&&' || expr.op === '||') {
        // 短路求值：避免在已判定的分支上触发无关原语。
        const left = truthy(evaluate(expr.left, state, params, primitives), expr.op);
        if (expr.op === '&&' && !left) return false;
        if (expr.op === '||' && left) return true;
        return truthy(evaluate(expr.right, state, params, primitives), expr.op);
      }
      const left = evaluate(expr.left, state, params, primitives);
      const right = evaluate(expr.right, state, params, primitives);
      switch (expr.op) {
        case '==': return deepEqual(left, right);
        case '!=': return !deepEqual(left, right);
        case '+': return number(left) + number(right);
        case '-': return number(left) - number(right);
        case '*': return number(left) * number(right);
        case '/': return number(left) / number(right);
        case '<': return number(left) < number(right);
        case '<=': return number(left) <= number(right);
        case '>': return number(left) > number(right);
        case '>=': return number(left) >= number(right);
        default: return fail('UNSUPPORTED_EXPRESSION', `Unsupported binary operator ${expr.op}`);
      }
    }
    default: return fail('UNSUPPORTED_EXPRESSION', 'Unsupported expression');
  }
}

function truthy(value: unknown, op: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('TYPE_ERROR', `Expected Bool for ${op}, got ${typeof value}`);
}

function number(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('TYPE_ERROR', `Expected finite number, got ${typeof value}`);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (isPlain(left) && isPlain(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
    return true;
  }
  return false;
}

function truthOf(expr: Expr, state: RlState, primitives: Primitives, label: string, params: RlState = {}): boolean {
  return truthy(evaluate(expr, state, params, primitives), label);
}

/** 终止判定：success / failure / cutoff 三者互不蕴含。 */
export function terminalOf(runtime: Runtime, state: RlState, step: number, maxSteps: number): Terminal | null {
  const { termination } = runtime.env;
  if (termination.failure && truthOf(termination.failure, state, runtime.primitives, 'failure')) return 'failure';
  if (termination.success && truthOf(termination.success, state, runtime.primitives, 'success')) return 'success';
  if (termination.cutoff && truthOf(termination.cutoff, state, runtime.primitives, 'cutoff')) return 'cutoff';
  // 未声明显式 cutoff 时，回放上限只是运行参数，语义仍记为 cutoff。
  if (step >= maxSteps) return 'cutoff';
  return null;
}

export function violationsOf(runtime: Runtime, state: RlState): string[] {
  return runtime.env.constraints
    .filter(constraint => !truthOf(constraint.expr, state, runtime.primitives, `constraint ${constraint.name}`))
    .map(constraint => constraint.name);
}

export function goalsSatisfiedAt(runtime: Runtime, state: RlState): string[] {
  return runtime.env.goals
    .filter(goal => truthOf(goal.expr, state, runtime.primitives, `goal ${goal.name}`))
    .map(goal => goal.name);
}

interface Transition { next: RlState; probability: number }

/**
 * 单步转移。声明了 outcomes 时按概率抽样；否则使用 ensures（确定性）。
 * 赋值目标必须在 writes 内，且必须是指向状态根的 next 引用。
 */
export function transition(runtime: Runtime, state: RlState, decision: PolicyDecision, draw: () => number): Transition {
  const action = runtime.env.actions.find(item => item.name === decision.action)
    ?? fail('UNKNOWN_ACTION', `Environment has no action ${decision.action}`);
  const params = isPlain(decision.params) ? decision.params : {};
  for (const requirement of action.requires) {
    if (!truthOf(requirement, state, runtime.primitives, `requires of ${action.name}`, params)) {
      fail('PRECONDITION_FAILED', `Action ${action.name} is not executable in this state`);
    }
  }
  let branch: number | null = null, probability = 1;
  if (action.outcomes.length) {
    const sample = draw();
    let cumulative = 0;
    for (const [index, outcome] of action.outcomes.entries()) {
      cumulative += outcome.probability;
      if (sample < cumulative) { branch = index; probability = outcome.probability; break; }
    }
    // 浮点累加可能略小于 1，落到最后一支。
    if (branch === null) { branch = action.outcomes.length - 1; probability = action.outcomes[branch].probability; }
  }
  const ensures = branch === null ? action.ensures : [action.outcomes[branch].ensures];
  const writes = new Set(action.writes);
  const next: RlState = { ...state };
  for (const clause of ensures) {
    if (clause.kind !== 'binary' || clause.op !== '==' || clause.left.kind !== 'ref' || !clause.left.next
      || clause.left.path.length !== 1) {
      fail('UNSUPPORTED_POSTCONDITION', `Action ${action.name} must assign root next-state references`);
    }
    const target = clause.left.path[0];
    if (!writes.has(target)) fail('FRAME_VIOLATION', `Action ${action.name} assigns ${target} outside writes`);
    next[target] = evaluate(clause.right, state, params, runtime.primitives);
  }
  return { next, probability };
}

/** 转移奖励：per-step 每步累加，once-entered 只在首次进入时领取一次。 */
export function rewardOf(runtime: Runtime, before: RlState, after: RlState, claimed: Set<string>): { total: number; terms: Record<string, number> } {
  const terms: Record<string, number> = {};
  let total = 0;
  for (const term of runtime.env.reward.terms) {
    if (term.kind === 'per-step') { terms[term.name] = term.amount; total += term.amount; continue; }
    if (claimed.has(term.name)) continue;
    const predicate = term.predicate ?? fail('INVALID_REWARD', `Term ${term.name} has no predicate`);
    // 一次性奖励以"进入"判定：前一状态不满足、后一状态满足。
    if (truthOf(predicate, after, runtime.primitives, `reward ${term.name}`)
      && !truthOf(predicate, before, runtime.primitives, `reward ${term.name}`)) {
      terms[term.name] = term.amount; total += term.amount; claimed.add(term.name);
    }
  }
  return { total, terms };
}

/** 单回合回放。策略不可执行时记违反并终止，不伪造后继状态。 */
export function rollout(runtime: Runtime, policy: Policy, options: RolloutOptions): Episode {
  const { seed, maxSteps } = options;
  if (!Number.isSafeInteger(seed)) fail('INVALID_SEED', 'seed must be a safe integer');
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) fail('INVALID_HORIZON', 'maxSteps must be a positive safe integer');
  const draw = rng(seed);
  let state: RlState = { ...runtime.initialState };
  const steps: StepRecord[] = [], violations: string[] = [], satisfied = new Set<string>();
  const claimed = new Set<string>();
  let terminal: Terminal | null = null;
  let index = 0;
  while (terminal === null) {
    terminal = terminalOf(runtime, state, index, maxSteps);
    if (terminal !== null) break;
    for (const name of violationsOf(runtime, state)) if (!violations.includes(name)) violations.push(name);
    for (const name of goalsSatisfiedAt(runtime, state)) satisfied.add(name);
    const decision = policy(state, index);
    let moved: Transition;
    try { moved = transition(runtime, state, decision, draw); }
    catch (error) {
      // 不可执行的策略动作是违反，不是正常终止。
      const code = error instanceof GilError ? error.code : 'POLICY_ERROR';
      violations.push(`${code}:${decision.action}@${index}`);
      break;
    }
    const reward = rewardOf(runtime, state, moved.next, claimed);
    steps.push({ index, action: decision.action, params: isPlain(decision.params) ? { ...decision.params } : {},
      probability: moved.probability, before: { ...state }, after: { ...moved.next },
      reward: reward.total, rewardTerms: reward.terms, violations: violationsOf(runtime, moved.next) });
    state = moved.next;
    index++;
  }
  for (const name of violationsOf(runtime, state)) if (!violations.includes(name)) violations.push(name);
  for (const name of goalsSatisfiedAt(runtime, state)) satisfied.add(name);
  terminal = terminal ?? 'cutoff';
  const discount = runtime.env.reward.discount;
  let total = 0;
  for (const step of steps) total += step.reward * discount ** step.index;
  const traceHash = hashValue({ steps, terminal, violations });
  return { seed, steps, terminal, return: total, violations, goalsSatisfied: [...satisfied], traceHash };
}

/** 多条轨迹的聚合评估。种子显式给出，报告里回填，保证可比较。 */
export function evaluatePolicy(runtime: Runtime, policy: Policy, options: { episodes: number; seed: number; maxSteps: number }): EvaluationReport {
  const { episodes, seed, maxSteps } = options;
  if (!Number.isSafeInteger(episodes) || episodes <= 0) fail('INVALID_EPISODES', 'episodes must be a positive safe integer');
  const runs: Episode[] = [];
  for (let index = 0; index < episodes; index++) runs.push(rollout(runtime, policy, { seed: seed + index, maxSteps }));
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const rate = (test: (episode: Episode) => boolean): number => runs.filter(test).length / runs.length;
  return {
    episodes,
    meanReturn: mean(runs.map(run => run.return)),
    successRate: rate(run => run.terminal === 'success'),
    failureRate: rate(run => run.terminal === 'failure'),
    cutoffRate: rate(run => run.terminal === 'cutoff'),
    violationRate: rate(run => run.violations.length > 0),
    bindings: {
      environment: runtime.env.name, environmentVersion: runtime.env.version,
      rewardVersion: `${runtime.env.name}@${runtime.env.version}:reward`,
      discount: runtime.env.reward.discount, seeds: runs.map(run => run.seed),
      maxSteps, episodes, observation: runtime.env.observation.full ? 'full' : 'partial',
    },
  };
}

/** 奖励分量必须可区分：这里给出每条轨迹的分解，不允许只保留总分。 */
export function rewardBreakdown(episode: Episode): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const step of episode.steps) {
    for (const [name, amount] of Object.entries(step.rewardTerms)) totals[name] = (totals[name] ?? 0) + amount;
  }
  return totals;
}

/** 奖励分类不是数值：任务奖励与塑形奖励分开记账，避免总分掩盖来源。 */
export function classifyTerms(env: Environment): { task: RewardTerm[]; other: RewardTerm[] } {
  return {
    task: env.reward.terms.filter(term => term.kind === 'once-entered' && term.amount > 0),
    other: env.reward.terms.filter(term => !(term.kind === 'once-entered' && term.amount > 0)),
  };
}
