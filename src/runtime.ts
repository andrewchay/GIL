import type { Expr, Linked, Binding, Ontology, Claim } from './ast.ts';
import { GilError } from './ast.ts';
import { isDeepStrictEqual } from 'node:util';

export interface Unknown { kind: 'unknown'; reason: string }
export type Value = string | boolean | number | Unknown | { [key: string]: Value };
export type State = Record<string, Value>;
export interface Environment {
  state: State;
  inputs?: State;
  params?: State;
  context?: State;
  nextState?: State;
  locals?: State;
  localTypes?: Record<string, string>;
  ontologyAlias?: string;
  callStack?: string[];
}
export interface Check { name: string; value: boolean | Unknown; scope: 'state' | 'finite-prefix'; current?: boolean | Unknown }
export interface MonitorResult { semantics: 'finite-prefix'; prefixLength: 1; goals: Check[]; constraints: Check[] }
export type SimulationResult =
  | { ok: true; state: State; checks: Check[]; authorization: 'not-implemented'; mode: 'core-simulation' }
  | { ok: false; stage: 'pre-constraints' | 'requires' | 'assignment' | 'ensures' | 'constraints'; checks: Check[]; candidate?: State; authorization: 'not-implemented'; mode: 'core-simulation' };

export function unknown(reason: string): Unknown { return { kind: 'unknown', reason }; }
export function isUnknown(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'reason') && (value as Unknown).kind === 'unknown' && typeof (value as Unknown).reason === 'string';
}
function fail(code: string, message: string): never { throw new GilError(code, message); }
function own(obj: object, key: string): boolean { return Object.hasOwn(obj, key); }
function put(target: State, key: string, value: Value): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function object(value: unknown): value is State {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isUnknown(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boolean(value: Value): boolean | Unknown {
  if (isUnknown(value) || typeof value === 'boolean') return value;
  return fail('TYPE_ERROR', 'Expected Bool');
}
function number(value: Value): number | Unknown {
  if (isUnknown(value)) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('TYPE_ERROR', 'Expected finite numeric value');
  return value;
}
function and(a: boolean | Unknown, b: boolean | Unknown): boolean | Unknown {
  if (a === false || b === false) return false;
  if (isUnknown(a)) return a;
  return b;
}
function or(a: boolean | Unknown, b: boolean | Unknown): boolean | Unknown {
  if (a === true || b === true) return true;
  if (isUnknown(a)) return a;
  return b;
}
function not(a: boolean | Unknown): boolean | Unknown { return isUnknown(a) ? a : !a; }
function equal(a: Value, b: Value): boolean | Unknown {
  if (isUnknown(a)) return a;
  if (isUnknown(b)) return b;
  if (typeof a !== typeof b) fail('TYPE_ERROR', 'Comparison requires matching types');
  if (typeof a === 'number' && typeof b === 'number') { number(a); number(b); return a === b; }
  if (object(a) && object(b)) {
    let result: boolean | Unknown = true;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const field = own(a, key) && own(b, key) ? equal(a[key], b[key]) : unknown(`Missing equality field ${key}`);
      result = and(result, field);
    }
    return result;
  }
  return isDeepStrictEqual(a, b);
}

// Missing values/fields are permitted as partial knowledge; supplied wrong types are not.
function validate(value: Value, type: string, linked: Linked, alias?: string, depth = 0): void {
  if (isUnknown(value)) return;
  if (depth > 64) fail('UNSUPPORTED_PROFILE', 'Recursive concept values exceed Core profile depth');
  if (type === 'Bool') { boolean(value); return; }
  if (type === 'Text') { if (typeof value !== 'string') fail('TYPE_ERROR', 'Expected Text'); return; }
  if (['Int', 'Decimal'].includes(type)) {
    number(value);
    if (type === 'Int' && !Number.isSafeInteger(value)) fail('TYPE_ERROR', 'Expected safe integer Int');
    return;
  }
  const path = type.split('.');
  const key = path.length === 2 ? path[0] : alias ?? '';
  const ontology = own(linked.ontologies, key) ? linked.ontologies[key] : undefined;
  const concept = ontology?.concepts.find(c => c.name === path.at(-1));
  if (!concept || path.length > 2) fail('UNSUPPORTED_TYPE', `Unsupported type ${type}`);
  if (!object(value)) fail('TYPE_ERROR', `Expected concept ${type}`);
  for (const key of Object.keys(value)) {
    const field = concept.fields.find(f => f.name === key);
    if (!field) fail('TYPE_ERROR', `Undeclared field ${type}.${key}`);
    validate(value[key], field.type, linked, path.length === 2 ? path[0] : alias, depth + 1);
  }
}
function validateBindings(values: State, bindings: Binding[], linked: Linked, alias?: string): void {
  if (!object(values)) fail('TYPE_ERROR', 'Expected binding object');
  for (const key of Object.keys(values)) {
    const binding = bindings.find(b => b.name === key);
    if (!binding) fail('TYPE_ERROR', `Undeclared binding ${key}`);
    validate(values[key], binding.type, linked, alias);
  }
}
function context(linked: Linked): State {
  const result: State = {};
  for (const binding of linked.spec.context) {
    if (binding.value) assertPure(binding.value);
    const value = binding.value ? evaluate(binding.value, linked, { state: {}, context: result }) : unknown(`Missing context ${binding.name}`);
    validate(value, binding.type, linked);
    put(result, binding.name, value);
  }
  return result;
}
function assertPure(expr: Expr): void {
  if (expr.kind === 'ref' && expr.next) fail('UNSUPPORTED_POSTCONDITION', 'Next-state reference is not allowed in a pure expression');
  if (expr.kind === 'unary') {
    if (['always', 'eventually'].includes(expr.op)) fail('UNSUPPORTED_PROFILE', 'Temporal operators are allowed only as top-level monitor claims');
    assertPure(expr.arg);
  }
  if (expr.kind === 'binary') { assertPure(expr.left); assertPure(expr.right); }
  if (expr.kind === 'call') expr.args.forEach(assertPure);
}
function resolveRelation(path: string[], linked: Linked, env: Environment): { ontology: Ontology; alias: string; name: string } {
  const alias = path.length === 2 ? path[0] : env.ontologyAlias;
  if (!alias || path.length > 2 || !own(linked.ontologies, alias)) fail('UNKNOWN_RELATION', `Unknown relation ${path.join('.')}`);
  return { ontology: linked.ontologies[alias], alias, name: path.at(-1)! };
}

// Keep Int result checks aligned with checker inference, including integer-valued Decimal bindings.
function isIntExpr(expr: Expr, linked: Linked, env: Environment): boolean {
  if (expr.kind === 'literal') return typeof expr.value === 'number' && Number.isInteger(expr.value);
  if (expr.kind === 'unary') return expr.op === '-' && isIntExpr(expr.arg, linked, env);
  if (expr.kind === 'binary') return ['+', '-', '*', '%'].includes(expr.op) && isIntExpr(expr.left, linked, env) && isIntExpr(expr.right, linked, env);
  if (expr.kind === 'call') {
    const { ontology, name } = resolveRelation(expr.path, linked, env);
    return ontology.relations.find(r => r.name === name)?.type === 'Int';
  }
  if (expr.kind === 'ref') {
    const [root, ...fields] = expr.path;
    let type = env.localTypes && own(env.localTypes, root) ? env.localTypes[root] :
      [...linked.spec.state, ...linked.spec.input, ...linked.spec.context, ...linked.spec.actions.flatMap(a => a.params)].find(b => b.name === root)?.type;
    let alias = env.ontologyAlias;
    for (const field of fields) {
      if (!type) return false;
      const path = type.split('.');
      alias = path.length === 2 ? path[0] : alias;
      const ontology = alias && own(linked.ontologies, alias) ? linked.ontologies[alias] : undefined;
      type = ontology?.concepts.find(c => c.name === path.at(-1))?.fields.find(f => f.name === field)?.type;
    }
    return type === 'Int';
  }
  return false;
}
function intResult(value: number): number {
  if (!Number.isSafeInteger(value)) fail('ARITHMETIC_ERROR', 'Int arithmetic result exceeds safe integer range');
  return value;
}

/** Pure Core evaluation. Temporal operators cannot be evaluated as a current-state Boolean. */
export function evaluate(expr: Expr, linked: Linked, env: Environment): Value {
  switch (expr.kind) {
    case 'literal':
      if (!['string', 'boolean', 'number'].includes(typeof expr.value)) fail('TYPE_ERROR', 'Unsupported literal');
      if (typeof expr.value === 'number') {
        number(expr.value);
        if (Number.isInteger(expr.value) && !Number.isSafeInteger(expr.value)) fail('TYPE_ERROR', 'Int literal exceeds safe integer range');
      }
      return expr.value;
    case 'ref': {
      if (!expr.path.length) fail('TYPE_ERROR', 'Empty reference');
      const [root, ...fields] = expr.path;
      let value: Value;
      if (expr.next) {
        if (!env.nextState) fail('UNSUPPORTED_PROFILE', 'Next-state ref outside a transition');
        value = own(env.nextState, root) ? env.nextState[root] : unknown(`Missing next-state reference ${root}`);
      } else {
        const scopes = [env.locals, env.params, env.inputs, env.state, env.context ?? context(linked)];
        const scope = scopes.find(s => s && own(s, root));
        value = scope ? scope[root] : unknown(`Missing reference ${root}`);
        const binding = linked.spec.state.find(b => b.name === root) ?? linked.spec.input.find(b => b.name === root) ?? linked.spec.context.find(b => b.name === root);
        if (binding && !(env.locals && own(env.locals, root)) && !(env.params && own(env.params, root))) validate(value, binding.type, linked);
      }
      for (const field of fields) {
        if (isUnknown(value)) return value;
        if (!object(value)) fail('TYPE_ERROR', `Cannot read field ${field} from a non-concept value`);
        value = own(value, field) ? value[field] : unknown(`Missing field ${expr.path.join('.')}`);
      }
      if (value === undefined || value === null) fail('TYPE_ERROR', `Invalid value at ${expr.path.join('.')}`);
      return value;
    }
    case 'call': {
      const { ontology, alias, name } = resolveRelation(expr.path, linked, env);
      const relation = ontology.relations.find(r => r.name === name);
      if (!relation) fail('UNKNOWN_RELATION', `Unknown relation ${alias}.${name}`);
      const id = `${alias}.${name}`;
      if (env.callStack?.includes(id)) fail('UNSUPPORTED_PROFILE', 'Recursive relations are not supported');
      if (relation.params.length !== expr.args.length) fail('TYPE_ERROR', `Wrong arity for ${id}`);
      assertPure(relation.body);
      const locals: State = {};
      const localTypes: Record<string, string> = Object.create(null);
      expr.args.forEach((arg, index) => {
        const value = evaluate(arg, linked, env);
        validate(value, relation.params[index].type, linked, alias);
        put(locals, relation.params[index].name, value);
        localTypes[relation.params[index].name] = relation.params[index].type;
      });
      const result = evaluate(relation.body, linked, { state: {}, context: {}, locals, localTypes, ontologyAlias: alias, callStack: [...env.callStack ?? [], id] });
      validate(result, relation.type, linked, alias);
      return result;
    }
    case 'unary': {
      if (['always', 'eventually'].includes(expr.op)) fail('UNSUPPORTED_PROFILE', 'Use monitor for finite-prefix temporal claims');
      const value = evaluate(expr.arg, linked, env);
      if (expr.op === '!') return not(boolean(value));
      if (expr.op === '-') { const n = number(value); return isUnknown(n) ? n : isIntExpr(expr, linked, env) ? intResult(-n) : -n; }
      fail('UNSUPPORTED_PROFILE', `Unsupported unary operator ${expr.op}`);
    }
    case 'binary': {
      const a = evaluate(expr.left, linked, env), b = evaluate(expr.right, linked, env);
      if (expr.op === '&&') return and(boolean(a), boolean(b));
      if (expr.op === '||') return or(boolean(a), boolean(b));
      if (expr.op === '=>') return or(not(boolean(a)), boolean(b));
      if (['+', '-', '*', '/', '%'].includes(expr.op)) {
        const x = number(a), y = number(b);
        if (isUnknown(x)) return x;
        if (isUnknown(y)) return y;
        if ((expr.op === '/' || expr.op === '%') && y === 0) fail('ARITHMETIC_ERROR', 'Division by zero');
        const result = expr.op === '+' ? x + y : expr.op === '-' ? x - y : expr.op === '*' ? x * y : expr.op === '/' ? x / y : x % y;
        if (!Number.isFinite(result)) fail('ARITHMETIC_ERROR', 'Non-finite arithmetic result');
        return isIntExpr(expr, linked, env) ? intResult(result) : result;
      }
      if (!['==', '!=', '<', '<=', '>', '>='].includes(expr.op)) fail('UNSUPPORTED_PROFILE', `Unsupported binary operator ${expr.op}`);
      if (expr.op === '==') return equal(a, b);
      if (expr.op === '!=') return not(equal(a, b));
      const x = number(a), y = number(b);
      if (isUnknown(x)) return x;
      if (isUnknown(y)) return y;
      return expr.op === '<' ? x < y : expr.op === '<=' ? x <= y : expr.op === '>' ? x > y : x >= y;
    }
    default: return fail('UNSUPPORTED_PROFILE', 'Unsupported expression kind');
  }
}

/** Defaults resolve in declaration order against explicit state and context only.
 * Missing context/input dependencies remain Unknown; this does not certify invariants.
 * Call monitor/simulate with explicit inputs to check state constraints.
 * Decimal uses finite IEEE-754 numbers, not exact base-10 arithmetic.
 */
export function initialize(linked: Linked, initialState: State = {}): State {
  validateBindings(initialState, linked.spec.state, linked);
  const state: State = structuredClone(initialState);
  const constants = context(linked);
  for (const binding of linked.spec.state) {
    if (!own(state, binding.name)) {
      if (binding.value) { assertPure(binding.value); put(state, binding.name, evaluate(binding.value, linked, { state, context: constants })); }
      else put(state, binding.name, unknown(`Missing initial state ${binding.name}; supply an explicit fixture value`));
    }
    validate(state[binding.name], binding.type, linked);
  }
  return state;
}
function checkClaim(claim: Claim, linked: Linked, env: Environment): Check {
  if (claim.expr.kind === 'unary' && ['always', 'eventually'].includes(claim.expr.op)) {
    assertPure(claim.expr.arg);
    const current = boolean(evaluate(claim.expr.arg, linked, env));
    const value = claim.expr.op === 'always'
      ? current === false ? false : unknown(`Finite prefix cannot establish always ${claim.name}`)
      : current === true ? true : unknown(`Finite prefix has no witness for eventually ${claim.name}`);
    return { name: claim.name, value, current, scope: 'finite-prefix' };
  }
  assertPure(claim.expr);
  return { name: claim.name, value: boolean(evaluate(claim.expr, linked, env)), scope: 'state' };
}
export function monitor(linked: Linked, state: State, inputs: State = {}): MonitorResult {
  validateBindings(state, linked.spec.state, linked);
  validateBindings(inputs, linked.spec.input, linked);
  const env = { state, inputs, context: context(linked) };
  return { semantics: 'finite-prefix', prefixLength: 1, goals: linked.spec.goals.map(c => checkClaim(c, linked, env)), constraints: linked.spec.constraints.map(c => checkClaim(c, linked, env)) };
}
function stateConstraints(linked: Linked, env: Environment): Check[] {
  return linked.spec.constraints.map(claim => {
    if (claim.expr.kind === 'unary' && claim.expr.op === 'eventually') fail('UNSUPPORTED_PROFILE', 'Eventually hard constraints cannot be established by a state transition');
    const expr = claim.expr.kind === 'unary' && claim.expr.op === 'always' ? claim.expr.arg : claim.expr;
    assertPure(expr);
    return { name: claim.name, value: boolean(evaluate(expr, linked, env)), scope: 'state' };
  });
}

/** Deterministic candidate construction, never a solver or an authorization decision. */
export function simulate(linked: Linked, state: State, inputs: State, actionName: string, params: State = {}): SimulationResult {
  validateBindings(state, linked.spec.state, linked);
  validateBindings(inputs, linked.spec.input, linked);
  const action = linked.spec.actions.find(a => a.name === actionName);
  if (!action) fail('UNKNOWN_ACTION', `Unknown action ${actionName}`);
  validateBindings(params, action.params, linked);
  const localTypes: Record<string, string> = Object.create(null);
  for (const binding of action.params) localTypes[binding.name] = binding.type;
  const env: Environment = { state, inputs, params, localTypes, context: context(linked) };
  const meta = { authorization: 'not-implemented' as const, mode: 'core-simulation' as const };
  const preConstraints = stateConstraints(linked, { state, inputs, context: env.context });
  if (preConstraints.some(c => c.value !== true)) return { ok: false, stage: 'pre-constraints', checks: preConstraints, ...meta };
  // Validate the supported postcondition shape even if requires would block execution.
  const assignments = action.ensures.map(expr => {
    if (expr.kind !== 'binary' || expr.op !== '==' || expr.left.kind !== 'ref' || !expr.left.next || expr.left.path.length !== 1) fail('UNSUPPORTED_POSTCONDITION', 'Only next-state root == pure RHS assignments are supported');
    const name = expr.left.path[0];
    if (!linked.spec.state.some(b => b.name === name) || !action.writes.includes(name)) fail('FRAME_VIOLATION', `Assignment outside writes/state: ${name}`);
    assertPure(expr.right);
    return { name, expr, rhs: expr.right };
  });
  for (const name of action.writes) if (!linked.spec.state.some(b => b.name === name)) fail('FRAME_VIOLATION', `Undeclared writes target ${name}`);
  const requires = action.requires.map((expr, i) => { assertPure(expr); return { name: `requires[${i}]`, value: boolean(evaluate(expr, linked, env)), scope: 'state' as const }; });
  if (requires.some(c => c.value !== true)) return { ok: false, stage: 'requires', checks: requires, ...meta };
  const values: State = {};
  const assignmentChecks: Check[] = [];
  for (const { name, rhs } of assignments) {
    const value = evaluate(rhs, linked, env);
    validate(value, linked.spec.state.find(b => b.name === name)!.type, linked);
    if (own(values, name) && equal(values[name], value) === false) fail('CONFLICTING_ASSIGNMENT', `Conflicting assignments to ${name}`);
    put(values, name, value);
    assignmentChecks.push({ name, value: isUnknown(value) ? value : true, scope: 'state' });
  }
  if (assignmentChecks.some(c => c.value !== true)) return { ok: false, stage: 'assignment', checks: assignmentChecks, ...meta };
  const candidate = structuredClone({ ...state, ...values });
  const ensures: Check[] = assignments.map(({ expr }, i) => ({ name: `ensures[${i}]`, value: boolean(evaluate(expr, linked, { ...env, nextState: candidate })), scope: 'state' }));
  if (ensures.some(c => c.value !== true)) return { ok: false, stage: 'ensures', checks: ensures, candidate, ...meta };
  const constraints = stateConstraints(linked, { state: candidate, inputs, context: env.context });
  if (constraints.some(c => c.value !== true)) return { ok: false, stage: 'constraints', checks: constraints, candidate, ...meta };
  return { ok: true, state: candidate, checks: [...requires, ...ensures, ...constraints], ...meta };
}
