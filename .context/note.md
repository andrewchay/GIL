# GIL-language 项目调研与架构笔记

## 2026-10-26 Phase3 模拟授权与审计完成

用户“继续”指推进下阶段，不重复Phase2收尾。新增plans.ts固定已接受解释工件，delegation.ts默认拒绝权限门、当前版本、预算累计、撤销、精确批准和内容寻址尝试/拒绝/失败/成功审计。Core无角色依赖。

验证：100项自动测试全通过（原72+计划12+授权15+CLI1）；合成CLI显示Agent关闭拒绝、CTM单独批准后模拟关闭。独立审查修复budget继承键、过期grant审批遮挡、批准提交时间及撤销摘要；定点复审通过。

绑定计划opaque对象不能clone失去签发身份。角色注册表/now/管理接口只是受信模拟适配器；Service暂为human适配器不是生产服务身份。实际Attestation、可信认证、持久化和跨进程事务仍未实现。

产出：src/delegation-ast.ts plans.ts delegation.ts delegation-demo.ts，conformance/clinical-delegation.json，docs/delegation-profile.md。npm run demo:delegation。


## 2026-10-26 Phase2 解释与澄清完成

新增独立解释AST与parseInterpretation入口；复用lexer，不改变Core Document和旧hash。支持ground、open、ambiguous，SourceSpan UTF16半开，来源摘要绑定id/version/text。

exchange实现Propose/Clarify/Answer/Accept、不可变历史、三hash精确接受和修订失效。过程内opaque会话不接受JSON导入；模拟human上下文不是实际身份。单来源接地；Proxy反射前拒绝，定点复审通过。

新增临床interpretation.gil、clinical-interpretation.json，CLI clarify:clinical / demo:clarification。72项自动测试全通过（既有44+新增28）；收尾复测再次 npm test 全通过，覆盖A17/A24/A25解释部分、篡改、来源版本、agent拒绝、类型及冻结。

限制：明确引用目录不是已加载的本体定义；没有自动自然语言编译、真实身份、完整事件DAG或持久化，日期是Text；旧快照接受只代表历史，不提供current版本授权。下一阶段授权审计尚未启动。


## 2026-10-26 Phase0/1 首轮实现

用户选择 TypeScript / Node.js。采用 Node >=24 原生类型擦除执行，零第三方依赖；无 tsc 构建或静态 TS 验证。

实现 parser、canonical SHA-256、精确本体链接、GIL 类型/帧检查、Strong Kleene 求值、确定性候选动作模拟及 CLI。profile 是 `gil-core-clinical-0.1`，非完整 Core。

验证：44 项自动测试通过；临床两文件静态检查成功；合成 OPEN → IN_REMEDIATION → SUBMITTED → REVIEWED → CLOSED 路径运行成功。所有模拟明确无授权能力。

独立审查后修复：危险键绑定、Int安全范围与负零、后置赋值拓宽方向、前状态不变量检查；定点复审无阻断项。

限制：无真实身份/Grant/Approval/Attestation，无完整A01–A30，无精确Decimal、完整时序或knowledge解释。无限轨迹always不因单快照通过而证明。原工作目录未发现Git仓库，未提交版本。

产出：`src/`、`test/`、`conformance/clinical-core.json`、`docs/core-profile.md`、`docs/terminology.md`；运行入口见README。


## 2026-10-26 首个垂直切片方向（用户确认）

- 用户同意收窄范围、先验证端到端切片；不再使用酒店预订场景。
- 业务领域：临床试验运营（clinical operations）。
- 首个工作流：监查发现与整改。
- 首版交付（用户确认）：先做场景规约与验收案例，再据此实现。
- 具体发现（用户确认）：培训记录缺失／版本不匹配。
- 角色规则（用户确认）：中心协调员提交材料、CRA 复核、CTM 关闭；Agent 仅检查、建议和受限分派，不批准或关闭。
- 交付目录：`docs/clinical-operations/monitoring-remediation/`；包含场景规约、领域本体、Core 工作流和 30 个验收案例。
- 设计边界：合成数据及模拟执行；不接真实临床系统，不作医疗判断或合规认证。
- 审查修正：区分提交新包与复核当前包；用 activeReviewHash 绑定精确凭证；失效后 REVIEWED 降为 SUBMITTED，Unknown 仅阻断，历史不覆写。
- 最终独立人工审查无阻断项；尚无机器解析、测试或形式证明。


## 2026-10-26 GIL v0.1 语言规范全景解析

### 1. 项目概览
- **项目名称**：GIL（Grounded Intent Language，语义接地意图语言）
- **当前版本**：v0.1 设计草案（尚未冻结，纯规范与语法/示例仓库，无实现代码）
- **核心解决的问题**：在人与 AI（尤其是 LLM / Agent / RL 系统）协作时，自然语言充满歧义、隐式假设和边界不清，而传统编程语言或单纯的 Prompt 无法形式化表达“意图接地、未决歧义、协商过程、权限边界、验证证据与责任追踪”。GIL 提供了一套**以规范 AST 为核心、自然语言为投影、严格分层的人机协作规约语言与外围协议**。

### 2. 五层核心架构 + 强化学习扩展（5 + 1 架构）

```text
+-------------------------------------------------------------------+
|                        外围协议与扩展层                             |
|  +----------------+  +----------------+  +---------------------+  |
|  |  02-Exchange   |  |  03-Workspace  |  |    04-Delegation    |  |
|  | 协商/事件溯源/  |  | 不可变工件/快照/|  | 角色/权限/预算/升级/ |  |
|  | 接受/SemanticDiff| | 多模态引用/记忆 |  | 批准/撤销           |  |
|  +-------+--------+  +-------+--------+  +----------+----------+  |
|          |                   |                      |             |
|          +-------------------+----------------------+             |
|                              |                                    |
|                              v                                    |
|  +-------------------------------------------------------------+  |
|  |                       05-Assurance                          |  |
|  |       验证计划 / 凭证(Attestation) / 监控 / 挑战 / 恢复       |  |
|  +-----------------------------+-------------------------------+  |
|                                |                                  |
|                                v                                  |
|  +-------------------------------------------------------------+  |
|  |                        01-GIL-Core                          |  |
|  |   类型 / 本体 / 词典与接地 / 知识状态 / 动作契约 / 轨迹语义    |  |
|  +-------------------------------------------------------------+  |
|                                ^                                  |
|                                |                                  |
|  +-----------------------------+-------------------------------+  |
|  |                         06-GIL-RL                           |  |
|  |     MDP/POMDP/CMDP / 观察与信念 / 动力学 / 终止 / 多源奖励    |  |
|  +-------------------------------------------------------------+  |
+-------------------------------------------------------------------+
```

### 3. 各层关键机制提炼

#### (1) GIL-Core (`01-GIL-Core.md`, `grammar/GIL-Core.ebnf`)
- **四类顶层语法构造**：`ontology`（本体定义）、`lexicon`（词典映射）、`spec`（核心规约）、`interpretation`（自然语言接地解释）。
- **类型系统**：基础类型（含 `Instant`, `Duration`, `TimeZone`）、构造类型（`Entity<T>`, `Ref<T>`, `Quantity<Unit>`, `Distribution<T>`, `Option<T>`）、无副作用精化类型（`{ x: T | P(x) }`）。严禁隐式单位换算与隐式实体转换。
- **接地与解释（Grounding & Interpretation）**：自然语言经过词典和接地生成**候选解释集合**（而非唯一 AST），显式保留 `ground`（绑定 `SourceRef`）、`assumptions` 和 `unresolved`。
- **六种知识与未决构造**：`assert`、`assume`、`open`（开放参数，产生参数化语义族）、`ambiguous`（多候选）、`disputed`（争议）、`operationalize`（模糊概念可操作化）。
- **三值逻辑与时序表达**：求值结果为 `True | False | Unknown`（硬约束为 `Unknown` 时不算满足）；支持一阶量词（`forall`/`exists`）、时序算子（`always`/`eventually`/`within`/`after`）、事件谓词（`entered`/`changed`）及下一状态引用 `x'`。
- **动作契约与帧规则**：显式声明 `requires`、`ensures`、`writes`、`preserves`、随机分支 `outcomes`、失败类型 `failure`、重试性 `retryable`、可逆性 `reversibility`（`reversible` | `compensable` | `irreversible`）与补偿动作 `compensate`。
- **形式语义**：规约 $S$ 在环境 $C$ 和已解析参数 $\theta$ 下的指称语义 $\llbracket S \rrbracket_{C,\theta}$ 是满足所有必需目标 $G_{\mathrm{required}}$、硬约束 $C_{\mathrm{hard}}$ 和动作契约 $A_{\mathrm{contracts}}$ 的执行轨迹集合；偏好 `prefer` 仅按优先级字典序在合法轨迹间排序。实现精化关系定义为轨迹包含 $\operatorname{Traces}(I) \subseteq \llbracket S \rrbracket_{C,\theta}$。

#### (2) GIL-Exchange (`02-GIL-Exchange.md`)
- **不可变事件 DAG**：所有协商历史由带父事件引用和 `ContentHash` 的 `Event` 构成。
- **交互原语**：`Propose`、`Clarify`、`Answer`（严禁 AI 推断冒充用户回答）、`Counteroffer`、`Accept`（必须绑定精确 `ContentHash` 与范围）、`Reject`、`Object`、`Revise`、`Supersede`。
- **语义差异（SemanticDiff）**：比较两个版本可接受轨迹集合的关系（`Narrowing` / `Widening` / `Equivalent` / `Incomparable` / `Unknown`），无法证明等价时不得因文本相似返回 `Equivalent`。

#### (3) GIL-Workspace (`03-GIL-Workspace.md`)
- **内容寻址工件（Artifact）**：跨层统一使用 `ArtifactRef { id, version, hash, mediaType }`。
- **多模态 `SourceRef`**：支持 `TextSpan`、`ImageRegion`、`GraphNode`、`GraphEdge`、`TimeSpan`、`Selection`、`SimulationState`、`Example`、`Counterexample`。
- **用户可控记忆（MemoryRecord）**：默认不自动产生长期记忆；写入必须带用途、来源和保留策略；支持用户查看、纠正（生成新版本）、撤销和删除。

#### (4) GIL-Delegation (`04-GIL-Delegation.md`)
- **角色分离**：`Principal`、`Agent`、`Verifier`、`Approver`、`AffectedParty`、`AccountableParty`。
- **授权判定（默认拒绝）**：动作执行必须同时满足 Core 前置条件、有效 `Grant`、无显式 `deny`、多维 `Budget`（金钱/动作数/时长/算力/数据/外部调用）充足、接受与证据有效、无阻断性歧义/升级、未撤销/未过期。
- **自主性与升级**：`Suggest` / `Execute` / `Redelegate`（示例中 `autonomy bounded` 是 `Execute` + 范围/条件/预算的语法糖）。定义了 8 类 `EscalationTrigger`。

#### (5) GIL-Assurance (`05-GIL-Assurance.md`)
- **计划与凭证分离**：Core 中 `verification` 只是计划，实际结论由绑定 `specHash`、`targetHash`、`contextHash`、`verifierVersion` 和 `coverage` 的 `Attestation`（`Pass | Fail | Unknown`）承载。
- **独立性与失效传播**：高风险裁判要求独立性（如 `SeparateVerifierFromProposer`）；规约、实现、环境或底层假设变化自动触发依赖图上的证据失效。
- **运行监控与恢复**：`Monitor` 在违规时触发 `Halt | Escalate | Compensate | Record`；`RecoveryPlan` 区分真正恢复（`Restore`）与补偿（`Compensate`）。

#### (6) GIL-RL (`06-GIL-RL.md`)
- **形式映射**：将规约映射为受约束的 MDP/POMDP $\langle S,A,T,O,Z,\rho_0,R,\gamma,H,\mathcal G,\mathcal C\rangle$。
- **核心区分**：目标（什么算成功）、硬约束（什么不可接受，严禁仅用负奖励代替）、奖励（搜索与评价信号）三者严格分离。
- **奖励工程规范**：支持转移级奖励（如 `100 once entered(atStation(robot))` 防止刷分）；强制区分 `task`、`shaping`、`auxiliary`、`humanFeedback`、`learnedModel` 五类来源；学习型奖励模型必须标注版本、适用范围与假设。

### 4. 潜在演进方向（供后续开发参考）
1. **语法完备化**：目前 `grammar/GIL-Core.ebnf` 仅定义了 Core 语法，`examples/酒店预订.gil` 中的 `delegate` 和 `examples/机器人导航.gil` 中的 `environment` 尚无正式 EBNF 文件。
2. **原型工具链实现**（对应 `README.md` 第 7 节推荐路线）：
   - 阶段 1：词法/语法解析器（Parser）、规范化 AST 生成与 `ContentHash` 计算、类型与本体引用检查器、Core 三值求值器。
   - 阶段 2：开放项（`open`）、歧义（`ambiguous`）与 `SourceRef` 接地检查。
   - 阶段 3：`Exchange` 事件账本与结构化 `SemanticDiff` 引擎。
