/**
 * 偏好排序。
 *
 * 明确边界：本模块只回答"两个候选谁更优"，**不回答**"这个候选是否被允许"。
 * 允许与否属于约束与授权判定，不能由偏好分数替代。
 *
 * 只实现规范里最小的一种：单一数值目标 + `priority` 决定字典序权重。
 * 多目标向量回报、Pareto 前沿、基数效用比较都不实现。
 */
import { GilError } from './ast.ts';
import type { Goal, Linked } from './ast.ts';
import { evaluate, isUnknown } from './runtime.ts';
import type { Environment, Unknown } from './runtime.ts';

export type PreferenceValue = number | Unknown;

export interface Ranked {
  label: string;
  /** 按 priority 升序排列的取值，与 `objectives` 对应。 */
  values: PreferenceValue[];
  /** 任一目标为 Unknown 时，该候选不可比较。 */
  comparable: boolean;
}

export interface Ranking {
  /** 目标声明顺序。priority 越小越先比较。 */
  objectives: { name: string; direction: 'minimize' | 'maximize'; priority: number }[];
  /** 从优到劣；不可比较的候选排在后面，且不互相声称更优。 */
  order: Ranked[];
  /** 存在不可比较的候选时，整体排序不构成结论。 */
  complete: boolean;
  ranking: 'preference-only' | 'not-authorization';
}

function fail(code: string, message: string): never { throw new GilError(code, message); }

/** 取出可比较的偏好目标；非数值目标一律显式拒绝，而不是跳过。 */
export function objectives(goals: Goal[]): Ranking['objectives'] {
  const declared = goals.filter(goal => goal.kind === 'prefer');
  const seen = new Set<number>();
  return declared.map(goal => {
    if (!goal.direction) fail('INVALID_PREFERENCE', `Preference ${goal.name} requires minimize or maximize`);
    if (goal.priority === undefined) fail('INVALID_PREFERENCE', `Preference ${goal.name} requires an explicit priority`);
    if (!Number.isSafeInteger(goal.priority) || goal.priority < 0) {
      fail('INVALID_PREFERENCE', `Preference ${goal.name} priority must be a non-negative safe integer`);
    }
    if (seen.has(goal.priority)) fail('DUPLICATE_PRIORITY', `Preference priority ${goal.priority} is declared twice`);
    seen.add(goal.priority);
    return { name: goal.name, direction: goal.direction, priority: goal.priority };
  }).sort((a, b) => a.priority - b.priority);
}

/**
 * 对一个候选的偏好目标取值。
 *
 * 取值必须是有限数值。Unknown 保留为不可比较；类型错误直接抛错——
 * 把"取不到值"当成"值很差不选"会静默改变决策。
 */
function measure(program: Linked, goal: Goal, env: Environment): PreferenceValue {
  const value = evaluate(goal.expr, program, env);
  if (isUnknown(value)) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_PREFERENCE', `Preference ${goal.name} must evaluate to a finite number`);
  }
  return value;
}

/**
 * 按 priority 的字典序排序候选。
 *
 * 不可比较的候选保留在结果里但排在可比较候选之后，`complete` 为 false——
 * 它明确表示"没有得出完整排序"，而不是声称剩余候选更差。
 */
export function rank(program: Linked, candidates: { label: string; env: Environment }[]): Ranking {
  if (candidates.length === 0) fail('INVALID_PREFERENCE', 'Ranking requires at least one candidate');
  const declared = objectives(program.spec.goals ?? []);
  const preferences = (program.spec.goals ?? []).filter(goal => goal.kind === 'prefer');
  const labels = new Set<string>();
  const scored: Ranked[] = candidates.map(candidate => {
    if (!candidate.label || labels.has(candidate.label)) {
      fail('INVALID_PREFERENCE', `Candidate label ${candidate.label} must be nonempty and unique`);
    }
    labels.add(candidate.label);
    const values = preferences.map(goal => measure(program, goal, candidate.env));
    return { label: candidate.label, values, comparable: values.every(value => typeof value === 'number') };
  });
  const ordered = [...scored].sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
    if (!a.comparable) return 0;
    for (const [index, objective] of declared.entries()) {
      const left = a.values[index] as number, right = b.values[index] as number;
      if (left === right) continue;
      return objective.direction === 'minimize' ? left - right : right - left;
    }
    return 0;
  });
  return { objectives: declared, order: ordered, complete: scored.every(entry => entry.comparable), ranking: 'preference-only' };
}

/**
 * 明确标注：排序结论不是授权结论。
 *
 * 这个函数存在的意义是让调用方必须显式请求这两个标记，而不是把 `order[0]`
 * 直接当"应当执行的动作"。
 */
export function authorizeFromRanking(): never {
  fail('PREFERENCE_IS_NOT_AUTHORIZATION', 'A ranking never authorizes execution; use the delegation gate');
}
