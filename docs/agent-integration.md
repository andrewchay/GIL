# GIL Agent SDK 与 HTTP 实验性闭环

状态：离线、过程内、双场景原型。Profile：`gil-agent-contract-0.2-experimental`。
不调用真实大模型，不执行临床动作、投放、发布或生产数据库写入。

## 1. 快速运行

要求 Node.js >=24，无第三方依赖。

```sh
npm test
npm run demo:agent
```

demo分别运行临床访视缺口审阅、游戏增长报告准备：候选→接收方澄清→人类精确接受→独立审阅→受限适配器→回执验证→幂等重放。

HTTP必须由操作者配置三个不同的、至少16字符的token。不要提交token或把人类token给Agent：

```sh
export GIL_AGENT_TOKEN='<operator-provided-agent-token>'
export GIL_OWNER_TOKEN='<operator-provided-owner-token>'
export GIL_REVIEWER_TOKEN='<operator-provided-reviewer-token>'
npm run serve:agent
```

另一个终端设置相同环境变量，运行：

```sh
python3 examples/agent-client.py
```

监听地址仅127.0.0.1，默认端口8787，PORT可覆盖。Python客户端仅用标准库；演示自动使用三种身份，是合成测试，不是实际人工审批。

## 2. SDK入口

- `src/agent-sdk.ts`：AgentService、ModelProvider、FixtureModel、ActionAdapter、HostConfig。
- `src/agent-semantics.ts`：validateSnapshot、validateClaim、evaluateSnapshot。
- `src/agent-http.ts`：createAgentHTTP。
- `src/agent-demo.ts`：scenario、demoHost、agentDemo。

宿主配置principals、grants、actionReviews、actionClaims、adapters与可信时钟。模型只得到instruction/domain/可用action名称，不能收到身份能力或写入事实。

ModelProvider.propose返回结构化候选，validateDraft拒绝未知字段与不安全JSON。每个domain/action的主张合同和必需审阅由宿主固定，模型不能换一个容易成立的fact，也不能删审阅门槛。

Draft的goal是说明性文本，不是自然语言到GIL的可靠编译器。真正执行门槛来自固定的claim合同。当前仅支持布尔事实与recordAbsent，无任意表达式或通用规划器。

SDK顺序：

```text
propose(agent, instruction, hostSnapshot, domain, provider)
answer(human, id, exactBinding, recipient)
accept(human, id, exactBinding)
approve(independentReviewer, id, exactBinding, review)
execute(agent, id, exactBinding, idempotencyKey)
reconcile(agent, id, exactBinding, idempotencyKey)  // 仅未知结果
```

绑定包括profile、draft、快照、版本及会话ID。输入替换产生新绑定，清空当前接受与批准，保留事件历史。该SDK不直接复用临床硬编码Gate，而采用独立的受限合同子集；共享安全JSON、哈希与冻结工具。

## 3. HTTP协议

所有受保护请求使用Authorization: Bearer。身份由服务端token映射，body不能提供actor或role。没有IdP、多租户或对象级访问控制；任何配置token可读取该演示服务中的合同，因此不得存真实业务数据。

| 方法/路径 | JSON请求 |
|---|---|
| GET /health | 无；返回模拟标记 |
| POST /v1/proposals | instruction, domain, draft, snapshotId |
| GET /v1/contracts/{id} | 无 |
| POST /v1/contracts/{id}/answer | binding, recipient |
| POST /v1/contracts/{id}/accept | binding |
| POST /v1/contracts/{id}/approve | binding, review |
| POST /v1/contracts/{id}/execute | binding, idempotencyKey |
| POST /v1/contracts/{id}/reconcile | binding, idempotencyKey |

proposal使用离线FixtureModel。snapshotId只能引用宿主预加载快照，客户端不能提交snapshot或自报事实。当前服务器预加载clinical/growth两份合成快照。

最大body 64KiB；严格字段；拒绝带Origin的浏览器请求；不开放CORS。服务没有公开配置、撤销、快照替换或适配器注入接口。错误以code返回；这些限制不是生产安全认证。

## 4. 执行与回执

ActionAdapter由宿主注册，不解释模型生成的shell/SQL/URL。execute接收不可变ExecutionRequest，返回绑定requestHash的Succeeded/Failed回执；Succeeded还须宿主verify明确返回true，才成为已验证成功。

超时、异常、错误绑定、验证未通过均保留Unknown。未知尝试阻止换key重试和快照替换；通过reconcile核对。幂等key跨合同复用拒绝，重复请求返回原尝试状态，不再调用适配器。

预算按尝试预留，失败/未知不自动退回，避免重试绕过。权限在调用前重验；撤销不能撤回已经发出的外部副作用。真正外部适配器仍需自己的事务、幂等与权限检查。

## 5. 已实现与未实现

实现：严格结构、闭合缺失、当前冲突、布尔真值、因果设计存在性、区间标签检查、来源根数量检查、澄清、精确接受、独立审阅、作用域Grant、次数预算、绑定回执、幂等和超时核对。

**结构检查不证明来源真实性、因果识别或统计方法正确。** 不把两个不同root字符串视为科学独立性的证明。当前scope只有domain/action/purpose/fields/recipient/destination，没有企业tenant/study/site模型。

未实现：真实LLM、持久化、签名、生产身份、分布式事务、完整测量合同/映射对齐、真实新鲜度政策、依赖图影响传播、通用歧义候选与自然语言编译。没有声明符合整个v0.2规范或X01–X16/F01–F17全集。

服务重启丢失所有会话、预算和幂等记录。不得用作生产动作门或合规审计主记录。HTTP服务面向本地受信客户端；真实部署前必须补身份认证、对象级授权、持久化、容量控制与TLS。
