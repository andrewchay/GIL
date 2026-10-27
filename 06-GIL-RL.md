# GIL-RL：强化学习扩展

**版本：** v0.1 设计草案  
**依赖：** GIL-Core

## 1. 定位

GIL-RL 在 Core 之上定义强化学习环境。它复用 Core 的状态、目标、约束和动作，同时增加观察、信念、初始分布、环境动力学、终止和奖励。

核心原则：

> 目标定义什么算成功，约束定义什么不可接受，奖励定义学习过程中如何评价和搜索。Reward 不自动等于人类目标。

## 2. 形式模型

一个 GIL-RL 环境可以编译为 MDP、POMDP 或约束 MDP：

\[
E=\langle S,A,T,O,Z,\rho_0,R,\gamma,H,\mathcal G,\mathcal C\rangle.
\]

其中：

- `S`：环境状态；
- `A`：动作空间；
- `T`：状态转移动力学；
- `O、Z`：观察与观察函数；
- `ρ0`：初始状态分布；
- `R`：奖励；
- `γ、H`：折扣和时间范围；
- `G`：目标；
- `C`：约束。

策略优化是在目标、约束和权限边界内最大化所声明的回报，而不是把所有要求自动折算为一个标量。

## 3. 状态、观察、信念与上下文

### 环境状态

描述环境相关变量，可以包含隐藏信息。

### 观察

```text
observation {
  visibleCells: Set<Cell>;
  battery: Percentage;
}
```

观察不等于环境状态时，不得声称环境是完全可观测 MDP。

### 信念

```text
belief {
  distribution: Distribution<EnvironmentState>;
}
```

信念表示对隐藏状态的概率判断，不表示自然语言解释歧义。

### 记忆与上下文

记忆描述智能体保留的历史；上下文描述用户、时区、本体版本和授权范围等接地信息。它们可以影响策略，但不得未经声明混入物理环境状态。

## 4. 初始分布与动力学

```text
initial {
  robot == Start;
  steps == 0;
}
```

确定性动作可以使用 Core 的后置条件。随机动作使用 `outcomes`：

```text
action move(direction: Direction)
  requires passable(next(robot, direction))
  writes robot, steps
  ensures steps' == steps + 1
  outcomes {
    0.9 -> robot' == next(robot, direction);
    0.1 -> robot' == robot;
  };
```

如果动力学由真实世界、外部模拟器或 model-free 环境提供，可以省略显式 `outcomes`。实现不得编造转移概率。

## 5. 目标与约束

```text
goals {
  achieve arrive:
    eventually within 100.steps atStation(robot);
}

constraints {
  require avoidHazards:
    always not robot in HazardCells;
}
```

对于随机环境，必须明确：

- `always` 指所有可能轨迹、实际轨迹还是某个置信水平；
- `eventually` 是否具有时间界限；
- 概率目标使用哪种初始分布和环境版本；
- 训练时约束与部署时约束是否相同。

硬安全要求不得仅用可补偿的负奖励表示。

## 6. 终止

```text
termination {
  success when atStation(robot);
  failure when robot in HazardCells;
  cutoff when steps == 100;
}
```

`success`、`failure` 和 `cutoff` 必须区分。达到步数上限不自动意味着任务失败或成功，具体语义由环境定义。

## 7. 奖励

### 7.1 转移奖励

奖励优先定义在事件或转移上：

\[
r_t=R(s_t,a_t,s_{t+1}).
\]

```text
reward {
  discount 0.99;
  horizon 100.steps;
  aggregation expectedDiscountedReturn;

  term arrival:
    100 once entered(atStation(robot));

  term elapsedTime:
    -1 per step;
}
```

`once entered(...)` 用于防止在目标状态中反复领取一次性奖励，除非规约明确希望持续奖励。

### 7.2 奖励分类

- `task`：任务结果奖励；
- `shaping`：学习塑形；
- `auxiliary`：探索、课程学习等辅助信号；
- `humanFeedback`：来自评价、比较或纠正；
- `learnedModel`：外部学习型奖励模型。

这些来源必须可区分，不得只留下一个无法解释的总分。

### 7.3 人类反馈与奖励模型

```text
preference preferred(traceA, traceB)
  source Customer
  as asserted;

rewardModel HelpfulnessModel version "3.2"
  status learned
  validFor SupportDialogues
  assumptions AnnotatorAgreement;
```

学习型奖励模型必须绑定版本、适用范围和假设。它是有误差的评价工具，不是无条件的人类价值真值。

## 8. 多目标与聚合

GIL-RL 必须区分：

- 不可交换的硬约束；
- 必须实现的任务目标；
- 可接受方案之间的偏好；
- 允许相互交换的奖励分量。

只有明确允许权衡时，才使用加权和。其他情况可以使用向量回报、字典序或 Pareto 排序。

```text
objective {
  maximize expectedReturn
  subjectTo arrive, avoidHazards;
}
```

## 9. 权限与学习

动作的环境可执行性、规则允许性和当前授权必须分别检查。训练环境中允许探索，不代表部署环境允许相同探索。

模拟器中的动作权限和真实世界权限必须使用不同作用域，不能因共用动作名称而自动继承。

## 10. 评估与证据绑定

策略的验证记录至少绑定：

- 环境版本；
- 规约版本；
- 奖励版本；
- 奖励模型版本；
- 初始状态分布；
- 训练和评估分布；
- 约束与权限版本；
- 随机种子和评估覆盖范围。

“策略表现更好”只有在这些条件明确时才具有可比较意义。

## 11. 最小一致实现

首版至少支持：

- 完全可观测环境；
- 确定性和有限随机动作；
- 必需目标与硬约束；
- 成功、失败和截断终止；
- 转移奖励与折扣回报；
- 任务奖励和 shaping 分离；
- 环境、奖励和评估分布的版本绑定。
