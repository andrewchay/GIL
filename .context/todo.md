# 任务进度

## Core 语法补齐：示例文件全部可解析（2026-10-27 完成）

- [x] `TypeExpr`：`Entity<T>`、`Option<T>`、`Set<T>`、`A | B`、`T?`、记录类型；`Binding.type` 保留规范文本，构造类型另存 `typeExpr`。
- [x] 新增章节：`output`、`knowledge`（open/assert/assume/disputed/ambiguous/operationalize）、`verification`（verify/by/under）。
- [x] `goals` 支持 `prefer ... minimize|maximize ... priority N`；`achieve` 不写 `kind`，保持既有摘要不变。
- [x] 一阶量词 `forall`/`exists`：共享类型、空白分隔、分隔点消歧（类型最多两段且第二段大写）。
- [x] 单位字面量 `24.hours`（`Expr.quantity`）与 `eventually within 2.minutes`（Core 单位白名单）。
- [x] 动作契约扩展：`-> T`、`preserves`、`outcomes`、`failure`、`retryable`、`reversibility`、`compensate`。
- [x] 来源声明 `source <expr> as asserted|assumed|inferred|disputed`，用于 context/knowledge/interpretation。
- [x] `lexicon ... for ...` 解析；`use lexicon "...";` 导入（无别名时从路径派生）。
- [x] interpretation 支持 `assume`（不进问询队列）与 lexicon 导入；exchange/interpretation 校验同步。
- [x] `delegate` 请求语法解析（`DelegationDocument`）：scope/autonomy/budget/requires/requiresEvidence/approval/onConflict/onUncertainty/revokeBy/expires。
- [x] `parseBundle`：一个文件可含 spec + interpretation + delegate；`parse` 仍只接受单文档。
- [x] `canonical()` 剥离 `typeExpr`、空 `output`/`knowledge`/`verification`，旧 digest 不变。
- [x] EBNF 补入 `bundle`、`delegationDef`、`environmentDef` 三块。
- [x] CLI 新增 `parse FILE` 与 `npm run parse:examples`。
- [x] `examples/酒店预订.gil`、`examples/机器人导航.gil` 均可解析。
- [x] 测试 188 pass / 0 fail；7 个 demo + parse:examples + check:clinical 全绿。
- [x] 文档：`docs/core-profile.md` 改写"解析 vs 求值"边界，README 与 CLAUDE.md 同步。

## 仍未实现（求值层）

- 量词、单位运算、knowledge 语义效力、prefer 排序、`-> T` 返回值、failure/retryable/reversibility/compensate、verification 验证器调用 → checker 报 `UNSUPPORTED_EXPRESSION`，模拟器报 `UNSUPPORTED_PROFILE`。
- `ontology { type T = ... }`、无体 relation、表达式索引 `x[0]`、Core 中的 `in`、取模 `%`。
- Workspace 持久化、视图投影、访问控制；RL 的 POMDP 与策略学习。
- 生产件：真实身份、签名与时间戳、跨进程事务。

## 历史阶段

Phase5（阻断项/期限/时间语义）与 RL/Workspace 两层的落地记录见 `.context/note.md`。
