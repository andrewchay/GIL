# 任务进度

## 一致性修复（2026-10-31 完成，未提交）

- [x] 时序绑定统一为 B1：`always`/`eventually`/`within` 绑定到比较级，Core 与 RL 一致；EBNF 同步。
- [x] 临床 workflow.gil / ontology.gil 摘要改动前后逐字相同（已对照验证）。
- [x] 酒店示例 `always chosen.totalPrice <= …` 现在按原意解析，无需改示例。
- [x] knowledge 名与 context/input/state/output 冲突报 `DUPLICATE_NAME`。
- [x] 顺带修复：两条 `operationalize` 曾因 name 为 undefined 被误判重复。
- [x] parser 探测列表只保留未实现构造。
- [x] 文档漂移：interpretation-profile、phase4/evaluation 计划状态、CLAUDE.md 旧规则、README 测试数。
- [x] 218 pass；8 demo + parse:examples + check:clinical 全绿。
- [ ] 提交：需用户执行 `mv .gitstore .git` 后提交（门禁禁止 GIT_DIR 覆盖）。

## 求值层补齐（2026-10-31 完成）

- [x] 量词求值：`env.domains` 显式域，缺域 `UNBOUNDED_DOMAIN`；空域 forall=true / exists=false；域元素 validate；Unknown 优先于确定；全称/存在短路。
- [x] knowledge 效力：open→Unknown（带原因），ambiguous→`AMBIGUOUS_REFERENCE`，assert/assume/disputed 提供定义但不提升真值，自引用报 `UNSUPPORTED_PROFILE`。
- [x] 偏好排序 `src/preference.ts`：priority 字典序、方向应用、重复 priority 拒绝、非数值目标拒绝、Unknown 候选 `complete:false`。
- [x] 动作返回值：`-> T` 的 `result` 在 requires 通过后校验，缺失 `MISSING_RESULT`、多余 `UNEXPECTED_RESULT`、requires 阶段读 result 报 `UNSUPPORTED_PROFILE`。
- [x] 具名失败：requires 失败时 `declaredFailures` 列全部候选，不选一个；`retryable` 作为声明透出。
- [x] `assertPure` 覆盖新节点（bounded/quantifier），避免量词体漏检 next-state 引用。
- [x] 发现并记录既有语法陷阱：Core 的 `always`/`eventually` 只绑定紧随 unary 表达式，包住比较必须加括号。
- [x] 新测试：`test/quantifier.test.ts`（12）、`test/preference.test.ts`（7）、`test/action-contract.test.ts`（7）。
- [x] `demo:evaluation` 串起四项能力，输出 `synthetic-evaluation-simulation` + `authorization: not-implemented`。
- [x] 文档：`docs/core-profile.md` 重写求值与语法陷阱章节；README、CLAUDE.md 同步。

## 仍未实现

- 单位算术（无量纲模型，`24.hours` 报 `UNSUPPORTED_PROFILE`）；`eventually within` 界限只记录不判定。
- compensate 执行、retryable 重试语义、verification 验证器调用。
- `ontology { type T = ... }`、无体 relation、索引 `x[0]`、Core 中 `in`、取模 `%`。
- Workspace 持久化/视图投影/访问控制；RL 的 POMDP 与策略学习。
- 生产件：真实身份、签名与时间戳、跨进程事务。

## 历史阶段

Phase5、RL/Workspace 两层、Core 语法补齐的记录见 `.context/note.md`。
