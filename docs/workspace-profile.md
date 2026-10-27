# GIL-Workspace 参考实现概览

版本：2026-10-27。实现标签：`gil-workspace-artifact-0.1`、`gil-workspace-memory-0.1`。
对应规范：[03-GIL-Workspace.md](../03-GIL-Workspace.md)。**这是最小一致实现，不是存储系统。**

## 1. 共享工件

```ts
const artifact = addArtifact(workspace, { id: 'policy.pdf', version: '1',
  mediaType: 'application/pdf', payloadHash: 'sha256:…' });
```

内容寻址规则：

| 规则 | 实现方式 |
|---|---|
| 内容寻址用于精确引用 | `contentHash` 只覆盖 `mediaType` + `payloadHash` |
| 显示名称不是稳定身份 | `id` 与 `version` **不进入**摘要；同内容不同名得到同一引用 |
| 可变外部资源必须固定版本 | 引用一律走 `contentHash`，调用方不能只给 `id` |
| 工件可访问 ≠ 断言被接受 | 本层没有任何「接受」字段或判定 |

## 2. 多模态来源引用

已实现两种（规范 §3 列为最小子集）：

```ts
{ kind: 'text-span', artifactHash, start, end }
{ kind: 'object-selection', artifactHash, objectIds }
```

校验：`artifactHash` 必须是已登记工件，`start < end`，`objectIds` 非空且唯一。悬空引用报 `DANGLING_SOURCE_REF`——引用一个不存在的版本，接地就是假的。

## 3. 状态快照

```ts
addSnapshot(workspace, { id, timestamp, artifactHashes, parent?, specHash? })
```

快照引用确切工件版本，`parent` 形成可追溯链。它**不承诺**：完整捕获真实世界、所有外部副作用可恢复、其中的命题已被验证。

## 4. 示例与反例

```ts
addExampleSet(workspace, { name, positive: [ref], negative: [ref] })
```

同一来源不能同时是正例和反例（`CONFLICTING_EXAMPLES`）。示例集是输入，不是归纳出的规则；若从示例推断规则，规则必须标记为推断并保留示例来源（这一点由上层负责，本层只固定引用）。

## 5. 用户可控记忆

### 写入必须有用途、来源和保留策略

```ts
addMemory(workspace, {
  owner: 'ALICE', scope: 'user', purpose: 'answer-language-preference',
  content: { kind: 'value', value: 'prefers Chinese' },
  provenance: [span],                       // 空数组 → MEMORY_WITHOUT_PROVENANCE
  retention: { kind: 'session' },           // session | until | legal-hold
  access: 'owner-only',                     // owner-only | workspace
  createdAt: NOW,
});
```

**没有「顺手记住」的入口**：API 只接受显式调用，不存在由一次协作自动产生长期记忆的路径。

### 纠正产生新版本

`correctMemory` 追加 revision，把旧版本标记为 `Superseded` 并写入 `supersededBy`。旧版本的 `content` 与 `provenance` **完全不变**——这正是「不静默修改历史依据」。只有所有者能纠正（`MEMORY_OWNER_REQUIRED`），已被取代或删除的版本不能再改。

### 删除后不再作为上下文

`deleteMemory` 把当前版本标记为 `Deleted` 并记录 `deletedAt`，内容与来源保留用于审计。之后：

| 查询 | 已删除记忆 |
|---|---|
| `contextFor` | 排除 |
| `listMemories` | 默认排除，`includeDeleted: true` 可查 |
| `memoryHistory` | 保留，可追溯 |

### 法律保留是显式例外

`retention: { kind: 'legal-hold', authority, reason }` 的记忆拒绝普通删除（`LEGAL_HOLD_BLOCKS_DELETION`），也不会进入 `purgeable`。它必须作为显式例外声明，不能伪装成普通记忆。

### 到期不静默删除

`retention.kind === 'until'` 到期后：不再进入 `contextFor`，但仍留在工作空间，由 `purgeable` 报告、由人决定是否清理。本层不自动删除任何记录。

## 6. 已知限制

1. **没有持久化**：工作空间是过程内能力对象（WeakMap），`JSON.parse(JSON.stringify(ws))` 会被 `UNTRUSTED_WORKSPACE` 拒绝，也无法跨进程恢复。
2. **没有访问控制**：`access` 字段只参与 `contextFor` 过滤，不是真实鉴权。`owner` 是声明值，不是已认证身份。
3. **删除不是物理删除**：记录状态改变、内容保留；真正的擦除需要外部存储配合。
4. **没有图/时间区间/模拟器状态引用**：规范 §3 列出的 `GraphNode`、`TimeSpan`、`SimulationState` 未实现。
5. **没有视图投影**：规范 §6 的 `View`（隐藏/脱敏）未实现，`redaction` 语义缺失。
6. **`legal-hold` 只有阻断语义**：没有「有权豁免者」的接口，需要外部流程提供。
7. 所有工件载荷都是**外部引用**（`payloadHash`），本层不读取、不校验载荷内容。
