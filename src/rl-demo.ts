// GIL-RL 演示：机器人导航环境的确定性回放。
// 网格、障碍与策略都是合成夹具；转移概率来自 .gil 声明，运行时不再发明数值。
import { readFileSync } from 'node:fs';
import { parseEnvironment } from './parser.ts';
import { checkEnvironment } from './rl-checker.ts';
import { classifyTerms, createRuntime, evaluatePolicy, rewardBreakdown, rollout } from './rl.ts';
import type { Policy } from './rl.ts';
import type { Primitives } from './rl-ast.ts';

const SIZE = 4;
const START = '0:0';
const STATION = '3:3';
const HAZARDS = new Set(['1:1']);
const DIRECTIONS: Record<string, { row: number; column: number }> = {
  down: { row: 1, column: 0 }, right: { row: 0, column: 1 },
  up: { row: -1, column: 0 }, left: { row: 0, column: -1 },
};

function parseCell(cell: unknown): { row: number; column: number } | null {
  if (typeof cell !== 'string') return null;
  const parts = cell.split(':').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isSafeInteger)) return null;
  return { row: parts[0], column: parts[1] };
}
const inside = (cell: { row: number; column: number }) =>
  cell.row >= 0 && cell.column >= 0 && cell.row < SIZE && cell.column < SIZE;

/** 越界返回 null：这样 passable 自然为 false，而不是悄悄原地打转。 */
const nextCell = (cell: unknown, direction: unknown): string | null => {
  const start = parseCell(cell);
  const delta = typeof direction === 'string' ? DIRECTIONS[direction] : undefined;
  if (!start || !delta) return null;
  const moved = { row: start.row + delta.row, column: start.column + delta.column };
  return inside(moved) ? `${moved.row}:${moved.column}` : null;
};

const primitives: Primitives = {
  constants: { Start: START },
  relations: {
    next: nextCell,
    passable: (cell: unknown) => typeof cell === 'string' && !HAZARDS.has(cell),
    atStation: (cell: unknown) => cell === STATION,
  },
  membership: { HazardCells: (value: unknown) => typeof value === 'string' && HAZARDS.has(value) },
};

/** 合成策略：优先向下、向右，遇阻回退。它不是学习结果，只用于验证环境语义。 */
const policy: Policy = state => {
  for (const direction of ['down', 'right', 'up', 'left']) {
    const target = nextCell(state.robot, direction);
    if (typeof target === 'string' && !HAZARDS.has(target)) return { action: 'move', params: { direction } };
  }
  return { action: 'move', params: { direction: 'up' } };
};

export function rlDemo(): unknown {
  const env = parseEnvironment(readFileSync('examples/机器人导航.gil', 'utf8'));
  const diagnostics = checkEnvironment(env);
  const runtime = createRuntime(env, primitives);
  const report = evaluatePolicy(runtime, policy, { episodes: 4, seed: 42, maxSteps: 100 });
  const episode = rollout(runtime, policy, { seed: 7, maxSteps: 100 });
  const terms = classifyTerms(env);
  return {
    ok: diagnostics.length === 0 && episode.terminal === 'success'
      && episode.violations.length === 0 && episode.goalsSatisfied.includes('arrive'),
    mode: 'synthetic-rl-rollout',
    warning: 'SYNTHETIC ONLY: grid, hazards and policy are fixtures; no real robot, no learning, no safety certification',
    environment: { name: env.name, version: env.version, state: env.state.map(binding => `${binding.name}: ${binding.type}`),
      actions: env.actions.map(action => ({ name: action.name, outcomes: action.outcomes.map(outcome => outcome.probability) })),
      observation: env.observation.full ? 'full' : 'partial', reward: { discount: env.reward.discount,
        horizon: env.reward.horizon ?? null, aggregation: env.reward.aggregation } },
    diagnostics,
    terms: { task: terms.task.map(term => term.name), other: terms.other.map(term => term.name) },
    episode: {
      seed: episode.seed, terminal: episode.terminal, steps: episode.steps.length, return: episode.return,
      violations: episode.violations, goalsSatisfied: episode.goalsSatisfied, traceHash: episode.traceHash,
      path: episode.steps.map(step => `${step.action}(${step.params.direction}) -> ${step.after.robot}`),
      breakdown: rewardBreakdown(episode),
      rewardSequence: episode.steps.map(step => step.reward),
    },
    report,
    // 采样一次随机分支，证明概率确实影响转移而非装饰。
    sampledOutcomes: [1, 2, 3, 4, 5].map(seed => {
      const run = rollout(runtime, () => ({ action: 'move', params: { direction: 'right' } }), { seed, maxSteps: 1 });
      return { seed, robot: run.steps[0]?.after.robot ?? null, probability: run.steps[0]?.probability ?? null };
    }),
  };
}
