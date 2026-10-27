# 求值层补齐计划（待启动）

## 目标

把已经能解析、但 checker 与模拟器无法判定的构造补齐语义。判断标准是：
**解析通过之后，还要能回答"它成立吗"。**

当前这些构造进 AST 后一律报 `UNSUPPORTED_EXPRESSION` / `UNSUPPORTED_PROFILE`。
这不是 bug，是刻意保留的诚实边界。本计划逐项把它们变成可判定。

## 验收标准

1. 下面每一项都有正向与反向测试，反向测试必须能证明"不成立"而不是"没检查"。
2. 未实现的构造继续报 `UNSUPPORTED_*`，不得降级为"视为满足"。
3. 现有 188 项测试不回退。
4. `docs/core-profile.md` 的"解析 vs 求值"表格同步收紧，两类能力逐渐合一。
5. 每一项都要能说清：它的判定结果是否依赖真实时钟、真实身份或外部系统。依赖的一律留在模拟层并显式标注。

## 步骤（按依赖顺序）

### 1. 一阶量词求值

- 域的来源：量词变量的类型如果是 `H.Booking`，域必须由宿主显式提供，不能从当前状态猜。
- `forall` 空域为真、`exists` 空域为假——这是定义，不是约定，要写进文档。
- 与三值逻辑的交互：域内任一元素判定为 Unknown 时，`forall` 与 `exists` 都只能得到 Unknown（除非已能确定反例/正例）。
- 风险：域无限大时必须拒绝求值，报 `UNBOUNDED_DOMAIN`。

### 2. 单位与时间界限

- `24.hours`、`2.minutes` 的单位换算表要显式且有限（steps/seconds/minutes/hours/days）。
- **`eventually within N.minutes` 在 Core 里仍然不可判定**，因为 Core 没有时间推进。要么引入显式逻辑时钟，要么明确它只参与静态检查（界限必须为正、单位必须已知）而不参与求值。
- 选定哪条路必须写进 profile，不能两可。

### 3. knowledge 的语义效力

- 这是最难也最容易做错的一项。需要先回答：`open policy: CancellationPolicy;` 是否让引用 `policy` 的表达式变成 Unknown？
- 我的倾向：是。未决项参与判定时应产生 Unknown 并带原因，而不是让字段访问静默成功。
- `ambiguous` 不得被压成任一候选；引用歧义项直接是 ill-formed 或 Unknown，二者选一并说明。
- `disputed` 的记录不改变真值，只改变归因。
- 反例测试：把 `open` 项当已解决使用时，必须失败。

### 4. prefer 的偏好排序

- 只实现单一数值目标的 `minimize`/`maximize` 与 `priority` 之间的字典序比较。
- 多目标向量回报、Pareto 前沿不做。
- 关键限制：偏好排序只回答"两个候选谁更优"，不回答"这个动作是否被允许"。

### 5. 动作运行时契约

- `-> T`：动作产出值如何进入 `output` 决策变量。
- `failure RoomUnavailable`：具名结果必须是显式返回值，不是抛异常；调用方必须处理或显式忽略。
- `retryable false`：模拟器拒绝重放同一失败请求时要能说清依据。
- `reversibility` + `compensate`：补偿动作可以被声明，但**补偿执行成功的语义不在本轮实现**——这一条要明确写出来，避免读者以为撤销是自动的。
- `verification`：`verify X by modelCheck("m")` 在本轮仍然只是声明。真正接入验证器需要外部能力对象，与 assurance 层的受信注册表同构。

## 明确不在本计划内

- `ontology { type T = ... }` 细分类型、无体 relation。
- 表达式索引 `x[0]`、Core 中的 `in`、取模 `%`。
- 真实时钟、真实身份、签名、持久化。
- Workspace 视图投影与访问控制；RL 的 POMDP 与策略学习。

## 启动前需要用户决定的一件事

第 2 步（时间界限）和第 3 步（knowledge 效力）都会改变既有判定结果。如果临床切片依赖当前行为，需要先确认兼容策略：是加 profile 版本号（`gil-core-clinical-0.2`），还是保持旧 profile 并新增开关。
