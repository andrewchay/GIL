# Phase5 概览：阻断项、期限与时间语义

版本：2026-10-27。实现标签：`gil-assurance-blockers-0.1`、`gil-assurance-obligation-0.1`、`gil-assurance-sources-0.1`。

本文件描述 Phase5 新增的三类工件与它们在授权门中的位置。**全部为合成数据与过程内工件**，不含真实身份、签名、监管时限或临床结论。

## 1. 阻断项台账（取代 Bool 投影）

Phase4 之前，Core 用 `blockingItemsResolved: Bool` 表达"其他阻断项已解除"。这个投影有两个问题：调用者可以自报 `true`；被拒时无法说明是谁、凭什么解除。

`src/blockers.ts` 用内容寻址台账取代它：

| 概念 | 含义 |
|---|---|
| `BlockerEntry.id` | 阻断项标识，台账内唯一 |
| `target` | 被阻断的目标（动作或对象），用于向人解释 |
| `kind` | `policy` / `dispute` / `escalation` |
| `owner` | 当前责任人 |
| `resolutionAuthority` | 唯一有权解除本条的主体 |
| `state` | `OPEN` / `RESOLVED` / `WAIVED` |

派生规则：

- `blockerStatus(ledger)` 从台账**实际条目**算出 `openCount`，Core 只看到这个派生值。
- `resolveBlocker` 只接受 `actor === resolutionAuthority`，否则 `RESOLUTION_AUTHORITY_REQUIRED`。
- 解除产生**新台账**；旧台账不可变，因此旧批准与旧请求摘要自动失效。
- `blockerStatus` 的计数会进入闸门注入的 Core 输入；台账摘要进入请求摘要。

闸门行为：

| 情形 | 结果码 |
|---|---|
| 调用者在 `inputs` 里提供 `blockers` | `CALLER_CONTROLLED_TRUSTED_INPUT` |
| SPEC 声明了 `blockers` 但闸门未配置 | `BLOCKER_LEDGER_REQUIRED` |
| 仍有 `OPEN` 项 | `BLOCKERS_OPEN`（`blockerReport` 给出目标与解除权限） |

## 2. 期限与逾期（A16）

`src/deadlines.ts` 的 `Obligation` 强制携带来源：

| 字段 | 约束 |
|---|---|
| `dueAt` | 必须严格晚于创建时间；回填的过去期限被拒绝 |
| `sourceRef` / `sourceVersion` | 非空。没有来源就无法创建义务 |
| `policy` | `BLOCK-CLOSURE` 或 `ESCALATE-ONLY` |

`deadlineStatus(obligation, at)` 只报告事实：

| 情形 | reason | blocked |
|---|---|---|
| 未到期 | `WITHIN-DUE` | false |
| 逾期 + `BLOCK-CLOSURE` | `OVERDUE-BLOCKED` | true |
| 逾期 + `ESCALATE-ONLY` | `OVERDUE-ESCALATED` | false |

逾期时闸门写入 `Escalation` 审计事件（含 `dueAt`、`sourceRef`、`policy`），**不产生任何复核结论**。

越期关闭需要显式处置回执 `EscalationAck`：

- `disposition: ACCEPT-LATE` 才解除期限阻断；`REMEDIATE` 表示先整改，Core 继续阻断。
- 只有注册表内的具名 CTM 能登记处置，其他人 `HUMAN_APPROVAL_REQUIRED`。
- 回执不能早于期限届满签发。

## 3. 时间语义（A30）

真实执行时间与声明业务日期是两条独立通道：

| 通道 | 来源 | 用途 |
|---|---|---|
| `actionAt` | 闸门从受信时钟注入 | Core 的期限比较；调用者提供即拒绝 |
| `businessDate` | 调用者声明 | 业务归属日期，单调不回退 |
| 审计事件 `time` | 受信时钟 | 真实执行时间，永不等于业务日期 |

回填防护：`recordBusinessDate` 拒绝小于已记录值的日期（`BACKDATED_BUSINESS_DATE`）；关闭成功后 `lastBusinessDate` 写入 Core 状态，后续任何动作携带更早日期都被拒绝。

## 4. 检索来源（A07/A09）

`src/sources.ts` 把"确认缺失"与"无法判定"分开：

| 输入 | verdict | mayReportMissing |
|---|---|---|
| 全量覆盖 + 可读 + 命中 | `CONFIRMED_PRESENT` | false |
| 全量覆盖 + 可读 + 未命中 | `CONFIRMED_ABSENT` | true |
| 部分覆盖 | `UNKNOWN` / `PARTIAL_COVERAGE` | false |
| 完全不可达 | `UNKNOWN` / `NO_SOURCE_REACHABLE` | false |
| 材料不可读 | `UNKNOWN` / `MATERIAL_UNREADABLE` | false |

`missingEvidenceClaim` 只在 `CONFIRMED_ABSENT` 时返回 `MISSING_EVIDENCE`，其余保持 `UNKNOWN`。

## 5. 已知限制

1. 阻断项、期限与检索记录都是**进程内对象**，JSON 重建会被 provenance 检查拒绝；没有跨进程存储。
2. `setBlockers` / `setDeadline` / `recordEscalation` 属受信管理面，没有独立的身份认证，不能暴露给普通请求者。
3. 期限来源是夹具里的合成字符串，不代表任何真实监管时限；本实现不猜测天数。
4. 若 SPEC 未声明 `blockers` / `deadline` 输入，闸门不做相关检查（例如 `examples/` 里的非临床 spec）。
5. `businessDate` 用正整数序数（如 `20261020`），不是带时区的真实日期类型。
6. 检索来源不连接任何真实系统，覆盖等级由调用方在合成场景中声明。
