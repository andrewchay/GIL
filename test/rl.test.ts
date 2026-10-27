// GIL-RL 验收测试：环境解析、静态检查、确定性回放、终止三态与奖励分解。
// 所有环境与策略都是合成夹具；不涉及真实机器人、学习或安全认证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GilError } from '../src/ast.ts';
import { parseEnvironment } from '../src/parser.ts';
import { checkEnvironment } from '../src/rl-checker.ts';
import { classifyTerms, createRuntime, evaluatePolicy, rewardBreakdown, rollout, terminalOf } from '../src/rl.ts';
import type { Policy } from '../src/rl.ts';
import type { Primitives } from '../src/rl-ast.ts';

const navigation = parseEnvironment(readFileSync(new URL('../examples/机器人导航.gil', import.meta.url), 'utf8'));

const SIZE = 4, STATION = '3:3';
const HAZARDS = new Set(['1:1']);
const DELTA: Record<string, { row: number; column: number }> = {
  down: { row: 1, column: 0 }, right: { row: 0, column: 1 }, up: { row: -1, column: 0 }, left: { row: 0, column: -1 },
};
const nextCell = (cell: unknown, direction: unknown): string | null => {
  if (typeof cell !== 'string' || typeof direction !== 'string') return null;
  const [row, column] = cell.split(':').map(Number);
  const delta = DELTA[direction];
  if (!delta || !Number.isSafeInteger(row) || !Number.isSafeInteger(column)) return null;
  const moved = { row: row + delta.row, column: column + delta.column };
  return moved.row >= 0 && moved.column >= 0 && moved.row < SIZE && moved.column < SIZE
    ? `${moved.row}:${moved.column}` : null;
};
const primitives: Primitives = {
  constants: { Start: '0:0' },
  relations: {
    next: nextCell,
    passable: (cell: unknown) => typeof cell === 'string' && !HAZARDS.has(cell),
    atStation: (cell: unknown) => cell === STATION,
  },
  membership: { HazardCells: (value: unknown) => typeof value === 'string' && HAZARDS.has(value) },
};
const greedy: Policy = state => {
  for (const direction of ['down', 'right', 'up', 'left']) {
    const target = nextCell(state.robot, direction);
    if (typeof target === 'string' && !HAZARDS.has(target)) return { action: 'move', params: { direction } };
  }
  return { action: 'move', params: { direction: 'up' } };
};
const error = (code: string) => (thrown: unknown) => thrown instanceof GilError && thrown.code === code;

const slip = `environment Slip version "0.1.0" {
  state { pos: Nat; }
  observation { fullState; }
  initial { pos == 0; }
  action {
    action inc()
      writes pos
      outcomes {
        0.5 -> pos' == pos + 1;
        0.5 -> pos' == pos + 3;
      };
  }
  termination { success when pos >= 1; cutoff when pos == 100; }
  goals { achieve reach: eventually within 100.steps pos >= 1; }
  constraints { require lowPos: always pos <= 2; }
  reward {
    discount 0.5;
    term done: 10 once entered(pos >= 1);
    term tick: -1 per step;
  }
  objective { maximize expectedReturn subjectTo reach, lowPos; }
}`;
const slipPrimitives: Primitives = { constants: {}, relations: {}, membership: {} };

test('RL: the navigation example parses into an environment and passes static checks', () => {
  assert.equal(navigation.kind, 'environment');
  assert.equal(navigation.name, 'RobotNavigation');
  assert.equal(navigation.observation.full, true);
  assert.deepEqual(navigation.state.map(binding => [binding.name, binding.type]), [['robot', 'Cell'], ['steps', 'Nat']]);
  const move = navigation.actions[0];
  assert.deepEqual(move.outcomes.map(outcome => outcome.probability), [0.9, 0.1]);
  assert.deepEqual(Object.keys(navigation.termination), ['success', 'failure', 'cutoff']);
  assert.equal(navigation.reward.discount, 0.99);
  assert.deepEqual(navigation.reward.terms.map(term => [term.name, term.kind]), [['arrival', 'once-entered'], ['elapsedTime', 'per-step']]);
  assert.deepEqual(navigation.objective, { maximize: 'expectedReturn', subjectTo: ['arrive', 'avoidHazards'] });
  assert.deepEqual(checkEnvironment(navigation), []);
});

test('RL: diagnostics reject unclosed probabilities, unbounded goals and missing objective', () => {
  const unclosed = slip.replace("0.5 -> pos' == pos + 3;", "0.4 -> pos' == pos + 3;");
  assert.ok(checkEnvironment(parseEnvironment(unclosed)).some(item => item.code === 'INVALID_PROBABILITY_SUM'));
  const unbounded = slip.replace('eventually within 100.steps pos >= 1', 'eventually pos >= 1');
  assert.ok(checkEnvironment(parseEnvironment(unbounded)).some(item => item.code === 'UNBOUNDED_GOAL'));
  const noObjective = slip.replace(/objective \{[^}]*\}/, '');
  assert.ok(checkEnvironment(parseEnvironment(noObjective)).some(item => item.code === 'MISSING_OBJECTIVE'));
  const badWrite = slip.replace('writes pos', 'writes other');
  assert.ok(checkEnvironment(parseEnvironment(badWrite)).some(item => item.code === 'FRAME_VIOLATION'));
  const slackConstraint = slip.replace('always pos <= 2', 'pos <= 2');
  assert.ok(checkEnvironment(parseEnvironment(slackConstraint)).some(item => item.code === 'INVALID_CONSTRAINT'));
  const noTaskReward = slip.replace('term done: 10 once entered(pos >= 1);', '');
  assert.ok(checkEnvironment(parseEnvironment(noTaskReward)).some(item => item.code === 'MISSING_TASK_REWARD'));
});

test('RL: invalid environments never reach the runtime', () => {
  assert.throws(() => createRuntime(parseEnvironment(slip.replace('0.5 -> pos\' == pos + 3;', '0.4 -> pos\' == pos + 3;')), slipPrimitives),
    error('INVALID_ENVIRONMENT'));
});

test('RL: replay is deterministic per seed and reproducible via traceHash', () => {
  const runtime = createRuntime(navigation, primitives);
  const first = rollout(runtime, greedy, { seed: 7, maxSteps: 100 });
  const second = rollout(runtime, greedy, { seed: 7, maxSteps: 100 });
  assert.equal(first.traceHash, second.traceHash);
  assert.equal(first.terminal, 'success');
  assert.deepEqual(first.goalsSatisfied, ['arrive']);
  assert.deepEqual(first.violations, []);
  assert.equal(first.steps.at(-1)!.after.robot, STATION);
  // 概率确实影响转移：不同种子会观察到滑动分支。
  const probabilities = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed =>
    rollout(runtime, () => ({ action: 'move', params: { direction: 'right' } }), { seed, maxSteps: 1 }).steps[0].probability));
  assert.deepEqual([...probabilities].sort(), [0.1, 0.9]);
});

test('RL: the task reward is claimed once while shaping accumulates per step', () => {
  const runtime = createRuntime(navigation, primitives);
  const episode = rollout(runtime, greedy, { seed: 7, maxSteps: 100 });
  const breakdown = rewardBreakdown(episode);
  assert.equal(breakdown.arrival, 100);
  assert.equal(breakdown.elapsedTime, -episode.steps.length);
  assert.deepEqual(classifyTerms(navigation), {
    task: navigation.reward.terms.filter(term => term.name === 'arrival'),
    other: navigation.reward.terms.filter(term => term.name === 'elapsedTime'),
  });
  // 折扣回报不等于奖励总和。
  assert.ok(episode.return < 100 - episode.steps.length + 1);
});

test('RL: cutoff is distinct from failure and carries no success credit', () => {
  const runtime = createRuntime(navigation, primitives);
  const truncated = rollout(runtime, greedy, { seed: 7, maxSteps: 2 });
  assert.equal(truncated.terminal, 'cutoff');
  assert.deepEqual(truncated.goalsSatisfied, []);
  assert.equal(rewardBreakdown(truncated).arrival, undefined);
  assert.equal(terminalOf(runtime, { robot: STATION, steps: 3 }, 3, 100), 'success');
  assert.equal(terminalOf(runtime, { robot: '1:1', steps: 3 }, 3, 100), 'failure');
});

test('RL: a constraint violation is recorded without rewriting the trajectory', () => {
  const runtime = createRuntime(parseEnvironment(slip), slipPrimitives);
  const runs = [1, 2, 3, 4, 5, 6, 7, 8].map(seed => rollout(runtime, () => ({ action: 'inc' }), { seed, maxSteps: 10 }));
  const landed = runs.map(run => run.steps[0].after.pos);
  // 两条分支都必须真实出现过，证明概率不是装饰。
  assert.deepEqual([...new Set(landed)].sort(), [1, 3]);
  const violating = runs.filter(run => run.violations.includes('lowPos'));
  assert.ok(violating.length > 0, 'the pos+3 branch must violate lowPos');
  assert.ok(violating.every(run => run.steps[0].after.pos === 3));
  assert.ok(runs.filter(run => !run.violations.length).every(run => run.steps[0].after.pos === 1));
  // 违反被记录，但轨迹本身不回改：每条都以真实初始状态开始。
  assert.ok(runs.every(run => run.steps[0].before.pos === 0));
});

test('RL: an inexecutable policy action is a recorded violation, not a fabricated transition', () => {
  const runtime = createRuntime(navigation, primitives);
  const episode = rollout(runtime, () => ({ action: 'move', params: { direction: 'left' } }), { seed: 1, maxSteps: 10 });
  assert.equal(episode.terminal, 'cutoff');
  assert.equal(episode.steps.length, 0);
  assert.ok(episode.violations.some(entry => entry.startsWith('PRECONDITION_FAILED')));
  assert.deepEqual(rollout(runtime, () => ({ action: 'teleport' }), { seed: 1, maxSteps: 5 }).violations,
    ['UNKNOWN_ACTION:teleport@0']);
});

test('RL: evaluation reports success/cutoff rates bound to explicit seeds', () => {
  const runtime = createRuntime(navigation, primitives);
  const report = evaluatePolicy(runtime, greedy, { episodes: 3, seed: 11, maxSteps: 100 });
  assert.equal(report.episodes, 3);
  assert.deepEqual(report.bindings.seeds, [11, 12, 13]);
  assert.equal(report.bindings.observation, 'full');
  assert.equal(report.bindings.environment, 'RobotNavigation');
  assert.equal(report.bindings.rewardVersion, 'RobotNavigation@0.1.0:reward');
  assert.equal(report.successRate, 1);
  assert.equal(report.violationRate, 0);
  assert.ok(report.meanReturn > 0);
  assert.throws(() => evaluatePolicy(runtime, greedy, { episodes: 0, seed: 1, maxSteps: 10 }), error('INVALID_EPISODES'));
});

test('RL CLI demo reports a successful synthetic rollout', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-rl'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'synthetic-rl-rollout');
  assert.match(out.warning, /SYNTHETIC ONLY/);
  assert.equal(out.episode.terminal, 'success');
  assert.deepEqual(out.episode.breakdown, { arrival: 100, elapsedTime: -out.episode.steps });
  assert.deepEqual(out.terms.task, ['arrival']);
  assert.ok(out.sampledOutcomes.some((item: { probability: number }) => item.probability === 0.1));
});
