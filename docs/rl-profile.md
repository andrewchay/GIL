# GIL-RL 参考实现概览

版本：2026-10-27。实现标签：`gil-rl-environment-0.1`。
对应规范：[06-GIL-RL.md](../06-GIL-RL.md)。**这是最小一致实现，不是完整 RL 系统。**

## 1. 已实现的语法

顶层文档 `environment`，九个可选出现一次的章节：

```gil
environment RobotNavigation version "0.1.0" {
  state { robot: Cell; steps: Nat; }
  observation { fullState; }
  initial { robot == Start; steps == 0; }
  action {
    action move(direction: Direction)
      requires passable(next(robot, direction))
      writes robot, steps
      ensures steps' == steps + 1
      outcomes {
        0.9 -> robot' == next(robot, direction);
        0.1 -> robot' == robot;
      };
  }
  termination { success when atStation(robot); failure when robot in HazardCells; cutoff when steps == 100; }
  goals { achieve arrive: eventually within 100.steps atStation(robot); }
  constraints { require avoidHazards: always not robot in HazardCells; }
  reward {
    discount 0.99;
    horizon 100.steps;
    aggregation expectedDiscountedReturn;
    term arrival: 100 once entered(atStation(robot));
    term elapsedTime: -1 per step;
  }
  objective { maximize expectedReturn subjectTo arrive, avoidHazards; }
}
```

两个 RL 专属语法点只在环境文档中启用，Core 仍保持严格：

- `in` 集合成员运算符（`robot in HazardCells`）；
- `eventually within N.steps` 时间界限。

## 2. 静态检查

`checkEnvironment` 产出诊断，不通过则拒绝创建运行时：

| 代码 | 含义 |
|---|---|
| `INVALID_PROBABILITY_SUM` | 有限随机动作的概率和不为 1 |
| `UNBOUNDED_GOAL` | `eventually` 缺少 `within` 界限 |
| `MISSING_OBJECTIVE` | 缺少显式优化目标 |
| `MISSING_TASK_REWARD` | 只有塑形奖励，没有正的任务结果奖励 |
| `INVALID_CONSTRAINT` | 约束不是 `always` 声明 |
| `FRAME_VIOLATION` | 动作写入未声明状态 |
| `AMBIGUOUS_OBSERVATION` | `fullState` 与显式可见变量冲突 |

外部标识符（`Cell`、`Start`、`HazardCells`、`atStation`）被视为**宿主提供的环境原语**，静态检查不校验其内容——GIL 只声明使用，不发明语义。

## 3. 运行时语义

`createRuntime(env, primitives)` 需要宿主提供三类原语：

| 原语 | 用途 |
|---|---|
| `constants` | `Start` 等常量 |
| `relations` | `next`、`passable`、`atStation` 等函数 |
| `membership` | `in` 的集合判定 |

`rollout(runtime, policy, { seed, maxSteps })` 逐回合回放：

1. 检查终止（failure → success → cutoff 顺序）；
2. 记录约束违反（`always` 每步检查）；
3. 求 `requires`，不满足则记违反并停止，**不伪造后继状态**；
4. 按 `outcomes` 抽样分支（或使用确定性 `ensures`）；
5. 求值赋值，校验目标在 `writes` 内；
6. 计算奖励，累加折扣回报。

随机性全部来自显式种子（mulberry32），同一 `seed` 必然得到同一 `traceHash`。

## 4. 语义边界

- **`cutoff` 不等于失败或成功**。达到步数上限只表示轨迹被截断，不产生任务奖励，也不算目标达成。
- **`once entered(...)` 一次性领取**。判定为「前一状态不满足、后一状态满足」，防止在目标状态反复领奖。
- **任务奖励与塑形奖励分开记账**（`classifyTerms` / `rewardBreakdown`），不允许只留一个总分。
- **`always` 只覆盖已观测前缀**。有限回放不能证明 `always` 在未来成立。
- **评估绑定显式种子**。`evaluatePolicy` 的报告回填环境版本、奖励版本、折扣、种子列表与回放上限；「表现更好」只有在这组绑定相同时才可比较。

## 5. 已知限制

1. 只支持**完全可观测**环境（`observation` 只区分 `fullState` 与可见变量名，没有 `belief`、观察函数或 POMDP 求解）。
2. 没有策略学习、没有梯度、没有价值函数。策略由宿主提供，本层只做回放与评估。
3. `Nat` 只是非负整数的类型名，运行时不做额外范围校验。
4. `rewardModel`、`preference`、`aggregation` 的多目标形式（向量回报、字典序、Pareto）未实现；`aggregation` 只作为声明字段保存。
5. 奖励分类（task / shaping / auxiliary / humanFeedback / learnedModel）只实现前两类的可区分记账。
6. 没有训练/部署权限隔离：环境动作权限与真实世界权限的分离属于 Delegation 层，本层未接入。
7. 时间单位只支持 `steps`。
8. 示例中的机器人、网格与策略都是合成夹具，**没有任何真实机器人或安全认证**。
