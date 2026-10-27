# Phase2：解释、接地与澄清

状态：实验性 `gil-exchange-interpretation-0.1`。零外部 LLM 依赖；使用人工编写的确定性候选及合成回答。

## 1. 架构边界

解释侧车独立于 Core `Document` 与求值器。`parseInterpretation` 复用词法和表达式解析，不让协作接受改变 Core 真值。

支持：interpretation、精确版本本体导入、ground sourceSpan → 显式目录引用、open、ambiguous。暂不支持 lexicon、assert/assume/disputed、任意接地表达式和自动自然语言编译。

候选集合由一个解释中的 ambiguous 引用表达；本轮不生成所有组合 AST，也不自动选择最高概率解释。候选目录是显式测试上下文，不是通用本体或权限系统。

## 2. 来源与接地

SourceArtifact 包含 id、version、hash、text；摘要绑定身份、版本及文本。来源可读不意味着其断言真实。接地引用通过 id 在受检上下文中找到精确工件；摘要和版本固定后不可替换。

`sourceSpan(id,start,end)` 使用 UTF-16 代码单元，0 起点，半开区间 `[start,end)`；必须位于来源文本中，且不切开代理对。这个约定仅属于新 profile，不重新解释既有酒店示例的模糊位置单位。

临床输入“把培训记录的问题处理掉”：培训记录 `[1,5)`；问题 `[6,8)`。来源为合成 REQUEST-DEMO version 1。会话采用单来源约定：所有 ground 必须引用 session.source.id；其它同文来源也不能替代它。resolvedHash 绑定该来源的身份、版本及内容摘要。

ground 只引用显式目录内的形式对象。目录不证明对象为真、存在于真实系统或可执行。本轮只检查本体导入版本格式和别名，并校验显式目录；**不加载本体文件证明这些解释引用已在本体定义**。临床意图目录是单独的合成概念目录，不把它误称为 Core 本体类型检查。拼错引用、越界位置、篡改来源和无精确版本导入属于错误，不降为 Unknown。

## 3. 未决项与阻断

- open：缺少明确参数，不由 Agent 任填。初版支持 Text、Bool、Int 回答；日期暂为 Text，不宣称已验证业务日期格式。
- ambiguous：多个目录引用仍可解释原意；需要明确回答。
- Unknown：Core 部分信息下真值不能确定；不与 open 混为一个 null。

每个未决项必须有 affects 列表，标明所阻断的动作。例如整改期限未知只阻断 classifyOverdue，不禁止所有材料准备。本 profile 的“接受整个计划”要求全部问题有回答；可以继续不受影响的准备工作，但尚不实现部分范围接受。

## 4. 事件与接受

最小事件：Propose → Clarify → Answer → Accept。每个事件固定主体、父事件及负载，以内容摘要作为引用；更新返回新会话，旧历史不覆写。旧快照的接受只是旧分支的内容同意；本 API 无全局 current 指针，不能用旧 accepted 缓存作为新版本授权。后续持久化协作层必须显式判定当前版本。事件无可信时间戳或签名，本轮只保证过程内父引用和内容绑定。

ActorContext 必须来自外部适配器或合成夹具。human/mayAnswer/mayAccept 是测试接口的可信输入，不是已实现认证。调用方若自行伪造上下文，就不具备真实安全边界；自然语言与 actorId 字符串不能证明身份。

Agent 可以提出解释和问题；不能代答或接受。人类回答必须符合候选或参数类型。回答改变后旧接受失效。

接受同时绑定：
1. interpretationHash：精确解释 AST。
2. planHash：精确计划模板。
3. resolvedHash：解释、计划及所有已解析回答的组合。

模板里的 `${name}` 只是夹具表示；resolvedHash 固定真实回答，但本轮不将其自动编译成可执行 Core 计划。Accept 不意味着执行许可，也不能生成 CTM 关闭批准。

候选修订后，重新提案及澄清，清空答案和接受；不能静默沿用旧版本。同意某次对话不是有效的精确接受。

## 5. CLI

```sh
npm run clarify:clinical
npm run demo:clarification
```

第一个命令只提出问题，不生成回答或接受。第二个显式重放夹具中的合成人类回答，输出警告；不是实际用户同意。

本轮不持久化或导入任意会话 JSON。事件链用于单进程模拟及测试，不是签名日志、真实审计存储或完整 Exchange DAG。任何过程内会话保护都不代替部署时认证和持久化验证。

## 6. 验收映射

A17：适用版本、期限以 open 保留，不能猜最新或虚构逾期。
A24：不明确“处理”操作，显示多个候选和阻断范围。
A25：Agent 推断不能写入人类 Answer/Accept。

仅覆盖这些案例的解释与澄清部分。Grant、证据凭证、临床权限和真实状态写入仍属于后续阶段。既有 Core profile 及摘要保持不变。
