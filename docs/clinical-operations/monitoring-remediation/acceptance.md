# 验收案例：培训记录缺失／版本不匹配

版本：0.1。日期：2026-10-26。
这是未来实现的测试契约，不是已执行的测试报告。所有数据均为合成数据。

## 1. 夹具

| 名称 | 合成值与含义 |
|---|---|
| REQ-H1 | STUDY-DEMO / SITE-DEMO / FINDING-DEMO / STAFF-DEMO；适用 PROTOCOL-V3 |
| PLAN-H1 | 指向 FINDING-DEMO、REQ-H1 的整改计划；期限由接受时显式提供 |
| E-OLD | 作用域正确，但为 PROTOCOL-V2；明确版本不匹配 |
| E-H1 | 作用域正确；PROTOCOL-V3；requirementHash=REQ-H1；材料清单完整、可读；真实性及领域政策检查由审核流程建立 |
| E-H2 | 同一作用域的新证据内容；哈希与 E-H1 不同 |
| REVIEW-H1 | CRA-A 对 E-H1 / REQ-H1 的 HumanReview Pass；方法 HUMAN-REVIEW-V1；覆盖第 6 节证据清单；有效期尚未到达 |
| CLOSE-PLAN-H1 | 关闭计划，绑定 FINDING-DEMO / PLAN-H1 / E-H1 / REQ-H1 / REVIEW-H1 |
| APPROVAL-H1 | CTM-A 对 CLOSE-PLAN-H1 的精确批准 |
| REQ-H2 | 同一作用域的新要求快照，适用 PROTOCOL-V4；旧复核不能自动沿用 |
| COORD-A / CRA-A / CTM-A / AGENT-A | 不同的已认证主体；各自持有覆盖动作、研究、中心和发现的有效 Grant，除非测试覆盖此项 |

上述哈希是标签。真实实现必须检查内容摘要与工件版本；仅字符串相等不能证明真实性。

输入包：原始材料 + 不可变证据引用 + 适用要求引用 + 认证主体上下文 + 外层事件及有效性判定。上传者自行标注的 `authenticityEstablished=true` 不得进入可信检查输入。

默认起点：OPEN；currentEvidenceHash、reviewedEvidenceHash、reviewedRequirementHash、acceptedPlanHash 为空；REQ-H1 已绑定；无适用授权拒绝。

表中错误名称是本切片的建议诊断标签，不是已定义的 GIL 标准错误 schema。除特别说明外，阻断或拒绝不改变状态、不生成成功执行事件。

## 2. 正常路径与边界案例

| ID | 输入／动作 | 预期结果与验收断言 |
|---|---|---|
| A01 | CTM-A 接受 PLAN-H1；记录服务投影接受事实 | Exchange Accept 指向精确哈希；OPEN → IN_REMEDIATION；Agent 不是接受主体 |
| A02 | COORD-A 提交 E-H1 | IN_REMEDIATION → SUBMITTED；记录证据引用；复核绑定为空；不自动 REVIEWED |
| A03 | CRA-A 复核 E-H1；所有检查已建立并生成 REVIEW-H1 | SUBMITTED → REVIEWED；reviewedEvidenceHash=E-H1，reviewedRequirementHash=REQ-H1；不是 CLOSED |
| A04 | CTM-A 批准 CLOSE-PLAN-H1 并执行 closeFinding | REVIEWED → CLOSED；所有第 7 节条件同时成立；生成完整关闭审计链 |
| A05 | COORD-A 提交 E-OLD，CRA 检查版本 | 上传可进入 SUBMITTED；evidenceReady=False；不允许 recordReviewPass；CRA 可退回 CHANGES_REQUIRED，诊断 VERSION_MISMATCH |
| A06 | 经完整清单核对，确认培训记录不存在 | 报告 MISSING_EVIDENCE，属于已确认缺失；不伪装为 Unknown；可接受补齐计划但不能复核通过或关闭 |
| A07 | 查询不完整，不能确定是否存在记录 | 报告 Unknown 及来源／覆盖缺口；不能声称 MISSING_EVIDENCE；阻断相关复核和关闭 |
| A08 | E-H1 的人员或研究、中心、发现不匹配 | scopeMatches=False；提交即拒绝，状态不变；诊断 SCOPE_MISMATCH；不得复核通过；不能通过改显示名绕过 |
| A09 | 材料不可读、清单不完整或真实性无法建立 | 按已知 False／信息不足区分；evidenceReady 不为 True；退回或升级；上传不等于有效 |
| A10 | CRA 退回后 COORD-A 提交 E-H2 | CHANGES_REQUIRED → SUBMITTED；旧复核清空；必须复核 E-H2，旧凭证不能支持关闭 |
| A11 | REVIEWED 时 COORD-A 替换为 E-H2 | REVIEWED → SUBMITTED；旧 REVIEW-H1 不再适用；不能维持 REVIEWED |
| A12 | REVIEW-H1 已过期或其依赖证据失效 | evaluatedReviewHash=activeReviewHash=REVIEW-H1，reviewStillValid=False；关闭拒绝不改变状态；独立失效投影动作 → SUBMITTED，清空有效复核绑定，保留历史；必须经新复核才可关闭 |
| A13 | REVIEWED 时适用要求更新为 REQ-H2 | 有权接受后 updateRequirement：→ OPEN；计划和复核绑定清空；不得按 PROTOCOL-V3 关闭 |
| A14 | CLOSED 后出现有效证据挑战 | 先阻断受影响动作；CTM-A 有权重开后 → OPEN；历史关闭事件仍保留，不删除或改写 |
| A15 | 只有任务完成标记，没有材料或复核 | 保留真实业务状态；不进入 REVIEWED 或 CLOSED；诊断 MISSING_EVIDENCE / MISSING_REVIEW |
| A16 | 期限已到，材料尚未补齐 | 生成逾期升级，记录期限来源；不伪造复核结论；是否阻断关闭由明确处置政策决定 |
| A17 | 期限未定义或适用方案版本未确认 | 产生 open 未决项；不猜日期或选“最新”；仅阻断依赖该项的操作 |
| A18 | 其他政策阻断项未解除 | 阻断项台账存在 OPEN 条目；不得关闭；显示阻断目标及解除权限 |

## 3. 权限、解释和并发案例

| ID | 输入／动作 | 预期结果与验收断言 |
|---|---|---|
| A19 | AGENT-A 请求关闭，即使 Core 条件全部为 True | Delegation Deny；业务状态不变；记录真实拒绝原因；不产生 CTM 批准或成功关闭事件 |
| A20 | CRA-A 直接执行关闭 | Deny；CRA Pass 不产生 CTM 权限 |
| A21 | COORD-A 冒充 CRA；或同一主体提交又审核 | 可信身份／人员隔离检查拒绝；参数角色文字不起授权作用；不能生成有效 REVIEW-H1 |
| A22 | Grant 缺失、过期、撤销、跨中心或存在显式 deny | 拒绝对应动作；deny 优先；其他合法动作不必全部暂停 |
| A23 | AGENT-A 有有限分派 Grant，额度为两次，第三次创建任务 | 前两次模拟分派在范围内允许；第三次 Deny 或按策略升级；不得拆任务或换代理绕过累计预算 |
| A24 | 用户只说“把培训的问题处理掉” | 产生明确发现与操作范围的候选解释；Clarify 显示哪些动作受阻；不默认为授权关闭 |
| A25 | Agent 推断用户同意了某计划 | 可保存为候选／推断，但不得形成用户 Answer 或 Accept；不触发 recordAcceptedPlan |
| A26 | 有 CTM 批准，但证据由 E-H1 换为 E-H2 | APPROVAL-H1 不适用于新计划；需要新复核和新精确批准；不能继承旧批准 |
| A27 | 关闭预检后、写入前，证据或要求被修改 | 比较预期哈希与当前哈希失败；无 CLOSED 写入；诊断 VERSION_CONFLICT；重新评估并批准 |
| A28 | CRA 审核结果 Unknown 或仅存在验证计划 | 不生成 Pass；不进入 REVIEWED；Assurance Unknown 不当作 Pass |
| A29 | 新材料上传者勾选“真实性已确认” | 仅为上传者断言；不升级为受信复核结果；不能凭该勾选关闭 |
| A30 | CTM 把关闭日期回填为旧日期以隐藏迟延 | 拒绝改写不可变历史；真实执行时间与声明的业务日期分开；关联迟延仍可见 |

## 4. Core 与外层的映射契约

这些断言是场景级协议，不是新的 Core 语法。

| Core 动作／输入 | 外层必须建立的前提 |
|---|---|
| recordAcceptedPlan(planHash) | Exchange 中有权主体的真实 Accept；绑定当前发现、要求及计划；记录服务有相应 Grant |
| submitEvidence / stagedEvidence | 提交时加载新的不可变证据快照；核对协调员身份、Grant、作用域及内容摘要。复核与关闭时加载 currentEvidenceHash 对应的当前快照；原始断言与复核结论分离 |
| C.evidenceReady | 领域纯谓词；字段只能来自有来源、范围明确的检查输入；不可由文件存在自动推出 |
| evaluatedReviewHash / reviewStillValid | Assurance 对精确凭证按证据、要求、规约、审核范围、版本、期限及依赖判定；复核时 evaluatedReviewHash 是新凭证，写入 activeReviewHash；关闭及失效判定时必须等于 activeReviewHash；不同凭证不可混用 |
| blockers（阻断项台账） | 内容寻址台账逐项记录未决、争议和升级记录；`openCount` 由台账派生，空缺不等于已解除；解除必须由条目的 `resolutionAuthority` 完成 |
| recordReviewPass | CRA 主体认证、有效 Grant、人员隔离及绑定当前材料的 HumanReview Pass |
| closeFinding | CTM 主体认证、Grant、人员隔离、精确批准和执行前版本重查 |
| invalidateReview | 受限记录服务 Grant；确认针对 activeReviewHash 的失效事实；不删除历史；Unknown 仅阻断，不伪造 False |
| updateRequirement / reopenFinding | CTM 作用域授权及接受／挑战依据；失效传播与新事件，保留旧历史 |

Core 示例有意不直接表达 Grant、Approval 或 Attestation；因此只运行 Core 不能通过本场景全部验收。状态也只缓存版本绑定，不代替证据存储。

`submitEvidence` 无论从哪个允许状态调用，都加载待提交的新工件。只有复核与关闭检查才必须从 currentEvidenceHash 指向的工件加载 `stagedEvidence`，不能把任意调用者请求体作为“当前证据”。若哈希匹配但实际内容摘要不匹配，先作为工件错误拒绝，不进入正常逻辑求值。

`phase` 暂用 Text 和硬约束表达有限状态；这不是已实现的枚举类型。空 Text 是本示例的“尚未绑定哈希”哨兵，不是 Unknown 或 Option 的通用替代。真实部分输入采用 Core 的部分求值及带原因的诊断，不输入字符串 "Unknown"，也不将未知 Bool 填成 false。

## 5. 正常路径的审计链

事件名是场景描述标签，不是新增 EBNF：

1. FindingRecorded：原始发现和来源工件固定版本。
2. Propose：PLAN-H1，包含缺口、责任人、要求和期限。
3. Accept：CTM-A 接受 PLAN-H1 的精确哈希。
4. TaskDispatched：若 Agent 分派，记录 Grant、对象和实际预算消耗。
5. EvidenceSubmitted：COORD-A 提交 E-H1，绑定 REQ-H1。
6. ReviewRecorded：CRA-A、HumanReview、REVIEW-H1、覆盖范围、假设及有效期。
7. ClosureApproved：CTM-A 批准 CLOSE-PLAN-H1。
8. FindingClosed：执行前版本检查通过；引用上述工件、批准和执行 Grant。

每项保留认证主体、时间、父事件、工件版本及真实结果。并发事件按父引用保存，不按最后到达静默覆盖。若发生失败，记录尝试和拒绝；不能生成相同的成功链。

## 6. 交付验收与未来实现验收

本轮文档验收：
- 场景、角色、状态转移和关闭规则一致。
- 每个案例都有输入、预期结果和禁止的状态变化。
- `.gil` 只描述 Core，外层映射明确。
- 不编造监管时限、签署要求或真实系统能力。
- 明确当前尚无机器测试结果。

未来实现验收：
- 两个 `.gil` 文件独立解析、引用解析和类型检查通过。
- A01–A30 可由测试夹具重放，实际结果符合上述断言。
- 合法路径完整关闭；权限不足、未知、失效和并发路径不产生错误关闭。
- 可以从关闭事件追溯全部证据、要求、接受、批准及 Grant 版本。
- 更换证据或要求后，旧复核与批准不能误用。
