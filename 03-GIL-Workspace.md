# GIL-Workspace：共享工件、多模态引用、状态快照与用户可控记忆

**版本：** v0.1 设计草案  
**依赖：**通用工件模型；可为 Core、Exchange、Delegation 和 Assurance 提供引用

## 1. 范围

Workspace 定义参与者共同操作的工件、状态、来源定位和记忆策略。它提供共享世界的外部表示，不决定命题真值，也不自动授予访问或执行权限。

## 2. 共享工件

```text
Artifact {
  id: ArtifactId
  version: Version
  hash: ContentHash
  mediaType: MediaType
  payload: PayloadRef
  metadata: Metadata
}
```

工件可以是规约、文档、代码、数据集、图片、图表、模拟器状态、测试结果或人类反馈。

规则：

- 内容寻址用于精确引用；
- 显示名称不是稳定身份；
- 可变外部资源必须通过快照或版本引用固定；
- 工件可访问不代表其中断言已被接受；
- 删除用户内容时应保留哪些审计哈希，由明确的保留策略决定。

## 3. 多模态来源引用

```text
SourceRef =
  TextSpan(artifact, start, end)
  | ImageRegion(artifact, region)
  | GraphNode(artifact, nodeId)
  | GraphEdge(artifact, edgeId)
  | TimeSpan(artifact, start, end)
  | Selection(artifact, objectIds)
  | SimulationState(artifact, parameters)
  | Example(artifact)
  | Counterexample(artifact)
```

每个来源引用必须绑定工件版本。对于可变的图、画布或模拟器，节点标识不足以替代版本引用。

来源引用可以参与：

- Core 的接地；
- Exchange 的提案和异议；
- Assurance 的证据与挑战；
- Workspace 的记忆来源。

## 4. 选择、例子与反例

例子和反例是重要的一等输入：

```text
ExampleSet {
  positive: Set<ArtifactRef>
  negative: Set<ArtifactRef>
  context: ContextRef
  labels: Set<LabelAssertion>
}
```

示例不自动等同于普遍规则。若 AI 从示例中归纳出规则，该规则必须标记为推断，并保留其示例来源。

## 5. 状态快照

```text
Snapshot {
  id: SnapshotId
  timestamp: Instant
  specHash: ContentHash?
  artifacts: Set<ArtifactRef>
  context: ContextBindingSet
  state: StateBindingSet
  parent: SnapshotId?
}
```

快照表示可引用的历史视图，不承诺：

- 完整捕获真实世界；
- 所有外部副作用均可恢复；
- 快照中的命题已被验证；
- 可以从快照自动重建所有隐藏状态。

## 6. 工作空间视图

不同参与者可以拥有不同投影：

```text
View {
  viewer: ActorRef
  root: ArtifactRef
  visibleClaims: Set<ClaimRef>
  hiddenOrRedacted: Set<RedactionRef>
  rendering: RenderingPolicy
}
```

视图可以隐藏或解释信息，但不得改变被引用工件的规范内容。人类可读摘要必须能够回溯到原始对象。

## 7. 用户可控记忆

### 7.1 记忆记录

```text
MemoryRecord {
  id: MemoryId
  owner: ActorRef
  scope: MemoryScope
  purpose: Purpose
  content: ArtifactRef | StructuredValue
  provenance: Set<SourceRef | EventId>
  createdAt: Instant
  retention: RetentionPolicy
  access: AccessPolicy
  status: Active | Superseded | Deleted
}
```

### 7.2 记忆策略

```text
MemoryPolicy {
  defaultRetention: RetentionPolicy
  allowedPurposes: Set<Purpose>
  userEditable: Bool
  exportable: Bool
  deletion: DeletionPolicy
}
```

首版规则：

1. 默认不因一次协作自动产生长期记忆。
2. 记忆写入必须具有用途、来源和保留策略。
3. 用户可以查看、纠正、撤销和删除其可控记忆。
4. 记忆纠正产生新版本，不静默修改历史依据。
5. 已删除记忆不得继续作为新决策的上下文。
6. 法律或审计保留要求必须作为显式例外声明，不能伪装成普通记忆。

## 8. 上下文使用

使用记忆或工作空间内容作为上下文时，必须记录：

- 使用了哪些版本；
- 用于什么目的；
- 是否只是检索候选，还是已经成为规约假设；
- 是否在决策后仍需保留。

检索到某条信息不等于该信息为真，也不等于用户同意将其用于所有目的。

## 9. 最小一致实现

首版至少支持：

- 不可变工件引用；
- 文本区间和对象选择引用；
- 状态快照；
- 示例与反例引用；
- 带来源、用途和保留期限的记忆记录；
- 用户查看、纠正和删除记忆的接口。
