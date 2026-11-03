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
- Phase4 `evidence.ts` 要求/证据快照：内容寻址绑定 scope+protocol+materials；`submitterClaims` 不进摘要且 `evidenceReady` 不读取；缺项默认 fail-closed。
- Phase4 `assurance.ts` 凭证注册表：仅 CRA 签发且非提交者；`evaluate` 累积 7 类失效原因，任一成立即 `active=false` 且对外强制 `Unknown`；挑战后永久失活、历史保留。
- `delegation.ts` 的 `assurance` 为**可选**绑定：配置后 `recordReviewPass`/`closeFinding` 强制要求 Pass+active 且证据摘要一致，并用凭证结果覆盖 `reviewStillValid`；未配置则退回 Phase3 legacy（不校验证据真实性）。生产适配器必须强制配置。
- `setAssurance` 属受信管理面，已校验凭证有效/Pass/证据一致；但真实身份认证仍未实现，不得暴露给普通请求者。
- 注册表对象被排除出 Gate 配置摘要（能力对象不可内容寻址）；审计仅存三个摘要，不含注册表身份与 evaluate reasons。每次 execute 调用两轮 evaluate。
- Phase5 `blockers.ts`：内容寻址阻断项台账，`openCount` 从条目派生；解除只允许 `resolutionAuthority`，解除产生新台账（旧台账不可变）。取代了 `blockingItemsResolved` Bool 投影。
- Phase5 `deadlines.ts`：`Obligation` 必须有 `sourceRef`/`sourceVersion`，`dueAt` 不能回填；`BLOCK-CLOSURE` 逾期需 CTM 的 `ACCEPT-LATE` 回执，`ESCALATE-ONLY` 只记录升级。
- Phase5 时间语义：`actionAt` 由闸门从受信时钟注入，调用者提供即 `CALLER_CONTROLLED_TRUSTED_INPUT`；审计事件 `time` 是真实时间，`payload.businessDate` 是声明日期，两者永不合并。
- Phase5 `sources.ts`：只有"全量覆盖 + 可读"才能给出 `CONFIRMED_ABSENT`；`missingEvidenceClaim` 是唯一允许报 `MISSING_EVIDENCE` 的入口。
- 闸门受信字段白名单 `TRUSTED_INPUT_KEYS = ['actionAt','blockers','deadline','escalation']`：调用者传任一个即拒绝，不做"默认已解除"推断。
- 改 `workflow.gil` 输入/状态会连带破坏 `test/parser.test.ts` 的计数断言与 `conformance/clinical-core.json` 的输入夹具，改 spec 后必须同步。
- GIL 保留字含 `open`、`source`、`requires` 等：ontology 字段不能叫这些名字（用 `openCount`/`sourceRef`）。每个 concept 必须有且仅有一个 `identity` 字段。
- Phase5 RL 层：`parseEnvironment` 解析 `environment` 文档；`in` 与 `within 100.steps` 只在 RL 模式启用（`this.rl`），Core 保持严格。`not x in S` 必须绑定整个比较表达式，否则会错解成 `(!x) in S`。
- RL 静态检查拒绝：概率和≠1、`eventually` 无 `within`、无 objective、无正的任务奖励、约束非 `always`、写未声明状态。
- RL 运行时：`cutoff` 与 `failure` 严格分离；`once entered(...)` 只在首次进入领取；奖励分 term 记账；随机性来自显式 seed（mulberry32），同 seed 必得同 `traceHash`。外部标识符一律视为宿主原语，GIL 不发明语义。
- Phase5 Workspace 层：`contentHash` 只覆盖 `mediaType`+`payloadHash`（显示名不是身份）；来源引用必须绑定已登记工件（`DANGLING_SOURCE_REF`）；记忆必须有 purpose/provenance/retention（`MEMORY_WITHOUT_PROVENANCE`）；纠正产生新 revision 并把旧版本标 `Superseded`（内容不变）；删除后 `contextFor` 排除但历史保留；`legal-hold` 拒绝普通删除。
- Workspace 是过程内能力对象：`JSON.parse(JSON.stringify(ws))` 必须被 `UNTRUSTED_WORKSPACE` 拒绝。`access` 只参与过滤，不是鉴权。
- CLI 模拟必须保留 `authorization: not-implemented` 标记。CLOSED 只表示合成 Core 契约路径，不能代替 CTM 权限、批准或实际凭证。
- runtime 动态绑定使用安全自有属性，禁止原型继承充当事实；Int 限 safe integer，Decimal 为有舍入的 Number，不用于精确临床或金额计算。
- 模拟先检查前状态再检查候选不变量；失败/Unknown 不提交。ensures 仅根状态 prime 等式赋值，所有 RHS 读取前状态。
- canonical 摘要格式 `sha256:<hex>`，含 profile，数组保序；AST 摘要不证明语义等价。
- 六层实现状态：Core / Exchange / Delegation / Assurance 有完整原型；Workspace 与 RL 有最小一致实现（无持久化、无 POMDP、无视图投影）。
- 两个示例文件都可解析：`npm run parse:examples` → 酒店（spec+interpretation+delegate）、机器人（environment）。`parseBundle` 才接受多文档，`parse` 仍只接受一个。
- 已实现求值：量词（域由 `env.domains` 显式提供，缺域报 `UNBOUNDED_DOMAIN`）、knowledge 效力（open→Unknown、ambiguous→`AMBIGUOUS_REFERENCE`）、偏好排序（`src/preference.ts`，priority 字典序）、动作返回值（`-> T` 的 result 在 requires 之后校验）。
- 仍未实现求值：单位算术（`24.hours` 无量纲模型，报 `UNSUPPORTED_PROFILE`）、compensate 执行、retryable 重试、verification 验证器调用。`ontology { type T = ... }` 与无体 relation 仍未实现。
- **时序绑定规则 B1（2026-10-31 定）**：`always`/`eventually`（含 `within`）绑定到比较级，Core 与 RL 一致。`always a == b` 即 `always (a == b)`；`always a == b && c` 是 `(always …) && c`，包住 `&&` 要加括号。`not` 在 Core 仍只绑定 unary。带括号的写法新旧 AST 相同，临床摘要未变。
- knowledge 名与 context/input/state/output 同名报 `DUPLICATE_NAME`（否则 open 会被静默遮蔽）。`operationalize` 以原文短语为键，不占名字空间。
- 量词域必须显式：Core 不推断"所有 Order"。域元素逐个 validate，类型不符是 `TYPE_ERROR` 而非静默跳过。
- knowledge claim 自引用报 `UNSUPPORTED_PROFILE`。手工构造的 spec 可能没有 knowledge 字段，`knowledgeValue` 用 `?? []` 兜底。
- 偏好排序的 Unknown 候选排在后面且 `complete:false`——不能把"取不到值"当"值很差不选"。
- 本切片角色：协调员提交、CRA 复核、CTM 关闭；Agent 只检查建议受限分派。A01–A30 见 `docs/clinical-operations/monitoring-remediation/coverage.md`（29 已实现、1 部分、0 未实现）；未标"已实现"的条目不得视为通过。

## v0.2 双场景候选规范（2026-11-01）
- `docs/gil-v0.2-{cross-domain-design,semantic-contract,dual-scenario-acceptance}.md` 是用户授权的“规范＋双场景验收”，不改OptiMed/Brando，不升级v0.1运行时或哈希。
- Core三值与知识/覆盖/新鲜度/审阅/权限分离。业务ALLOW、统计区间、能力档位均不等于True/Pass/Grant。
- 同绑定未裁决冲突：Unknown+INPUT_CONFLICT+独立review；逻辑短路不删除相关review。Observed须有效且不被冲突悬置；ConfirmedAbsent还须Complete、闭合依据、成熟窗口与零命中。
- X01–X16与F01–F17均是文档级设计验收，未执行自动测试；旧218测试通过不能证明新profile符合。

## Agent 集成原型（2026-11-02）
- `src/agent-sdk.ts`/`agent-http.ts`/`agent-semantics.ts`及`docs/agent-integration.md`：独立`gil-agent-contract-0.2-experimental`结构化合同子集，不升级v0.1，不宣称整个v0.2符合。
- 模型只提候选；domain/action的精确claim与必需review来自host。HTTP只接受snapshotId，不接受客户端自报snapshot/actor，token映射仅本地模拟；任何演示token可读取合同，不可放真实数据。
- 幂等binding含合同id；Unknown禁止换key重试/换快照。reconcile单飞；execute/verify/reconcile有时限。每次重验绑定原Grant，不能失效后静默换Grant。预算按尝试保守预留。
- `npm run demo:agent`；`serve:agent`需要三个操作者提供的不同token；Python示例`examples/agent-client.py`仅标准库。进程重启丢失会话/幂等/预算，不能用于生产。

## 对齐度量（2026-11-03）
- `src/decision-log.ts`：追加式 JSONL 决策日志，profile `gil-decision-log-0.1`；每行带内容哈希与单调 sequence，读取即重算，篡改报 `LOG_TAMPERED`。
- ground truth 是独立追加事件，纠错必须显式 `supersedes`，不改写原判定。`source` 必须分来源统计。
- L1 重复率只按 `contractHash+snapshotHash` 分组、只比 `truth+observation+issues+reviewRequired`；`outcome` 刻意排除，否则重试成功会被误报为语义漂移。
- `summarize` 只给计数与各自定义明确的比例，不合成"对齐度总分"。`groundTruth.coveredShare` 低时 L3 不成立。
- 演示：`npm run demo:decision-log [path]`，默认内存 sink，不落盘。`.gil-logs/` 已 gitignore。

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
4. **语法范围区分**：`grammar/GIL-Core.ebnf` 现含四块——Core 文档、`bundle`（多顶层文档）、`delegationDef`（委派请求）、`environmentDef`（RL 环境）。三者共享词法但语义分层：`delegate` 里的 scope/budget/autonomy 是**请求**，不是授权；`environment` 的 `in` 与 `within N.steps` 只在 RL 模式启用。
5. **解析 ≠ 求值**：构造类型、`output`/`knowledge`/`verification`、量词、单位、`prefer`、动作返回值/补偿、`lexicon` 都能进 AST，但 checker 只判定有限 Core 子集。未实现的构造必须报 `UNSUPPORTED_EXPRESSION`/`UNSUPPORTED_PROFILE`，**不能因为能解析就当作已满足**。
6. **量词分隔点消歧**：`exists b: H.Booking. chosen == b` 里的 `.` 与限定名同形。规则：类型最多两段，第二段必须大写开头（概念命名约定），否则该点是分隔符。改这条规则前先看 `quantifierType()` 的注释。
7. **摘要稳定性**：`canonical()` 会剥离 `typeExpr`（`type` 已是规范文本）并对 `output`/`knowledge`/`verification` 的空数组做省略。新增可选章节必须加入 `OMIT_WHEN_EMPTY`，否则历史摘要无故漂移——有测试守着旧 digest。
