// GIL-RL 静态检查：只检查结构一致性，不推断转移概率或奖励语义。
// 外部标识符（Cell、Start、HazardCells 等）被视为宿主提供的环境原语，不在此校验。
import type { Diagnostic, Expr } from './ast.ts';
import type { Environment, RlAction } from './rl-ast.ts';

const RL_BASICS = new Set(['Text', 'Bool', 'Int', 'Decimal', 'Nat']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function walk(expr: Expr, visit: (node: Expr) => void): void {
  visit(expr);
  if (expr.kind === 'unary') walk(expr.arg, visit);
  else if (expr.kind === 'bounded') walk(expr.arg, visit);
  else if (expr.kind === 'binary') { walk(expr.left, visit); walk(expr.right, visit); }
  else if (expr.kind === 'call') expr.args.forEach(arg => walk(arg, visit));
}

/** 去除时序外壳，得到单步可求值的谓词。 */
export function stripTemporal(expr: Expr): Expr {
  if (expr.kind === 'unary' && (expr.op === 'always' || expr.op === 'eventually')) return stripTemporal(expr.arg);
  if (expr.kind === 'bounded') return stripTemporal(expr.arg);
  return expr;
}

export function checkEnvironment(env: Environment): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string) => diagnostics.push({ code, message });

  if (!NAME.test(env.name.replace(/\./g, ''))) report('INVALID_NAME', `Invalid environment name ${env.name}`);

  const stateTypes = new Map<string, string>();
  for (const binding of env.state) {
    if (!NAME.test(binding.name)) report('INVALID_NAME', `Invalid state name ${binding.name}`);
    if (stateTypes.has(binding.name)) report('DUPLICATE_NAME', `Duplicate state binding ${binding.name}`);
    stateTypes.set(binding.name, binding.type);
    if (!RL_BASICS.has(binding.type) && !NAME.test(binding.type)) report('INVALID_TYPE', `Unsupported state type ${binding.type}`);
  }
  if (env.state.length === 0) report('EMPTY_STATE', 'An environment needs at least one state binding');

  if (env.observation.full && env.observation.visible.length) {
    report('AMBIGUOUS_OBSERVATION', 'fullState cannot be combined with explicit visible names');
  }
  for (const name of env.observation.visible) {
    // 观察变量必须是真实状态，否则"部分可观测"无法成立。
    if (!stateTypes.has(name)) report('UNKNOWN_OBSERVATION', `Observation ${name} is not a declared state binding`);
  }

  for (const assertion of env.initial) {
    if (assertion.kind !== 'binary' || assertion.op !== '==') {
      report('INVALID_INITIAL', 'Initial conditions must be equalities');
      continue;
    }
    if (assertion.left.kind !== 'ref' || assertion.left.next || assertion.left.path.length !== 1) {
      report('INVALID_INITIAL', 'Initial equality must assign a root state reference');
      continue;
    }
    if (!stateTypes.has(assertion.left.path[0])) report('UNKNOWN_INITIAL', `Initial condition names unknown state ${assertion.left.path[0]}`);
  }
  for (const name of stateTypes.keys()) {
    const assigned = env.initial.some(assertion => assertion.kind === 'binary' && assertion.op === '=='
      && assertion.left.kind === 'ref' && !assertion.left.next && assertion.left.path[0] === name);
    if (!assigned) report('MISSING_INITIAL', `State ${name} has no explicit initial condition`);
  }

  const actionNames = new Set<string>();
  for (const action of env.actions) {
    if (!NAME.test(action.name)) report('INVALID_NAME', `Invalid action name ${action.name}`);
    if (actionNames.has(action.name)) report('DUPLICATE_NAME', `Duplicate action ${action.name}`);
    actionNames.add(action.name);
    checkAction(action, stateTypes, report);
  }
  if (env.actions.length === 0) report('EMPTY_ACTIONS', 'An environment needs at least one action');

  const terminationKinds = Object.keys(env.termination);
  if (terminationKinds.length === 0) report('EMPTY_TERMINATION', 'Termination must declare success, failure or cutoff');
  if (env.termination.success === undefined && env.termination.failure === undefined) {
    report('MISSING_TERMINATION', 'At least success or failure must be declared; cutoff alone cannot define the task');
  }
  for (const [kind, expr] of Object.entries(env.termination)) {
    if (expr) checkRefs(expr, stateTypes, `termination.${kind}`, report);
  }

  if (env.goals.length === 0) report('EMPTY_GOALS', 'At least one goal is required');
  for (const goal of env.goals) {
    checkRefs(goal.expr, stateTypes, `goal.${goal.name}`, report);
    // 随机环境下 eventually 必须明确时间界限，否则成功语义无法判定。
    const isEventual = goal.expr.kind === 'unary' && goal.expr.op === 'eventually';
    const bounded = isEventual && (goal.expr as Extract<Expr, { kind: 'unary' }>).arg.kind === 'bounded';
    if (isEventual && !bounded) report('UNBOUNDED_GOAL', `Goal ${goal.name}: eventually needs an explicit within bound`);
  }
  for (const constraint of env.constraints) {
    checkRefs(constraint.expr, stateTypes, `constraint.${constraint.name}`, report);
    if (!(constraint.expr.kind === 'unary' && constraint.expr.op === 'always')) {
      report('INVALID_CONSTRAINT', `Constraint ${constraint.name} must be an always claim`);
    }
  }

  const reward = env.reward;
  if (!(reward.discount > 0 && reward.discount <= 1)) report('INVALID_DISCOUNT', 'discount must be in (0,1]');
  if (reward.terms.length === 0) report('EMPTY_REWARD', 'Reward needs at least one term');
  const termNames = new Set<string>();
  for (const term of reward.terms) {
    if (!NAME.test(term.name)) report('INVALID_NAME', `Invalid reward term name ${term.name}`);
    if (termNames.has(term.name)) report('DUPLICATE_NAME', `Duplicate reward term ${term.name}`);
    termNames.add(term.name);
    if (!Number.isFinite(term.amount)) report('INVALID_REWARD', `Reward term ${term.name} must be finite`);
    if (term.kind === 'once-entered') {
      if (!term.predicate) report('INVALID_REWARD', `Reward term ${term.name} requires an entry predicate`);
      else checkRefs(term.predicate, stateTypes, `reward.${term.name}`, report);
    }
  }
  // 至少一个任务结果奖励：只有塑形奖励不足以定义任务成功。
  if (!reward.terms.some(term => term.amount > 0 && term.kind === 'once-entered')) {
    report('MISSING_TASK_REWARD', 'At least one positive once-entered term is required as the task reward');
  }

  if (env.objective) {
    if (env.objective.maximize !== 'expectedReturn') {
      report('UNSUPPORTED_OBJECTIVE', `Only maximize expectedReturn is inside gil-rl-environment-0.1, got ${env.objective.maximize}`);
    }
    const declared = new Set([...env.goals.map(goal => goal.name), ...env.constraints.map(constraint => constraint.name)]);
    for (const name of env.objective.subjectTo) {
      if (!declared.has(name)) report('UNKNOWN_SUBJECT_TO', `objective subjectTo names unknown claim ${name}`);
    }
  } else {
    report('MISSING_OBJECTIVE', 'An explicit objective is required so optimisation stays inside declared claims');
  }

  return diagnostics;
}

function checkAction(action: RlAction, stateTypes: Map<string, string>, report: (code: string, message: string) => void): void {
  const local = new Map(stateTypes);
  for (const param of action.params) {
    if (!NAME.test(param.name)) report('INVALID_NAME', `Invalid parameter name ${param.name}`);
    if (local.has(param.name)) report('DUPLICATE_NAME', `Parameter ${param.name} shadows state or sibling parameter`);
    local.set(param.name, param.type);
  }
  for (const target of action.writes) {
    if (!stateTypes.has(target)) report('FRAME_VIOLATION', `Action ${action.name} writes undeclared state ${target}`);
  }
  for (const expr of [...action.requires, ...action.ensures]) checkRefs(expr, local, `action.${action.name}`, report);
  for (const outcome of action.outcomes) {
    if (!(outcome.probability >= 0 && outcome.probability <= 1)) {
      report('INVALID_PROBABILITY', `Action ${action.name} has an out-of-range probability`);
    }
    checkRefs(outcome.ensures, local, `action.${action.name}.outcomes`, report);
  }
  if (action.outcomes.length) {
    const total = action.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
    // 有限随机动作的概率必须闭合；不闭合就不是合法分布。
    if (Math.abs(total - 1) > 1e-9) report('INVALID_PROBABILITY_SUM', `Action ${action.name} probabilities sum to ${total}, not 1`);
    // ensures 与 outcomes 可以共存：ensures 表达确定性部分，outcomes 表达随机部分。
  }
}

/** 只校验能静态判定的引用：根标识符必须来自 state 或参数，其余视为宿主原语。 */
function checkRefs(expr: Expr, scope: Map<string, string>, label: string, report: (code: string, message: string) => void): void {
  walk(expr, node => {
    if (node.kind !== 'ref') return;
    // next-state 引用必须指向已声明的可写状态。
    if (node.next && !scope.has(node.path[0])) report('FRAME_VIOLATION', `${label}: next-state reference to unknown ${node.path[0]}`);
  });
}
