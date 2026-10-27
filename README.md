# GIL：语义接地意图语言

**版本：** v0.1 设计草案  
**状态：** 设计规范尚未冻结；已提供有限 Core profile 的实验性 TypeScript / Node.js 原型  
**全称：** Grounded Intent Language

## 1. 定位

GIL 是一种面向人与 AI 协作的声明式规约语言。它描述意义、目标、约束、动作和可接受行为，并通过外围协议支持协商、共享工作空间、委托、验证与恢复。

GIL 不是通用编程语言，也不要求所有实现都使用同一种运行时。Python、Rust、SQL、求解器、规划器、Tensor Logic 或其他系统都可以承担实现、推理或验证工作。

核心原则：

1. **LLM 可以提出解释，但不定义语言语义。**
2. **规范语法树是权威对象，自然语言只是其输入或投影。**
3. **目标、约束、偏好、权限和证据不得相互替代。**
4. **未知、缺失、歧义和争议必须分别表示。**
5. **任何验证结论都只对特定目标、环境、覆盖范围和版本有效。**
6. **核心保持小巧，复杂协作能力通过分层扩展。**

## 2. 文件导航

| 文件 | 内容 |
|---|---|
| [GIL-Core](01-GIL-Core.md) | 类型、本体、接地、目标、约束、动作与形式语义 |
| [GIL-Exchange](02-GIL-Exchange.md) | 提案、澄清、反提案、接受、异议、版本与语义差异 |
| [GIL-Workspace](03-GIL-Workspace.md) | 共享工件、多模态引用、状态快照与用户可控记忆 |
| [GIL-Delegation](04-GIL-Delegation.md) | 参与者、角色、权限、预算、自主性、升级与撤销 |
| [GIL-Assurance](05-GIL-Assurance.md) | 独立验证、证据、运行监控、挑战、恢复与责任追踪 |
| [GIL-RL](06-GIL-RL.md) | 基于 Core 的强化学习环境、目标、动作与奖励扩展 |
| [核心 EBNF](grammar/GIL-Core.ebnf) | 首版具体语法草案 |
| [酒店预订示例](examples/酒店预订.gil) | 本体、接地、动作、权限与验证的综合示例 |
| [机器人导航示例](examples/机器人导航.gil) | GIL-RL 环境与奖励示例 |

## 3. 分层职责

```text
GIL-Core
  什么叫做可接受，以及规约的形式含义是什么

GIL-Exchange
  参与者如何形成、接受、质疑和修改共同理解

GIL-Workspace
  参与者共同操作哪些工件、状态、引用和记忆

GIL-Delegation
  谁可以代表谁，在什么边界内执行什么动作

GIL-Assurance
  为什么相信结论，如何持续检查、挑战和恢复
```

依赖方向必须保持由外层指向 Core。Core 不得引用接受事件、授权、长期记忆或验证结果来决定其基本逻辑语义。

## 4. 共同工件模型

所有跨层引用都使用不可变工件引用：

```text
ArtifactRef {
  id: ArtifactId
  version: Version
  hash: ContentHash
  mediaType: MediaType
}
```

已被接受的工件不得原地修改。任何修改都必须产生新内容哈希，并通过 Exchange 形成修订关系。

自然语言说明不具有隐藏规范效力。若一句话需要影响执行，其意义必须投影到规范 AST、显式假设或未决项中。

## 5. 规范用语

- **必须（MUST）：**实现不得违反。
- **应（SHOULD）：**除非存在明确理由，否则遵循。
- **可以（MAY）：**可选能力。
- **ill-formed：**不符合类型、引用或语法规则，不能进入正常求值。
- **unresolved：**形式正确，但仍存在开放参数、歧义或必要上下文缺失。
- **unknown：**在当前部分信息下无法确定真值，不等于 false。

## 6. 首版非目标

首版不试图实现：

- 通用图灵完备计算；
- 一个强制所有领域采用的 universal ontology；
- 任意规约之间的自动语义等价判定；
- 仅凭模型置信度自动解决高影响歧义；
- 从协作日志自动推断法律或道德责任；
- 把学习型奖励模型当作无误差的人类价值表示。

## 7. 推荐实现顺序

1. 规范化 AST、类型检查、本体引用和 Core 求值；
2. 开放项、歧义候选和文本接地；
3. 提案、接受和语义差异；
4. 工件快照与有边界的委托；
5. 验证凭证、运行监控和恢复；
6. 多模态接地、长期记忆和复杂多方协作。

## 8. 实验性 Core 原型

要求 Node.js >=24；源码采用可擦除类型语法的 TypeScript，零第三方运行依赖。无需 `npm install`。Node 原生执行不等于 `tsc` 类型检查。

```sh
npm test
npm run check:clinical
npm run demo:clinical
npm run clarify:clinical       # 只提出问题，不自动回答
npm run demo:clarification     # 显式重放合成回答与接受
npm run demo:delegation        # 合成授权：Agent拒绝、CTM精确批准后执行
npm run demo:assurance         # 合成凭证：失效、挑战、重开、换证据失效
npm run demo:governance        # 合成治理：阻断项、逾期升级、拒绝回填日期
npm run demo:rl                # 合成 RL：随机转移回放、终止三态、奖励分解
npm run demo:workspace         # 合成工作空间：工件、快照、用户可控记忆

# 查看规范化 AST 及摘要
node src/cli.ts ast docs/clinical-operations/monitoring-remediation/ontology.gil
```

- [Core profile 与实现边界](docs/core-profile.md)
- [Phase2 解释与澄清边界](docs/interpretation-profile.md)
- [Phase3 模拟授权与审计](docs/delegation-profile.md)
- [Phase4 验证凭证、失效与恢复](docs/assurance-profile.md)
- [Phase5 阻断项、期限与时间语义](docs/phase5-profile.md)
- [RL 层参考实现](docs/rl-profile.md)
- [Workspace 层参考实现](docs/workspace-profile.md)
- [A01–A30 覆盖矩阵](docs/clinical-operations/monitoring-remediation/coverage.md)
- [实现术语](docs/terminology.md)
- [临床监查整改场景](docs/clinical-operations/monitoring-remediation/scenario.md)
- [30 个分层验收案例](docs/clinical-operations/monitoring-remediation/acceptance.md)
- `src/`：AST、解析、规范化摘要、本体链接、GIL 静态检查、部分求值、Core 模拟及 CLI。
- `test/`：Node 内置测试；`conformance/clinical-core.json`：合成 Core 路径。

Phase2 新增独立解释入口、来源接地、open/ambiguous、澄清回答与精确接受。`src/exchange.ts` 为不可变进程内会话，不接受反序列化会话；合成主体不是实际身份凭证。解释引用只按显式目录核对，尚未加载本体文件验证其定义。既有 Core profile 与摘要保持兼容。

本原型只支持临床示例需要的有限子集。未支持构造显式拒绝；既有酒店和机器人完整示例不属于本 profile。

Phase3 提供固定计划、过程内模拟身份注册表、Grant/deny、共享动作预算、撤销、精确批准和线性审计链。旧 `simulate` 仍为纯 Core；新 `demo:delegation` 才演示模拟授权门。

Phase4 增加不可变证据/要求快照、受信注册表签发的 Attestation、失效投影（撤销、过期、规约/目标/上下文/证据变化、挑战）与挑战重开。配置凭证绑定后，复核与关闭必须由有效 Pass 凭证支撑，调用者自报的 `reviewStillValid` 不再构成依据。**凭证为进程内无签名对象，`assurance` 未配置时退回 Phase3 legacy 校验。**

Phase5 补上三类工件：内容寻址的**阻断项台账**（取代 `blockingItemsResolved` 这个 Bool 投影，解除必须由台账声明的权限主体完成）、带显式来源的**期限义务**（逾期产生升级事件，`BLOCK-CLOSURE` 需 CTM 的 `ACCEPT-LATE` 处置才能越期关闭）、以及**时间语义分离**（真实执行时间由闸门注入且拒绝调用者提供，业务日期单调不回退）。另加检索来源模型，把"确认缺失"与"无法判定"分开。

RL 层（`environment` 文档）与 Workspace 层（工件、来源引用、快照、用户可控记忆）现已具备最小一致实现：随机转移按显式种子回放，`cutoff` 与 `failure` 分离，奖励分量分别记账；记忆必须带用途、来源与保留策略，删除后不再进入上下文。

179 项自动测试通过。临床监查场景的 A01–A30 覆盖矩阵为 29 已实现、1 部分、0 未实现——**这是该场景的验收覆盖，不代表 GIL 全部六层已完成**。

**模拟 CLOSED 不代表临床发现获准关闭。** 真实身份、实际 Attestation、持久化审计和真实系统写入尚未实现；Grant/Approval 仅为模拟实现。A01–A30 是后续外层验收，不以 Core 单测替代。Int 使用安全整数；Decimal 为有限精度 Number，不用于精确金额或临床计算。

## 9. 一句话架构

> Core 定义可接受行为；Exchange 定义共同理解如何形成；Workspace 定义共同世界；Delegation 定义行动边界；Assurance 定义信任、挑战与恢复。
