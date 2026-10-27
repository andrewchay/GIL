# 任务进度

## Phase5：补齐验收缺口（2026-10-27 完成）

- [x] A18 阻断项台账：`src/blockers.ts`，内容寻址、`openCount` 派生、解除限 `resolutionAuthority`。
- [x] spec/ontology 改造：`blockers`/`deadline`/`escalation`/`businessDate`/`actionAt` 输入，`lastBusinessDate` 状态。
- [x] 闸门受信输入注入：`TRUSTED_INPUT_KEYS` 拒绝调用者伪造，阻断/期限/时间由工件派生。
- [x] A16 期限与逾期：`src/deadlines.ts`，来源强制、`BLOCK-CLOSURE`/`ESCALATE-ONLY`、`ACCEPT-LATE` 处置、升级事件。
- [x] A30 时间语义：真实执行时间注入、业务日期单调、`BACKDATED_BUSINESS_DATE`。
- [x] A13 要求更新链端到端：→OPEN、清空绑定、旧凭证 `CONTEXT_MISMATCH`、不可采纳。
- [x] A07/A09 来源建模：`src/sources.ts`，Unknown 与 `MISSING_EVIDENCE` 分离。
- [x] 测试：`test/phase5.test.ts` 22 项；全套 158 pass / 0 fail。
- [x] CLI：`npm run demo:governance`，`ok=true`。
- [x] 文档：`docs/phase5-profile.md`、coverage 矩阵（29✅/1🟡/0⬜）、README、CLAUDE.md、acceptance.md。
- [x] 自查修复：跨义务处置回执复用缺陷（`setDeadline` 清空 `escalation`）。

## 未完成 / 后续

- A23 仍为 🟡：预算消耗未绑定真实任务创建。
- 生产件缺口：真实身份认证、签名与时间戳、失效依赖图、持久化、跨进程事务。
- 检索来源未接真实 EDC/eTMF 接口。

## Git

`.gitstore/` 中已有提交；`mv .gitstore .git` 恢复标准布局。
