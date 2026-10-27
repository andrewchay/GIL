# Phase3：模拟授权与审计

状态：实验性单进程授权门；不是真实临床身份、安全部署或法规认证。

## 1. 依赖与可信边界

授权门位于 Core 外层。Core 的求值、类型及动作契约不读取角色或 Grant。

Gate 由适配器提供：受信主体注册表、Grant、时钟、当前已接受计划、规约和状态。请求只携带 actorId；角色从注册表解析，不能由请求自报。但本轮的注册表和 actorId 都是合成上下文，**不实现实际身份认证**。真正部署必须由认证会话固定主体，不能暴露允许调用者任意填 actorId 的接口。

Gate 控制接口是受信管理面，不能直接暴露给普通请求者；添加批准、撤销及切换计划不是从自然语言提取的权限。本轮以过程内对象和明确适配器调用表达这条边界。

所有临床检查 Bool 均为合成夹具。关闭条件中真实性、复核有效性仍不等于实际 Attestation。Phase4 才实现证据凭证与失效传播；本轮不宣称全场景安全闭环。

## 2. 固定计划

只有签发且精确接受的 Phase2 会话能 bindPlan。接受解释及回答不直接赋予行动权限。

计划固定：
- 解释 AST、模板、已解析回答摘要及接受事件。
- 来源摘要（其内包含 id/version/text）。
- 研究、中心、发现作用域和适用要求摘要。
- Core 规约和所有已链接本体摘要。
- 递归替换后的显式计划正文。

只支持完整字符串 `${name}` 替换；不执行表达式、不 eval、不自动猜值。缺少参数、未知引用或混合插值明确拒绝。固定计划仍不是规划器编译出的任意动作许可。

计划与会话是过程内签发工件；JSON 导入不被当作可信计划。哈希用于内容引用，不是签名或身份认证。

## 3. 主体和动作政策

以下为切片政策，不是通用法规要求：

| 角色 | 可申请的动作 |
|---|---|
| Coordinator | submitEvidence |
| CRA | recordReviewPass、requestChanges；不能审自己提交的证据 |
| CTM | closeFinding、reopenFinding、updateRequirement；精确批准关闭 |
| Agent | dispatchTask；仅模拟分派，不调用 Core 临床动作 |
| Service | recordAcceptedPlan、invalidateReview；受限投影服务 |

human/agent 与业务角色必须一致；当前模型 agent kind 仅用于 Agent 角色。Service 临时由受信 human 适配器承载，不冒充 AI 的批准权；它不是生产服务账号模型。服务身份不因此取得 CTM 批准权。

预算也用于批准动作：成功批准消耗一次；同一预算内还需保留后续执行额度。过期或拒绝批准不消耗次数。

关闭还需要不同的提交者、CRA 和 CTM 主体。注册表仅含角色不能代替实际提交和复核的执行来源。

## 4. Grant 与预算

默认拒绝。必须作用域精确匹配 studyId/siteId/findingId，动作在 actions 内，自主性为 Execute，期限满足 validFrom ≤ now < validUntil，且未撤销。

显式 deny 优先。Grant 的版本和内容摘要保留在审计依据中；Suggest 不能执行动作。未知状态或缺少必要批准可升级，但不能先执行再补权限。

预算只实现动作次数，maxActions 为非负安全整数。budgetId 是共享账本键：跨 Grant 或主体共享时不能刷新额度；冲突上限采用保守值。仅成功执行消耗一次，拒绝、异常及 Core 失败不扣预算。本轮不实现资金、时间或外部调用预算。

## 5. 当前版本与精确批准

Gate 内部拥有当前状态及当前计划，snapshot 只是只读副本。请求必须携带 expectedStateHash 和 expectedPlanHash；旧快照不等于当前版本。

关闭批准由注册表中的 human CTM 通过有效批准 Grant 创建。批准绑定当前计划及 requestHash；请求摘要固定主体、动作、参数、输入、预期状态和规约。只有同一 CTM 执行该精确请求时才可使用；撤销、过期或输入变化后不得继承。

setCurrentPlan 保留账本与历史，但废弃旧批准。新的计划必须匹配当前作用域及规约；要求版本变化需要显式更新计划，不可将旧接受当作新版本许可。

同步 Gate 在决策后再次检查版本和时钟。它不保证跨进程事务、数据库隔离或分布式原子性。

## 6. 执行和审计

execute 的流程：
1. 固定请求及 Attempt 引用。
2. 判定 Allow / Deny / Escalate。
3. 只有 Allow 才调用 Core simulate，或执行明确的合成 dispatchTask。
4. 捕获 Core 返回失败和异常；均不提交状态或预算。
5. 对成功候选核对版本并提交状态、预算及审计结果。

事件为内容寻址的线性父链：Attempt、Denied、Escalated、Failed、Succeeded、Control。失败链不能伪装为成功；审计必须包含真实请求主体、时间、当前版本及决策依据。

单进程时钟来自受信适配器；不是可信时间服务。日志不签名、不落盘，本轮不支持任意导入或跨进程重放。

## 7. CLI 与验收

```sh
npm run demo:delegation
npm test
```

演示先完成合成计划接受及三步整改，再展示 Agent 请求关闭被拒绝，最后由合成 CTM 对精确请求批准并执行。输出标记 `simulated-registry-and-grants` 与 `synthetic-inputs-only`；不能把 CLOSED 视为真实临床结果。

验收覆盖 A19–A23 的角色、Grant、预算部分，以及 A25/A26 的接受及批准版本边界。完整材料真实性、凭证失效、挑战恢复和真实身份仍未完成。
