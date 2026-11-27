# GIL Lean 模式收紧实施计划

日期：2026-11-27。依据：`.context/note.md` 2026-11-27 设计对标分析（三处收紧 + 不做清单 + 战略重心）。
用户已拍板：判定工件化采用"两者结合"；第二切片领域为金融合规审批；本轮先出计划不动代码。

## 目标清单（本轮钉住）

- A. 判定结果工件化：`Entry.events` 内嵌 verdict 哈希 + decisionId 引用
- B. 统一验证入口：`verify` 命令按 profile 组合静态检查
- C. trace 可重放一等能力：`verify-trace` 命令
- D. ontology 版本兼容性检查（Import 声明版本）
- E. 金融合规审批第二切片：只出概要设计，不实施

## 不做清单（原样保持，不新开口子）

- 不做开放世界定理证明；谓词求值保持有限域 + 有界时序
- preference 永不升级为授权（`authorizeFromRanking` 提醒保持）
- 不用 Bool 冒充 attestation（phase5 已废，不回退）
- checker 不做大；新能力先走 profile 层，成熟再下沉

## 关键设计决策

### 1. 判定工件化（A）——两者结合

- `Entry.events` 元素从 `{type, actor, binding}` 扩展为
  `{type, actor, binding, verdict?: { verdictHash, truth, observation, reviewRequired }, decisionId?: string}`。
- `verdictHash = hashValue({truth, observation, issues, reviewRequired})`，口径与 `decision-log.ts` 的
  `repeatMismatchRate` 判定身份完全一致，第三方可用同一算法对账。
- `AgentService` 构造配置新增可选 `decisionLog?: LogSink`：判定发生时写入 `DecisionLog`
  （复用 `fieldsFromReport`），返回的 `DecisionRecord.id` 记入事件。未配置时事件仅含 verdict，
  审计链仍自包含。
- **profile 升级**：`gil-agent-contract-0.2-experimental` → `gil-agent-contract-0.3-experimental`。
  理由：事件结构变更直达 HTTP 响应消费者，按项目纪律结构变更升 profile，不做 additive 混搭。
  `events` 不参与 contractHash/snapshotHash/binding 哈希，升级只影响 profile 常量与相关测试断言。
- 审计链形态 = binding（合同+快照+版本）+ verdictHash（判定）两段拼接；文档写明拼接关系。

### 2. 统一验证入口（B）——只收静态面

- `verify` 覆盖三个**静态**检查面：core checker、rl-checker、agent-semantics（结构校验 + 快照判定 dry-run）。
- delegation gate / assurance gate 是**运行时**可变状态的判定，不进 CLI 组合；
  `docs/verify.md` 明确此边界，防止消费者误把 verify 当完整授权判定（伪内核）。
- 输出带版本结果对象：`{ok, profile, verifyVersion: 'gil-verify-0.1', checks: [{name, ok, code?, details?}], hashes}`。
  `profile` 是被验对象 profile；`verifyVersion` 是结果对象自身格式版本，两者分离。
- 逐项报告、不 fail-fast；exit code 取整体 ok。每个 check 带 name，失败带 GilError code。
- core profile 复用 `program()`（parse → link → check）；rl profile 用 `parseEnvironment` + `checkEnvironment`
  七项拒绝规则；agent profile 依次跑 `validateDraft` / `validateSnapshot` / `validateClaim` / `evaluateSnapshot`。

### 3. verify-trace（C）——记录式策略重放

- `Policy` 是函数不可序列化，采用记录式重放：trace 文件
  `{environmentHash?, seed, maxSteps, decisions: [{action, params}...], expectedTraceHash}`。
- `src/rl.ts` 新增 `RecordedPolicy`：第 i 步返回 `decisions[i]`；轨迹耗尽报
  `POLICY_TRACE_EXHAUSTED`（与 cutoff 严格分离，不静默截断）。
- CLI `verify-trace ENV TRACE.json`：复用 `rollout`，重算 `traceHash` 对照 `expectedTraceHash`，
  输出 `{ok, recomputedTraceHash, expectedTraceHash, match}`。外部持有 trace + environment
  两份文件即可独立重算，不信任日志——这是仓库离 zk 证明最近的一步。
- `expectedTraceHash` 缺失时只输出重算值不判 ok，供"生成基线"用途。

### 4. ontology 兼容检查（D）——Import 声明版本，精确匹配

- `Import` 增加可选 `version` 字段：spec 里写 `import Clinical as C version "0.1"`（语法以现有 EBNF
  惯例微调）。声明了 version 时 `link()` 严格相等比对，不等报 `ONTOLOGY_VERSION_MISMATCH`。
- **摘要守护**：`normalize()` 对未声明 version 的 import 剥离该字段——旧文档 canonical 哈希零漂移，
  用既有旧 digest 测试锁死（CLAUDE.md 铁律 7 的字段级应用）。
- 刻意不做 semver 范围语义：范围匹配规则是库模式的大决策，本轮只做"声明即精确匹配"，
  范围语义留给 profile 库定型时另议。
- Lexicon 的 `ontology: string` 引用版本检查记入搁置，不本轮扩。

## 实施步骤与提交切分

### Commit 1 —— 判定工件化（A）

- 改 `src/agent-sdk.ts`：Entry 事件类型、`event()` 加可选 verdict 参数、构造配置 `decisionLog`、
  AGENT_PROFILE 升 0.3-experimental。
- 判定落点：`propose`/`create` 后对 snapshot+claim 跑 `evaluateSnapshot`，verdict 记入事件；
  execute 的成功/失败结果经 `fieldsFromReport` 写 decision-log（配置了 sink 时）。
- 改 `src/agent-http.ts` / `agent-server.ts`：响应透传新字段；profile 常量同步。
- 测试（新增）：verdictHash 与 decision-log 判定身份一致、篡改 verdict 可被对账发现、
  decisionId 悬空检测、未配置 sink 时事件自包含、HTTP 响应 schema、错误消息不含 key 不回归。
- 文档：`docs/agent-integration.md` 事件 schema 与 profile 升级说明。

### Commit 2 —— verify 入口（B）

- 新 `src/verify.ts`：`runVerify(profile, inputs)`；`checks` 组装三 profile。
- 改 `src/cli.ts`：`verify core SPEC ONTOLOGY...` / `verify rl ENV` / `verify agent CONTRACT.json`
  三种调用形态；usage 字符串更新。
- 测试：三 profile 各 happy path + 至少一条失败路径（diagnostics 带出、exit code）、
  结果对象含 verifyVersion、未知 profile 报 CLI_ERROR。
- 文档：新建 `docs/verify.md`（用法 + 运行时 gate 边界声明）；README 命令清单补条目。

### Commit 3 —— verify-trace（C）

- 改 `src/rl.ts`：`RecordedPolicy` 导出；`src/cli.ts` 加 `verify-trace`。
- 测试：同 seed 同轨迹重放哈希一致、改一步 params 哈希不匹配、截断轨迹报
  `POLICY_TRACE_EXHAUSTED`、无 expectedTraceHash 时只重算。
- 演示：`demo:rl` 环境上附一段 verify-trace 实跑记录进 README。

### Commit 4 —— ontology 兼容检查（D）

- 改 `src/ast.ts`（Import）、`src/parser.ts`（版本子句解析）、`src/checker.ts`（link 比对）、
  `src/canonical.ts`（normalize 剥离策略）、`grammar/GIL-Core.ebnf`。
- 测试：声明匹配 / 声明不匹配报 `ONTOLOGY_VERSION_MISMATCH` / 未声明不检查 /
  **旧文档 canonical 哈希零漂移**（四组）。
- 临床 `workflow.gil` 与 ontology 同步补 version 声明，`check:clinical` 通过。

### 第 5 步（不占提交）—— 第二切片概要（E）

写入本计划末节，下轮启动时按此执行：

- **领域**：金融合规审批（KYC 审批 / 交易合规放行）。选型理由：判定密集、审计线索强、
  与 decision-log / blind-bench / assurance 能力最贴合；"放行/拒绝/升级"天然对应四态语义与期限义务。
- **复用资产映射**：decision-log（判定口径与 L1 自洽）、blind-bench + agreement（人工标注 κ）、
  verify 入口（三 profile）、agent 合同（模型提案回显）、delegation（审批角色分离：
  提交 / 复核 / 放行三权分立，映射协调员/CRA/CTM 结构）。
- **本体概念初稿**：Customer、KYCRecord、RiskTier、ApprovalRequest、Transaction、SanctionListHit、
  ReviewDecision；relation 初稿：`exceedsThreshold`、`sanctionMatched`。
- **X 案例设计原则**：判定密集（每例一个可对账判定）、覆盖 Observed/ConfirmedAbsent/冲突悬置/
  窗口不成熟四态、至少一对期限义务（审批 SLA）案例。
- **验收口径**：与临床切片同标准——coverage.md 全标、三教程实测、verify 全 profile 通过。

### 收尾

- README（双语）、CLAUDE.md 新条目（verify/verify-trace/事件 schema/Import.version）、
  `.context/note.md` 回填实施结果、`docs/getting-started.md` 如涉及则同步。

## 验收标准

1. `npm test` 全绿（现有 304+ 全部保留，新增覆盖上述每条路径）。
2. `check:clinical` / `parse:examples` / 全部 `demo:*` 无回归。
3. 旧文档 canonical 哈希零漂移（有专门测试断言）。
4. verify 三 profile 各有可复制的 happy/失败演示输出。
5. verify-trace 在 rl-demo 环境跑通"重放一致"与"篡改检测"两条路。

## 风险与边界

- profile 升级 → 合同哈希全变：实验性原型无生产数据，影响面限于测试与 demo 断言更新。
- verdict 进事件但 events 不进 binding 哈希：审计链完整性依赖"事件链 + decision-log 双轨"，
  文档必须写清两轨各自的证明力（事件自包含 vs 日志可对账），不夸大为防抵赖。
- RecordedPolicy 越界报错而非静默 cutoff：与 RL 层"cutoff 不是失败"的既有语义严格分离。
- 语法扩展（import version 子句）触碰 EBNF 与 parser：改动限于 import 语句局部，
  不动表达式层，量词/保留字既有坑不涉及。
