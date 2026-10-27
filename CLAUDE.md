# CLAUDE.md — GIL-language 项目知识库

## 项目定位
**GIL (Grounded Intent Language，语义接地意图语言) v0.1 设计草案**。
- 面向人与 AI 协作的**声明式规约语言**，非通用图灵完备编程语言，运行时无关。
- 当前状态：设计草案 + 实验性 `gil-core-clinical-0.1` TypeScript / Node.js Core 原型；不支持完整 GIL 或真实临床执行。
- Node.js >=24 原生执行可擦除类型的 `.ts`，零第三方依赖；无需 npm install。`npm test`、`npm run check:clinical`、`npm run demo:clinical`。Node 执行不是 tsc 检查。
- Phase2解释为独立侧车：`parseInterpretation`、`interpretation.ts`、`exchange.ts`，不扩展Core Document/runtime真值。独立hash profile `gil-exchange-interpretation-0.1`，旧Core摘要不变。
- SourceSpan为UTF-16零起点半开，不能切代理对；Session单来源，ground只能引用其source.id，resolvedHash绑定source版本/hash。
- Session为过程内冻结opaque对象，WeakMap签发；反序列化会话不可调用API。真实持久化/身份系统未实现。Proxy必须在反射前拒绝，避免trap/getter执行。
- Answer/Accept仅允许外部模拟human上下文；agent即使flags为true也拒绝。修订或改答案清空当前接受，旧快照仅为历史，不是current authority。
- `npm run clarify:clinical`仅提问；`npm run demo:clarification`合成回答。解释引用目录不证明本体定义或真实权限；日期暂为Text。
- `src/` 为 parser/canonical/checker/runtime/CLI；`docs/core-profile.md` 定义支持子集与限制，临床场景在 `docs/clinical-operations/monitoring-remediation/`。
- Phase3 `plans.ts`只接受过程内签发精确接受会话，`BoundPlan`保留原始opaque身份；不能clone后再validate。绑定来源、scope、requirements、spec与全部本体hash。
- `delegation.ts`Gate内部持有current state/plan，外层模拟Grant/deny、预算、撤销、批准及审计；Core仍无角色依赖。新demo标记 `simulated-registry-and-grants`，实际证据仍为合成输入。
- 身份注册表、now及Gate管理接口是模拟可信管理面；真实认证/持久化未实现。agent kind仅Agent角色，Service暂由human适配器承载。
- 预算按budgetId跨Grant/主体累计保守min上限，使用Object.hasOwn取usage；成功批准也消耗一次。批准和执行提交前二次读钟，时间不得回退或重入。
- close要求不同提交者/CRA/CTM且有current requestHash精确批准；计划切换保留预算、递增版本，使旧请求/批准失效。撤销日志包含grantHash。
- CLI 纯Core模拟必须保留 `authorization: not-implemented` 标记。CLOSED 只表示合成 Core 契约路径，不能代替 CTM 权限、批准或实际凭证。
- runtime 动态绑定使用安全自有属性，禁止原型继承充当事实；Int 限 safe integer，Decimal 为有舍入的 Number，不用于精确临床或金额计算。
- 模拟先检查前状态再检查候选不变量；失败/Unknown 不提交。ensures 仅根状态 prime 等式赋值，所有 RHS 读取前状态。
- canonical 摘要格式 `sha256:<hex>`，含 profile，数组保序；AST 摘要不证明语义等价。
- 本切片角色：协调员提交、CRA 复核、CTM 关闭；Agent 只检查建议受限分派。完整 A01–A30 外层验收尚未实现。

## 核心架构与文件结构

依赖方向严格**由外层指向 Core**（Core 不得依赖接受事件、授权、长期记忆或验证结论来决定基本逻辑语义）：

| 层级 / 文件 | 职责与核心边界 |
|---|---|
| `README.md` | 总体定位、六大核心原则、分层职责、共同工件模型（`ArtifactRef`）、推荐实现路线 |
| `01-GIL-Core.md` | **核心语义层**：类型系统（含精化类型）、本体（Ontology）、词典与接地（Lexicon & Grounding）、知识与未决状态（`assert`/`assume`/`open`/`ambiguous`/`disputed`/`operationalize`）、三值求值（`True`/`False`/`Unknown`）、动作契约（`requires`/`ensures`/`writes`/`preserves`/`outcomes`/`reversibility`）、目标/约束/偏好分离、轨迹精化语义 $\llbracket S \rrbracket_{C,\theta}$ |
| `02-GIL-Exchange.md` | **协作协商层**：事件溯源（不可变 `Event` DAG）、`Propose`/`Clarify`/`Answer`/`Counteroffer`/`Accept`/`Reject`/`Object`/`Revise`/`Supersede`、规约状态机、`SemanticDiff`（`Narrowing`/`Widening`/`Equivalent`/`Incomparable`/`Unknown`） |
| `03-GIL-Workspace.md` | **共享空间层**：内容寻址不可变 `Artifact`、多模态 `SourceRef`、正反例集 `ExampleSet`、状态快照 `Snapshot`、参与者视图 `View`、用户可控记忆 `MemoryRecord`（默认不自动产生长期记忆） |
| `04-GIL-Delegation.md` | **授权委托层**：身份与角色分离、`Grant` 授权、自主性级别（`Suggest`/`Execute`/`Redelegate`，`bounded` 为语法糖）、默认拒绝与 7 项授权判定条件、多维 `Budget`、升级触发器 `EscalationTrigger`、精确计划 `Approval`、撤销与恢复 |
| `05-GIL-Assurance.md` | **验证保障层**：`VerificationPlan` 与 `VerificationMethod`、绑定哈希与覆盖范围的 `Attestation`（`Pass`/`Fail`/`Unknown`）、验证独立性、证据失效依赖图、运行监控 `Monitor`、挑战 `Challenge` 与恢复 `RecoveryPlan` |
| `06-GIL-RL.md` | **强化学习扩展**：基于 Core 扩展 MDP/POMDP/CMDP，新增 `observation`/`belief`/`initial`/`outcomes`/`termination`（区分 `success`/`failure`/`cutoff`）、转移奖励（如 `once entered(...)` 防刷分）、五类奖励来源分离、硬约束不可用负奖励替代 |
| `grammar/GIL-Core.ebnf` | GIL-Core v0.1 具体语法草案（支持 `ontology`、`lexicon`、`spec`、`interpretation` 四类顶层文档） |
| `examples/酒店预订.gil` | 展示 Core `spec`、自然语言 `interpretation`（接地与歧义）及 `delegate` 语法示意 |
| `examples/机器人导航.gil` | 展示 GIL-RL `environment`、随机转移 `outcomes`、终止条件、奖励与带约束优化目标 |

## 核心设计铁律（修改规范或编写实现时必须遵守）
1. **LLM 不定义语义**：LLM 只能提出 `Interpretation` 候选，规范 AST 是唯一权威对象；模型概率/置信度绝不等于用户接受或授权依据。
2. **正交概念严禁混同**：
   - 目标（`achieve`）、硬约束（`require`）、偏好（`prefer`）、奖励（`reward`）、权限（`Grant`）、证据（`Attestation`）严格分离，不可互相折算或替代。
   - `Option<T>`（值可不存在）、`Unknown`（三值逻辑中信息不足）、`open`（缺失待定参数）、`ambiguous`（多候选 AST）、`ill-formed`（语法/类型错误）严格区分，不得合并为 `null` 或 `false`。
   - 可补偿（`compensable`）不等于可逆（`reversible`）。
3. **不可变与内容寻址**：所有跨层引用必须绑定版本与 `ContentHash`；已接受工件、事件、审批、验证凭证均不可原地修改，变更必须产生新哈希并显式评估是否失效。
4. **语法范围区分**：`grammar/GIL-Core.ebnf` 仅覆盖 `GIL-Core`（`ontology`/`lexicon`/`spec`/`interpretation`）；`delegate`（Delegation 层）和 `environment`（GIL-RL 层）的语法目前在对应规范文档和 `examples/` 中示意，尚未合入 `GIL-Core.ebnf`。
