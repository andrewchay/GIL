// GIL-RL 抽象语法：环境、随机转移、终止、奖励与优化目标。
// 本层只描述结构；转移概率与奖励值都是声明值，实现不得编造。
import type { Action, Binding, Claim, Expr } from './ast.ts';

/** 一条随机转移分支：概率 + 该分支的后置条件。 */
export interface RlOutcome { probability: number; ensures: Expr }

/** Core 动作 + 有限随机 outcomes。空 outcomes 表示确定性动作。 */
export interface RlAction extends Action { outcomes: RlOutcome[] }

/** 成功 / 失败 / 截断必须分开；截断不等于成功或失败。 */
export interface RlTermination { success?: Expr; failure?: Expr; cutoff?: Expr }

/** 奖励分量：一次性领取或按步累计。amount 可负。 */
export interface RewardTerm {
  name: string;
  amount: number;
  kind: 'once-entered' | 'per-step';
  /** once-entered 的进入谓词；per-step 无谓词。 */
  predicate?: Expr;
}

export interface RlReward {
  discount: number;
  horizon?: { value: number; unit: string };
  aggregation: string;
  terms: RewardTerm[];
}

export interface RlObjective { maximize: string; subjectTo: string[] }

export interface RlObservation { full: boolean; visible: string[] }

export interface Environment {
  kind: 'environment';
  name: string;
  version: string;
  state: Binding[];
  observation: RlObservation;
  /** 初始条件断言，全部为等式；不是初始状态分布。 */
  initial: Expr[];
  actions: RlAction[];
  termination: RlTermination;
  goals: Claim[];
  constraints: Claim[];
  reward: RlReward;
  objective?: RlObjective;
}

/** 环境原语：真实世界的常量与函数由宿主提供，GIL 只声明使用。 */
export interface Primitives {
  constants: Record<string, string | number | boolean>;
  relations: Record<string, (...args: unknown[]) => unknown>;
  /** `x in Set` 的成员判定；集合也由宿主提供。 */
  membership: Record<string, (value: unknown) => boolean>;
}
