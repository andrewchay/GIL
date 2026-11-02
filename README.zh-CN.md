# GIL：语义接地意图语言

[English](README.md) | **简体中文**

**Grounded Intent Language（GIL）** 是面向人与 AI Agent 协作的声明式规约语言。它描述意义、目标、约束、动作与可接受行为，并通过分层协议支持澄清、接受、共享工件、委托、验证和恢复。

**项目状态：** v0.1 设计草案、v0.2 候选语义合同，以及实验性 TypeScript/Node.js 原型。规范尚未冻结，实现只覆盖声明的子集，不是生产授权平台。

## 为什么需要 GIL？

Agent 不能把“我认为用户是这个意思”直接变成“用户已接受”，更不能变成“我有权执行”。GIL 将这些步骤分开：

```text
用户意图与来源材料
  → 模型提出候选合同
  → 检查语义、类型、来源和缺口
  → 澄清与精确接受
  → 检查审阅、证据、当前权限与预算
  → 宿主适配器执行
  → 回执验证、监控与恢复
```

这是目标架构。当前 Agent 演示使用离线模型夹具、合成身份与内存适配器，没有调用真实大模型或生产业务系统。

GIL 不是通用编程语言，也不替代 Agent 框架、数据库或业务执行引擎。文本、结构化对象和 UI 可以作为前端；规范 AST 或合同工件确定其含义。业务系统可以通过库、HTTP 接口或领域适配器使用 GIL。

## 核心原则

1. **LLM 提出解释，不定义语言语义。** 模型置信度不等于接受或授权。
2. **自然语言不能藏着额外规范效力。** 影响执行的要求必须进入合同、假设或未决项。
3. **目标、硬约束、偏好、权限和证据分离。** 高收益不能抵消硬约束。
4. **未知、缺值、歧义与争议分别表示。** `Unknown` 不得当作满足。
5. **结论有范围和版本。** 证据只能支持指定目标、环境、方法、假设与覆盖范围。
6. **Core 保持小巧。** 协作和权限位于外层，不能直接改写 Core 真值。

## 快速开始

要求 **Node.js >=24**。源码直接利用 Node 的 TypeScript 类型擦除运行，零第三方运行依赖，无需 `npm install`。这不等于通过 `tsc` 静态类型检查。

```sh
npm test
npm run demo:agent
npm run check:clinical
npm run parse:examples
```

当前测试基线为 **265 项通过**。这只证明所测实现与合成夹具的行为，不证明生产安全、临床批准或完整规范符合性。

### 其他演示

| 命令 | 内容 |
|---|---|
| `npm run demo:clinical` | 合成 Core 状态迁移与约束检查 |
| `npm run clarify:clinical` | 提出问题，不自动回答 |
| `npm run demo:clarification` | 合成回答与精确接受 |
| `npm run demo:delegation` | 模拟 Grant、批准、预算与拒绝 |
| `npm run demo:assurance` | 凭证绑定、失效、挑战与轮换 |
| `npm run demo:governance` | 阻断项、逾期升级与日期回填拒绝 |
| `npm run demo:rl` | 种子化回放、终止状态与奖励分解 |
| `npm run demo:workspace` | 工件、来源、快照与记忆生命周期 |
| `npm run demo:evaluation` | 量词、知识项、偏好排序与动作返回值 |

查看规范化 AST 与内容摘要：

```sh
node src/cli.ts ast docs/clinical-operations/monitoring-remediation/ontology.gil
```

`parse:examples` 可解析酒店示例的 `spec + interpretation + delegate`，以及机器人示例的 `environment`。**可解析不代表已被类型检查或可执行。**

## Agent SDK 与跨语言 HTTP

实验性 profile：`gil-agent-contract-0.2-experimental`。

SDK 支持候选校验、接收方澄清、精确接受、独立审阅、作用域授权、次数预算、绑定回执、幂等与超时核对。主张合同和必需审阅由宿主固定，模型不能降低门槛。HTTP 使用宿主预加载的 `snapshotId`，不接受客户端自报事实或角色。

本地服务器需要操作者提供三个不同、至少 16 字符的 token：

```sh
export GIL_AGENT_TOKEN='<operator-provided-agent-token>'
export GIL_OWNER_TOKEN='<operator-provided-owner-token>'
export GIL_REVIEWER_TOKEN='<operator-provided-reviewer-token>'
npm run serve:agent
```

以上是占位符，请替换；不要提交 token，也不要把人类 token 给 Agent。服务器仅监听 `127.0.0.1`，默认端口 `8787`，可通过 `PORT` 修改。

在另一个终端配置相同环境变量后运行：

```sh
python3 examples/agent-client.py
```

Python 客户端仅使用标准库，分别调用临床与增长合成场景。它自动使用三种身份完成演示，**不是实际人工审批**。

详见 [Agent SDK 与 HTTP 接入说明](docs/agent-integration.md)。任一演示 token 可读取服务中的合同；服务重启丢失会话、预算与幂等记录。不要存入真实业务数据或用它执行生产动作。

## 分层架构

| 层 | 职责 | 规范 |
|---|---|---|
| Core | 类型、接地、目标、约束、动作契约与三值语义 | [01-GIL-Core.md](01-GIL-Core.md) |
| Exchange | 提案、澄清、回答、精确接受、异议与修订 | [02-GIL-Exchange.md](02-GIL-Exchange.md) |
| Workspace | 不可变工件、来源定位、快照、视图与用户可控记忆 | [03-GIL-Workspace.md](03-GIL-Workspace.md) |
| Delegation | 身份、Grant、作用域、预算、批准与撤销 | [04-GIL-Delegation.md](04-GIL-Delegation.md) |
| Assurance | 方法、证据、凭证、失效、挑战与恢复 | [05-GIL-Assurance.md](05-GIL-Assurance.md) |
| RL 扩展 | 环境、随机转移、终止条件、奖励与受约束优化 | [06-GIL-RL.md](06-GIL-RL.md) |

依赖由外层指向 Core。接受、权限、长期记忆与验证凭证不能决定 Core 的基本逻辑语义。

跨层引用绑定不可变内容：

```text
ArtifactRef {
  id: ArtifactId
  version: Version
  hash: ContentHash
  mediaType: MediaType
}
```

显示名称不是稳定身份。修改已接受工件必须产生新内容哈希，并显式处理修订和失效。SHA-256 是内容标识，不是签名、认证或语义等价证明。

## v0.2 候选：临床运营与游戏增长

这轮候选规范分别表达 **真值、知识状态、观察覆盖、新鲜度、审阅义务与行动权限**。它补充测量口径、主张类别、统计不确定性、来源独立性和外部效果边界。

- [跨领域设计依据](docs/gil-v0.2-cross-domain-design.md)
- [候选语义合同](docs/gil-v0.2-semantic-contract.md)
- [16 组成对案例与 17 个文档夹具](docs/gil-v0.2-dual-scenario-acceptance.md)

类型框是候选模型，不是已实现 `.gil` 语法。Agent 原型只实现其中一个结构化合同子集；文档验收全集没有作为完整自动符合性套件执行。v0.1 的语言与摘要 profile 不因此升级。

## 已实现能力与重要限制

| 模块 | 实验性能力与边界 |
|---|---|
| Core | 解析、本体链接、有限静态检查、Strong Kleene 三值求值、确定性后置赋值。解析范围大于检查和执行范围。 |
| 求值扩展 | 量词使用宿主显式域；`open` 产生 Unknown，引用歧义拒绝；偏好按优先级排序；动作返回值显式提供。部分表达式仍被 checker 拒绝。 |
| Exchange | 精确绑定来源、回答与接受；会话为过程内能力对象，不能从 JSON 重建权威。 |
| Delegation／Assurance | 模拟身份、Grant、批准与无签名凭证。临床 Gate 的 assurance 可选；未配置时走 legacy 路径，不验证证据真实性。 |
| 治理 | 显式来源的期限、阻断项台账、执行时间与声明业务日期分离。 |
| Workspace | 工件与来源引用、快照、记忆纠正/删除/到期；无持久化、真实访问控制或视图脱敏。 |
| RL | 宿主原语、显式 seed、有限回放；区分 success/failure/cutoff，任务与塑形奖励分开；无 POMDP 求解或策略学习。 |
| Agent SDK／HTTP | 两类离线合同闭环；只检查结构和声明，不证明因果设计、来源真实性或科学独立性。 |

尚未实现通用单位算术、Core 补偿执行、Core 重试语义、声明式 `verification` 的实际验证器调用、真实模型编译、生产身份、签名、持久化审计与分布式事务。Agent 的超时核对机制不等于完整的 Core 重试语义。

`Int` 使用 JavaScript 安全整数；`Decimal` 使用有限精度 Number，**不适合精确金额或临床数值计算**。有限前缀观察不能证明所有未来轨迹满足 `always`。

临床 A01–A30 矩阵为 **29 项已实现、1 项部分实现**，仅针对该合成场景。**模拟 CLOSED 不代表临床发现获准关闭；通过测试不代表完整 GIL 已完成。**

## 文档与仓库导航

- [Core 实现 profile](docs/core-profile.md) · [解释与澄清](docs/interpretation-profile.md)
- [授权与审计](docs/delegation-profile.md) · [凭证与恢复](docs/assurance-profile.md)
- [期限、阻断与时间](docs/phase5-profile.md) · [RL](docs/rl-profile.md) · [Workspace](docs/workspace-profile.md)
- [临床场景](docs/clinical-operations/monitoring-remediation/scenario.md) · [验收案例](docs/clinical-operations/monitoring-remediation/acceptance.md) · [覆盖矩阵](docs/clinical-operations/monitoring-remediation/coverage.md)
- [术语](docs/terminology.md) · [语法草案](grammar/GIL-Core.ebnf)
- [酒店示例](examples/酒店预订.gil) · [机器人示例](examples/机器人导航.gil)

`src/` 保存实现；`test/` 保存 Node 内置测试；`conformance/` 保存合成夹具；`docs/` 保存实现边界与候选规范；`examples/` 保存语言示例和跨语言客户端。详细规范当前主要使用中文。

## 规范用语与非目标

**MUST（必须）** 表示强制要求，**SHOULD（应）** 表示有理由时可偏离，**MAY（可以）** 表示可选。ill-formed 是语法、类型或引用不合法；unresolved 是尚有开放参数或歧义；Unknown 是当前无法确定真值，不等于 False。

GIL 不追求通用图灵完备计算、强制统一所有领域本体、任意规约的自动语义等价证明、仅凭模型分数消除高影响歧义，或从日志自动推断法律/道德责任。

> Core 定义可接受行为；Exchange 形成共同理解；Workspace 固定共享工件；Delegation 限定行动；Assurance 检查信任与恢复。
