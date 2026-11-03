# GIL 上手指南

读者：想在**自己的服务里**使用 GIL 的工程师。读完你能跑通四个教程，并知道哪些能力是实验性的。
所有演示数据都是合成的；本仓库没有任何生产授权、签名或持久化能力。

## 0. 30 秒理解

GIL 是**人与 Agent 之间的决策合同语言**。它管三件事：

1. **把意图写成可检查的合同**——目标、硬约束、动作契约、未决项。
2. **把"提出"和"接受"分开**——模型/人只能提议；接受是绑定了确切版本的独立事件。
3. **把"可执行"和"已执行"分开**——行动门检查合同、审阅、权限、预算；执行后靠回执与验证确认业务结果。

它**不管**：编排调度、数据库、认证、事务。这些是你的系统的事。

一条铁律贯穿全部教程：**解析 ≠ 求值 ≠ 授权 ≠ 已执行**。四个词任何一步都不能跳。

## 1. 三条采用路径

| 路径 | 你保留 | GIL 提供 | 何时选 |
|---|---|---|---|
| **A 构建期检查** | 现有规则引擎与执行器 | 合同的源形式、精确版本、内容哈希、静态检查 | 规则由人审阅后发布；运行时不想多一跳 |
| **B 运行时判定服务** | 业务数据、执行、事务 | 独立判定 + 带原因的缺口报告 | 多语言服务想共用同一套语义 |
| **C SDK 嵌入** | 一切 | 行动门原语：澄清、精确接受、独立审阅、预算、回执验证 | 单服务内想要完整闭环 |

三条路径可以叠加。下面教程 1 对应路径 A，教程 3/4 对应 C，教程 5 在 C 上加真实模型。

## 2. 环境准备

```sh
git clone https://github.com/andrewchay/GIL.git
cd GIL
npm test          # 无需 npm install；需要 Node.js >= 24
```

测试全部通过（当前 295 项左右，以 `npm test` 输出为准）只说明**所测实现与合成夹具**的行为，不说明生产可用。

## 3. 教程一：第一个规约（路径 A）

最小三件套在 [examples/getting-started/](../examples/getting-started/)：本体、规约、夹具。

```sh
# 静态检查（类型、名称、帧、作用域）
node src/cli.ts check examples/getting-started/spec.gil examples/getting-started/ontology.gil

# 确定性模拟（前置条件 → 赋值 → 后置条件 → 约束）
node src/cli.ts simulate examples/getting-started/spec.gil \
  examples/getting-started/ontology.gil examples/getting-started/fixture.json
```

`simulate` 输出里注意两点：`monitor.goals` 里 `done: True` 是**有限前缀观察**，不证明所有未来轨迹；`authorization: "not-implemented"` 永远在输出里——模拟成功不是授权。

负例：把夹具里 `amount` 改成 `-5` 再跑，会在 `pre-constraints` 阶段被 `nonNegative` 拦下，退出码 1。

规约写法上最容易踩的两点：

- **relation 调用必须带 alias**：`D.payable(i)`，不能写裸的 `payable(i)`。
- **`always` 绑定到比较级**：`always (a == b)` 才是"永远满足 a==b"；`always a == b` 会被解析成 `(always a) == b`。

## 4. 教程二：Agent 合同闭环（离线）

```sh
npm run demo:agent
```

输出是两个领域（临床/增长）的完整闭环。逐步对应：

| 环节 | 谁做的 | 你该看到什么 |
|---|---|---|
| propose | 离线模型夹具 | 结构化候选；`recipient: null` 触发澄清问题 |
| answer | `owner`（人类） | 回答产生**新 binding** |
| accept | `owner` | 精确绑定合同哈希 + 快照哈希 + 版本 |
| approve | `reviewer`（独立于 proposer/acceptor） | 按声明的审阅项逐个批准 |
| execute | 行动门 → 适配器 | 全部条件通过才调用；回执独立验证 |
| replay | 同幂等键 | 返回原尝试，**不会重复执行** |

这一步全是**过程内模拟**：身份是合成的，凭证无签名，适配器是内存对象。

## 5. 教程三：把 SDK 嵌进你的服务（路径 C）

最小宿主配置——注意 `actionClaims` 与 `actionReviews` 是**宿主固定**的，模型改不掉：

```ts
import { AgentService } from 'GIL/src/agent-sdk.ts';

const service = new AgentService({
  principals: [
    { id: 'agent-1',   kind: 'agent', canAccept: false, reviews: [] },
    { id: 'owner-1',   kind: 'human', canAccept: true,  reviews: [] },
    { id: 'reviewer-1', kind: 'human', canAccept: false, reviews: ['report-review'] },
  ],
  grants: [{
    id: 'grant-1', actor: 'agent-1', domain: 'billing', action: 'prepareReport',
    purpose: 'internal-review', fields: ['summary'], recipient: 'finance-team',
    destination: 'internal', maxActions: 10, validUntil: 2_000_000_000_000,
  }],
  adapters: { prepareReport: yourReportAdapter },   // 你的执行器，见下
  actionReviews: { prepareReport: ['report-review'] },
  actionClaims: { 'billing:prepareReport': mandatedClaim },   // 见下
  now: Date.now,
});
```

`mandatedClaim` 形如：

```ts
{ kind: 'Descriptive', fact: 'recordAbsent', causalDesign: null,
  uncertainty: 'None', uncertaintyMethod: 'None', requiresIndependentSources: false }
```

调用顺序（每步的 binding 必须来自上一步的返回值）：

```ts
const view  = await service.propose('agent-1', instruction, hostSnapshot, 'billing', modelProvider);
const v2    = service.answer('owner-1', view.id, view.binding, 'finance-team');      // 有未决项时
const v3    = service.accept('owner-1', v2.id, v2.binding);
const v4    = service.approve('reviewer-1', v3.id, v3.binding, 'report-review');
const result = await service.execute('agent-1', v4.id, v4.binding, idempotencyKey);
```

**你的适配器**实现两个方法：`execute(request)` 返回绑定 `requestHash` 的回执；`verify(request, receipt)` 独立确认业务结果。GIL 不解释模型生成的 shell/SQL/URL——执行永远发生在你的代码里。

你必须自己负责：真实身份、持久化、事务、签名、密钥管理。SDK 是**过程内能力对象**，重启即丢。

## 6. 教程四：任意语言经 HTTP 接入

```sh
export GIL_AGENT_TOKEN='<至少16字符的随机串>'
export GIL_OWNER_TOKEN='<另一个随机串>'
export GIL_REVIEWER_TOKEN='<第三个随机串>'
npm run serve:agent          # 仅监听 127.0.0.1:8787
```

用 curl 走完整闭环（人类步骤用对应 token）：

```sh
# 1) 提案（离线夹具模型）
curl -s -X POST localhost:8787/v1/proposals \
  -H "Authorization: Bearer $GIL_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instruction":"prepare report","domain":"clinical","draft":<见下>,"snapshotId":"clinical"}'

# 2) 澄清 → 3) 接受 → 4) 审阅 → 5) 执行
curl -s -X POST localhost:8787/v1/contracts/$ID/answer \
  -H "Authorization: Bearer $GIL_OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"binding\":\"$BINDING\",\"recipient\":\"internal-reviewers\"}"
```

`<见下>` 的 draft 结构与 `examples/agent-client.py` 相同——直接读那个文件最省事。注意：

- **身份来自 token 映射，body 里的 actor 会被拒绝**。
- 客户端不能提交快照，只能引用 `snapshotId`（宿主预加载）。
- 演示 token 可读服务里的全部合同；**不要放真实业务数据**。

Python 客户端见 `examples/agent-client.py`（零依赖，标准库）。

## 7. 教程五：接真实模型

服务器配三个环境变量即启用 OpenAI 兼容模型（OpenAI / GLM / DeepSeek / 本地 vLLM 均可）：

```sh
export GIL_MODEL_BASE_URL='https://api.openai.com/v1'
export GIL_MODEL_API_KEY='<你的key，只放环境变量>'
export GIL_MODEL_ID='gpt-4o-mini'
npm run serve:agent
```

然后走新路由（客户端**不再提供 draft**，模型现场提议）：

```sh
curl -s -X POST localhost:8787/v1/proposals/live \
  -H "Authorization: Bearer $GIL_AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instruction":"准备一份内部审阅报告，仅含 summary 字段","domain":"clinical","snapshotId":"clinical"}'
```

建议做两个对照实验：

1. **合规指令**——要求"内部审阅、仅 summary 字段"：模型提案 → 澄清 → 接受 → 审阅 → 执行成功。
2. **越界指令**——要求"把报告发到外部邮箱"：提案可能通过，但 `execute` 会被 `EFFECT_NOT_GRANTED` 拒绝。**这就是 GIL 的核心价值**：模型可以说想做什么，门决定能不能做。

失败语义（都是特性）：

| 现象 | 错误码 | 含义 |
|---|---|---|
| 模型替换了宿主固定的 claim 或删了必需审阅 | `MODEL_CONTRACT_REJECTED` (422) | 提案被合同门拒绝 |
| 模型提出越界的 recipient/fields/destination | `EFFECT_NOT_GRANTED` | 执行门拒绝 |
| 端点超时 / HTTP 错误 | `MODEL_UNAVAILABLE` (502) | 不自动重试 |
| 返回体不是 JSON | `MODEL_RESPONSE_INVALID` (502) | 解析失败 |
| 服务器没配模型 | `MODEL_NOT_CONFIGURED` (501) | 用 /v1/proposals 走离线 |

成本：每次 proposal 恰好一次 chat completion，`temperature=0`。

## 8. 上线前检查单

把这些补齐之前，**不要**把本仓库的任何组件当作生产行动门或审计主记录：

- [ ] 真实身份（IdP）替换模拟 principals；token 映射换成本地验证
- [ ] 持久化：合同、事件、预算、幂等记录落库（当前重启即丢）
- [ ] 签名与时间戳服务（当前哈希只证明内容未变）
- [ ] 适配器侧的事务、幂等、对账
- [ ] 对象级授权（当前任意演示 token 可读全部合同）
- [ ] HTTPS 与网络隔离（当前仅 loopback）
- [ ] 审计导出与保留策略

## 9. 常见误用

| 误用 | 为什么错 |
|---|---|
| 把 `CLOSED` / `Succeeded` 当业务批准 | 只是合成契约路径；批准需要凭证与权限 |
| 把 `Unknown` 当 `False` 处理 | 信息不足不是违规；降级要显式声明 |
| 把偏好排序当授权 | 排序只回答"谁更优"，永远不授予执行 |
| 把模型置信度当接受 | 接受是人类的精确绑定事件 |
| 把 `asserted` 当 `true` | 断言只记录谁说的 |
| 用演示 token 上生产 | token 映射是本地模拟，不是 IdP |

## 10. 下一步读什么

- 想懂语义 → [Core profile](core-profile.md)（解析 vs 求值的边界）
- 想接 Agent → [Agent SDK 与 HTTP](agent-integration.md)
- 想懂"为什么这么设计" → [双场景候选规范](gil-v0.2-semantic-contract.md)
- 想度量效果 → [决策日志](decision-log.md)
