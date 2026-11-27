# GIL 一页纸总结

**GIL（Grounded Intent Language，语义接地意图语言）**是人与 AI 协作的决策合同语言：把"意图、边界、权限、证据"写成机器可检查、内容可寻址、审计可重放的合同。

## 起源（2026-10-26）

- 起点：v0.1 设计草案。动机：LLM/Agent 协作中自然语言充满歧义与隐式假设；prompt 无法固定语义，传统编程语言无法表达"未决、歧义、协商、权限边界、证据失效"。
- 设计参照：Lean 证明"小内核 + 可验证工件"的威力，但其前提（封闭模型）在现实世界不成立；Git/CT/zk 证明真正可移植的是**边界纪律**——内容哈希、append-only、attestation、可重放，而非开放世界定理证明。

## 目的

一条铁律贯穿全部：**解析 ≠ 求值 ≠ 授权 ≠ 已执行**，四步任何一步都不能跳。

1. **意图写成可检查合同**：目标/硬约束/偏好/奖励/权限/证据严格正交，不互相折算。
2. **提出与接受分离**：模型只能提议；接受是绑定精确内容哈希的人类事件。
3. **可执行与已执行分离**：行动门检查合同、审阅、权限、预算；执行后靠回执独立确认业务结果。

它**不是**：编排引擎、数据库、认证系统——运行时无关，宿主保留一切执行权。

## 现状（2026-11-27）

- **规范**：六层齐全（Core / Exchange / Workspace / Delegation / Assurance / RL）+ v0.2 双场景候选规范（临床 OptiMed + 增长 Brando）；双语 README。
- **实现**：TypeScript / Node≥24 零依赖原型；304+ 自动测试全绿；五教程 getting-started 全部实测。
- **端到端切片**：临床监查整改（协调员→CRA→CTM 三权分立，agent 只检查建议受限分派）——静态检查、意图澄清、模型提案→人类接受→门控执行、凭证失效传播、期限义务、阻断台账全部可跑（`demo:agent` / `demo:governance` / `demo:assurance`）。
- **Agent 集成**：SDK + HTTP（loopback）；OpenAI 兼容真实模型接入（OpenAI/GLM/DeepSeek/vLLM）；宿主固定 claim 与必需审阅，越权提案 422 拒绝。
- **度量层**：追加式决策日志（L1 自洽率）、盲测包 + Fleiss κ 一致性、三来源 ground truth 分开统计。
- **哈希纪律**：全链内容寻址；同 seed 必得同 traceHash。

## 缺陷与边界

1. **原型性**：过程内对象，重启即丢；无真实身份、无签名、无持久化；演示 token 非鉴权，不能放真实数据。
2. **判定分散**：checker / rl-checker / delegation / assurance gate / agent-semantics 五处，无统一 verify 入口——消费者各自拼装"伪内核"。
3. **审计链断点**：事件不记判定结果，第三方无法只凭日志重做出同一判断；trace 重放未一等化。
4. **单一切片**：仅临床一个垂直库，ontology/profile 网络效应未启动；Import 不带版本约束。
5. **求值边界**：单位算术、compensate 执行、retryable 重试、验证器调用未实现；开放知识求值为 Unknown。
6. **意图层薄**：澄清仍用模拟人类回答，无真实协商部署经验。

**不做清单**（防滑向"现实世界 Lean"）：开放世界定理证明；preference 升级为授权；Bool 冒充 attestation；checker 无限做大（新能力先走 profile 层，成熟再下沉）。

## 下一步

已计划待批（`.context/plan/lean-tightening.md`）：判定结果工件化、统一 verify 入口、verify-trace 可重放、ontology 版本兼容检查 + 金融合规审批第二垂直切片。
