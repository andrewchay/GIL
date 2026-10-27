# A01–A30 覆盖矩阵

版本：2026-10-27（Phase5 更新）。
本矩阵记录每个验收案例在当前实现中的真实覆盖程度。**未标"已实现"的条目不得当作已通过。**

图例：
- ✅ 已实现并有自动测试
- 🟡 部分实现（仅部分断言可执行）
- ⬜ 未实现（仅文档约定）

| 案例 | 状态 | 说明 |
|---|---|---|
| A01 接受计划 → IN_REMEDIATION | ✅ | Exchange 精确接受 + `recordAcceptedPlan` |
| A02 提交证据 → SUBMITTED | ✅ | 作用域/要求校验在提交入口 |
| A03 CRA 复核 → REVIEWED | ✅ | 需有效 Pass 凭证，且非提交者 |
| A04 CTM 批准并关闭 | ✅ | 精确 requestHash 批准 + 凭证有效 |
| A05 版本不匹配证据 | ✅ | `MATERIAL_HASH_MISMATCH`，复核被拒 |
| A06 确认缺失 | ✅ | `MISSING_EVIDENCE`，与 Unknown 分离 |
| A07 查询不完整 → Unknown | ✅ | `sources.ts` 覆盖等级工件；PARTIAL/NONE → `UNKNOWN`，`mayReportMissing=false` |
| A08 作用域不匹配 | ✅ | 提交即拒绝 |
| A09 材料不可读/不完整 | ✅ | `MATERIAL_UNREADABLE`、`coverageGaps` 显式列缺口 |
| A10 退回后重提 | ✅ | 旧复核绑定清空 |
| A11 复核后替换证据 | ✅ | 凭证失效 + 精确批准失效 |
| A12 凭证过期/失效降级 | ✅ | 降级 Unknown，独立失效投影 |
| A13 要求版本更新 | ✅ | `updateRequirement` 端到端：→OPEN、清空绑定、旧凭证 `CONTEXT_MISMATCH`、无法采纳 |
| A14 关闭后挑战 → 重开 | ✅ | 挑战失活、CTM 重开、历史保留 |
| A15 仅任务完成无材料 | ✅ | 不进入 REVIEWED/CLOSED |
| A16 逾期 | ✅ | `Obligation` 强制来源；逾期产生 `Escalation` 事件；`BLOCK-CLOSURE` 阻断关闭，`ACCEPT-LATE` 可解；`ESCALATE-ONLY` 不阻断 |
| A17 期限/版本未定 | ✅ | 无来源即无法创建义务；`DEADLINE_REQUIRED` 显式拒绝 |
| A18 其他阻断项未解除 | ✅ | `BlockerLedger` 派生 `openCount`；`BLOCKERS_OPEN` + `blockerReport` 显示目标与解除权限 |
| A19 Agent 请求关闭 | ✅ | Deny，无成功事件、不扣预算 |
| A20 CRA 直接关闭 | ✅ | 角色拒绝 |
| A21 冒充/自审 | ✅ | 注册表角色 + 人员隔离 |
| A22 Grant 缺失/过期/撤销/跨中心/deny | ✅ | 默认拒绝，deny 优先 |
| A23 Agent 预算 | 🟡 | 预算累计与共享账本有测试；分派动作仍只是模拟计数，未绑定真实任务创建 |
| A24 模糊请求 | ✅ | 候选解释与阻断范围 |
| A25 Agent 推断冒充同意 | ✅ | 无法形成 Answer/Accept |
| A26 证据替换后旧批准 | ✅ | 请求摘要含证据、凭证、台账与期限 |
| A27 写入前版本冲突 | ✅ | 提交前二次校验版本与时钟 |
| A28 Unknown 不算 Pass | ✅ | 降级语义 |
| A29 上传者自报真实性 | ✅ | 断言不进摘要、不读入判定 |
| A30 回填日期 | ✅ | 真实执行时间由闸门注入、拒绝调用者提供；业务日期单调，`BACKDATED_BUSINESS_DATE` |

## 统计

- ✅ 已实现：29
- 🟡 部分实现：1（A23 分派仍为模拟计数）
- ⬜ 未实现：0

## 剩余工作

1. A23：把预算消耗绑定到真实任务创建，而不是模拟计数。
2. 未实现的生产件：真实身份认证、签名与时间戳服务、证据失效依赖图、RecoveryPlan、Monitor、跨进程事务与持久化。
3. 检索来源（A07/A09）目前是合成本地工件，未接任何真实 EDC/eTMF 接口。

## 声明

所有 ✅ 均为**合成数据、过程内模拟**下的实现与测试。它们不能证明真实临床系统正确性、法规合规性或证据真实性。A16 的期限来自测试夹具的显式来源，不是任何真实监管时限。
