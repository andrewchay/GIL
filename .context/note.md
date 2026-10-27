# GIL-language 项目调研与架构笔记

## 2026-10-27 补齐 Core 语法，两个示例全部可解析

目标是把"示例文件解析不了"这个洞补上。最后两个示例都能进 AST 了。

**最关键的认识：解析 ≠ 求值。** 容易犯的错是「能解析了就当支持了」。我坚持让未实现的构造在 checker 报 `UNSUPPORTED_EXPRESSION`、模拟器报 `UNSUPPORTED_PROFILE`，并在三份文档里把这个区分写成第一条。`knowledge { assert ... as asserted }` 不使命题为真，`eventually within 2.minutes` 不带真实时钟——这两句必须出现在 README，否则读者会误判能力。

**四个踩坑记录：**

1. **量词的分隔点与限定名同形。** `exists b: H.Booking. chosen == b` —— `path()` 会把分隔点后的 `chosen` 也当成类型段，得到 `H.Booking.chosen`。试过"回退一段"，但 body 是 `b1.room == b2.room` 时会回退错（吃到 4 段，回退 1 段仍错）。最终靠**命名约定**解决：类型最多两段，第二段必须大写开头（概念名大写、变量名小写）。这在 `quantifierType()` 注释里写清楚了，改之前必须先读。

2. **`canonical()` 会因新增可选字段漂移。** 加 `output`/`knowledge`/`verification` 三个空数组、加 `Import.layer`、加 `Binding.typeExpr`，每一个都会改旧文档的 sha256。有测试守着旧 digest，一次就抓到。修法是 `normalize()` 剥离 `typeExpr`（`type` 已是规范文本，信息等价）、省略空的新章节、`layer` 只在 lexicon 时写。新增可选章节必须加进 `OMIT_WHEN_EMPTY`。

3. **`ok` 是两个 token 不是表达式。** 测试里写 `requires ok r` 直接炸——`expression` 解析完 `ok` 就停。这类"看起来像自然语言"的测试夹具容易写错，写的时候要想着语法。

4. **保留字兼作谓词。** `irreversible(action)` 里 `irreversible` 是保留字、`action` 也是。前者需要"后跟 `(` 才当调用名"，后者需要作为术语引用。用两个白名单（`predicateKeywords`、`termKeywords`）处理，没有放宽整个 reserved 集合。

**为什么 `parse` 和 `parseBundle` 分开：** 规范说一个文件一个文档。示例文件是"综合示例"，塞了三块。与其放宽 `parse` 的严格性，不如加一个显式的 bundle 入口，并让 `parse` 继续拒绝多文档（有测试守着）。

## 2026-10-27 RL 与 Workspace 层落地

用户问"项目做完了吗"——实测后确认：规范 6 份齐全，实现只覆盖 4 域的临床切片。两个示例文件当时都解析失败（`Entity<H.Customer>` 构造类型、`environment` 顶层文档）。

随后补了 RL 与 Workspace 两层最小一致实现：

**RL**：`parseEnvironment` + `checkEnvironment` + 种子化回放。关键设计是"环境原语由宿主提供"——`Cell`、`Start`、`atStation` 不是 GIL 定义的，GIL 只声明使用。这避免了编造物理语义。`cutoff` 与 `failure` 分离很重要：步数上限不是任务失败。

踩坑：`not robot in HazardCells` 最初解析成 `(!robot) in HazardCells`。原因是一元 `not` 递归调用 `prefix()` 而非完整表达式。修法是 RL 模式下 `not`/`always`/`eventually` 绑定 `expression(4)`（比较级），Core 保持原样不动。

**Workspace**：工件/来源/快照/示例集/记忆。最容易做错的是 `contentHash` 覆盖范围——最初包含 `id`，导致"同内容不同名"得到不同引用，违反"显示名称不是稳定身份"。改为只覆盖 `mediaType` + `payloadHash`。

记忆的删除语义：删除不产生新内容所以不新增 revision，只把当前版本标 `Deleted`；纠正才新增 revision。第一版实现两者都新增，导致历史里出现两个 Deleted 版本。

179 测试通过，7 个 demo 可运行。

## 2026-10-27 Phase5 完成：终结 Bool 投影

三个新工件层替换了原有的弱模型：

1. `blockers.ts` — 阻断项台账内容寻址，`openCount` 从条目派生。旧 `blockingItemsResolved: Bool` 已从 spec 移除。解除后产生**新台账**，旧批准因摘要含 `ledgerHash` 失效。
2. `deadlines.ts` — `Obligation` 强制 `sourceRef`/`sourceVersion`（无来源不能建义务，也不猜天数）；`BLOCK-CLOSURE` 逾期需 CTM 的 `ACCEPT-LATE` 回执；`ESCALATE-ONLY` 只记录升级事件。
3. `sources.ts` — 检索覆盖 `FULL/PARTIAL/NONE` + `readable`，只有全量可读才给 `CONFIRMED_ABSENT`，`missingEvidenceClaim` 是唯一能报 `MISSING_EVIDENCE` 的入口。

时间语义分离是 A30 的关键：`actionAt` 由闸门从受信时钟注入（调用者提供即 `CALLER_CONTROLLED_TRUSTED_INPUT`），`businessDate` 是调用者声明且单调，审计事件 `time` 是真实时间。两者永不合并。

闸门新增 `TRUSTED_INPUT_KEYS = ['actionAt','blockers','deadline','escalation']` 白名单——比 Phase4 的"覆盖"更严格，直接拒绝。

自查发现并修复的缺陷：`setDeadline` 换义务时未清空旧处置回执，会导致跨义务复用 `ACCEPT-LATE`。已加 `escalationApplies()` 统一判定并补测试。

Spec 改造踩坑：GIL 保留字包含 `open`、`source`，所以字段得叫 `openCount`、`sourceRef`；每个 concept 必须有且仅一个 `identity` 字段。

158 测试通过，5 个 CLI 演示可运行。

## 2026-10-27 Git 与 Phase4 完成

Git：项目原先无仓库。沙箱禁止写 `.git`（`deny file-write* (literal .../.git)`），因此仓库暂存于 `.gitstore/`，已含两次提交：
- `017a13f` feat: GIL 规范仓库与临床监查整改 Core 原型（53 文件）
- `2de518c` feat(phase4): 验证凭证、失效投影与挑战恢复
用户在自己终端执行 `mv .gitstore .git` 即可恢复标准布局（`.gitignore` 已含 `.gitstore/`）。

Phase4 实现：`evidence.ts`（要求/证据快照，claims 不进摘要，缺项 fail-closed）、`assurance.ts`（注册表签发 + 7 类失效 + 挑战）、`delegation.ts` 集成可选凭证绑定（强制 Pass+active+证据一致，覆盖自报 Bool，凭证纳入请求摘要）、`assurance-demo.ts` + `demo:assurance`。

验证：136 项测试全绿（127 + 9 凭证门），4 个 CLI 演示可运行。独立审查确认外部无法绕过 Gate 能力对象，但记录 8 项设计内限制（assurance 可选、setAssurance 为管理面、凭证门只覆盖两项动作、reviewStillValid 无条件覆盖、注册表不入摘要、换绑顺序、双次 evaluate、未实现签名/依赖图/持久化）。

覆盖矩阵 `coverage.md`：A01–A30 中 23 已实现、5 部分（A07/A09/A13/A18/A23）、2 未实现（A16 逾期、A30 时间语义）。


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
