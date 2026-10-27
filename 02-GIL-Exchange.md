# GIL-Exchange：提案、澄清、反提案、接受、异议、版本与语义差异

**版本：** v0.1 设计草案  
**依赖：** GIL-Core；Workspace 中的工件引用

## 1. 范围

GIL-Exchange 定义参与者如何形成、接受、质疑和修订共同理解。它采用事件溯源模型，不通过覆盖聊天记录或原地修改规约来表示协作历史。

Exchange 不改变 Core 的求值语义，也不授予动作执行权限。

## 2. 协作实例

```text
Collaboration {
  id: CollaborationId
  participants: Set<ActorRef>
  workspace: WorkspaceRef
  rootEvent: EventId
  policy: CollaborationPolicyRef
}
```

协作实例是事件、工件版本、决策和异议的逻辑容器。参与者身份与角色由 Delegation 进一步解释。

## 3. 事件模型

```text
Event {
  id: EventId
  collaboration: CollaborationId
  actor: ActorRef
  timestamp: Instant
  parents: Set<EventId>
  baseArtifacts: Set<ContentHash>
  payload: ExchangePayload
  signature: Signature?
}
```

规则：

1. 事件一旦写入不得修改。
2. 新事件必须引用其已知父事件和基础工件哈希。
3. 并发事件通过多个父事件合并，不得按到达顺序静默覆盖。
4. 签名证明事件来源，不证明其内容为真或已获接受。
5. 外部存储可以保存大对象，但事件必须保留其内容哈希。

## 4. 事件类型

### 4.1 Propose

提出解释、规约、方案或修改：

```text
Propose {
  candidates: Set<ArtifactRef>
  rationale: ExplanationRef?
  basedOn: Set<ArtifactRef>
}
```

提案不产生接受，也不授予执行权。

### 4.2 Clarify

指出需要解决的开放项、歧义或冲突：

```text
Clarify {
  target: UnresolvedRef | ConflictRef
  question: Question
  options: Set<AnswerOption>
  affects: Set<ArtifactRef | ActionRef>
}
```

问题应尽可能具体，并说明不回答会阻止哪些后续工作。

### 4.3 Answer

回答问题：

```text
Answer {
  question: EventId
  value: Value | InterpretationRef | DecisionRef
  respondent: ActorRef
  status: Asserted | Assumed
}
```

AI 推断不得冒充用户回答。

### 4.4 Counteroffer

提出不同于现有提案的替代方案，并明确其差异与取舍。

### 4.5 Accept

接受确切内容：

```text
Accept {
  target: ContentHash
  scope: AcceptanceScope
  acceptedBy: ActorRef
  conditions: Set<Condition>
}
```

接受范围可以是完整规约、某项假设、某个歧义解析、某次修订或某项行动方案。“同意这次对话”不是有效的精确接受。

### 4.6 Reject 与 Object

- `Reject`：不接受某项具体提案。
- `Object`：对已经接受、正在使用或准备使用的内容提出异议。

异议应记录理由、影响范围及请求的补救，但是否阻止执行由 Delegation 与 Assurance 策略决定。

### 4.7 Revise 与 Supersede

- `Revise`：从旧版本产生新内容哈希。
- `Supersede`：声明某个版本取代另一个版本，不删除历史。

## 5. 规约状态

一个规约版本可以处于：

```text
Draft
UnderClarification
Accepted
ConditionallyAccepted
Contested
Superseded
Withdrawn
```

状态是协作元数据，不是命题真值。较新版本不会自动使旧版本的接受失效；是否继承接受必须由差异和策略决定。

## 6. 语义差异

```text
SemanticDiff {
  base: ContentHash
  target: ContentHash
  syntacticChanges: Set<SyntaxChange>
  semanticChanges: Set<SemanticChange>
  relation: Narrowing | Widening | Equivalent | Incomparable | Unknown
}
```

至少报告：

- 目标、约束和偏好的变化；
- 接地、假设和未决项的变化；
- 状态与动作契约的变化；
- 本体和上下文版本变化；
- 可接受轨迹集合的可判定变化。

关系定义：

- **Narrowing：**新集合是旧集合的真子集，新规约严格收窄了可接受行为。
- **Widening：**旧集合是新集合的真子集，新规约允许更多行为。
- **Equivalent：**可观察语义等价。
- **Incomparable：**双方各有允许和禁止的变化。
- **Unknown：**无法自动判定。

实现无法证明等价时，不得仅因文本相似而返回 `Equivalent`。

## 7. 合并与冲突

并发修订合并时：

1. 文本可合并不代表语义可合并。
2. 冲突目标、接地或假设必须保留为显式冲突。
3. 合并不得删除任何一方仍然有效的硬约束，除非有相应权限的明确修订。
4. 接受必须指向合并后的新哈希，不能自动沿用对两个父版本的接受。

## 8. 人类可读投影

每个语义差异应能够投影为人类可读说明，并链接回具体 AST 节点。例如：

> 新版本将“24 小时内完成”改为“最终完成”，放宽了完成时限；同时新增“不得超额收费”约束。

该说明只是投影，规范效力仍属于被引用的 AST 差异。

## 9. 最小一致实现

首版至少支持：

- 不可变事件；
- 提案、澄清、回答、接受和修订；
- 精确内容哈希接受；
- 规约版本关系；
- 目标、约束、假设和接地的结构化差异；
- 无法判定时返回 `Unknown`。
