# GIL-Delegation：参与者、角色、权限、预算、自主性、升级与撤销

**版本：** v0.1 设计草案  
**依赖：** GIL-Core 动作与作用域；Exchange 接受事件；Workspace 工件与上下文

## 1. 范围

Delegation 定义谁可以代表谁，在何种边界内执行哪些动作。动作在物理或语义上可执行，不意味着当前主体有权执行。

Delegation 只能进一步限制 Core 允许的行为，不能放宽 Core 的动作契约或硬约束。

## 2. 参与者与角色

```text
Actor = Human | AIAgent | Service | Organization
```

```text
Role =
  Principal
  | Agent
  | Verifier
  | Approver
  | AffectedParty
  | AccountableParty
```

身份与角色分离。一个主体可以在不同协作或不同动作中承担不同角色。

`AccountableParty` 是显式记录的责任关系，不由系统仅根据日志自动推断法律或道德责任。

## 3. 权限与委托

### 3.1 基本授权

```text
Grant {
  id: GrantId
  grantor: ActorRef
  subject: ActorRef
  actions: ActionPattern
  scope: Scope
  autonomy: Suggest | Execute | Redelegate
  budget: Budget?
  conditions: Set<Condition>
  escalation: EscalationPolicy
  expiry: Expiry
  revocation: RevocationPolicy
  basedOn: Set<EventId | ArtifactRef>
}
```

### 3.2 自主性级别

- **Suggest：**只能提出动作或计划。
- **Execute：**可以在条件满足时执行，但不能继续委派。
- **Redelegate：**可以把更窄的权限委托给其他主体。

自主性级别不替代具体动作范围和资源限制。

## 4. 授权判定

默认拒绝。一次动作只有在以下条件全部满足时才可进入执行：

1. 动作在 Core 中形式正确且前置条件成立；
2. 主体具有覆盖该动作、对象和上下文的授权；
3. 没有适用的显式拒绝；
4. 预算、时间、速率和资源条件成立；
5. 所需接受、证据和批准仍然有效；
6. 没有未解决的阻断性歧义或升级事件；
7. 授权未被撤销或过期。

冲突规则：

- `deny` 优先于 `allow`；
- 更具体的限制可以收窄较宽授权；
- 较宽授权不能覆盖明确拒绝；
- 再委托必须显式允许，并且只能收窄；
- 委托者不能授予自己原本没有的权限。

## 5. 预算

预算可以包括：

```text
Budget {
  money: MoneyBudget?
  actions: ActionCount?
  duration: Duration?
  compute: ComputeBudget?
  data: DataBudget?
  externalCalls: CallBudget?
}
```

预算消耗必须记录在实际动作上。估计成本只能用于预检，不能代替实际结算。

预算不足时不得通过拆分动作、更换代理或再委托来绕过限制。

## 6. 条件化委托示例

```text
delegate reschedule(booking) to assistant
  within TravelScope
  autonomy bounded
  budget 300.USD
  requires resolved(cancellationPolicy)
  requiresEvidence priceCheck
  approval Customer when irreversible(action)
  onConflict ask Customer
  onUncertainty escalate
  revokeBy Customer
  expires 24.hours after acceptance;
```

`bounded` 是具体语法糖，必须展开为 `Execute` 加动作范围、条件和预算，不是第四种模糊自主级别。

## 7. 升级

```text
EscalationTrigger =
  UnresolvedInterpretation
  | MissingEvidence
  | ConflictingGoals
  | BudgetExceeded
  | AuthorityExceeded
  | MonitorViolation
  | UnexpectedEffect
  | PolicyConflict
```

升级策略必须说明：

- 暂停整个协作还是仅暂停相关动作；
- 通知谁；
- 需要提供哪些上下文；
- 谁可以解除暂停；
- 解除后是否需要重新接受或验证。

模型自报置信度不能单独作为充分授权依据。

## 8. 批准

```text
Approval {
  actionPlanHash: ContentHash
  approver: ActorRef
  grantedAt: Instant
  scope: ApprovalScope
  conditions: Set<Condition>
}
```

批准必须指向具体计划或差异。计划发生实质变化后，不得自动复用旧批准。

高风险或不可逆动作可以要求独立批准者，但不能假定每次人工点击都代表有效理解。

## 9. 撤销与进行中的动作

撤销后立即阻止新的授权动作。对于已经开始的动作，必须选择：

- 安全完成当前原子步骤后停止；
- 立即停止；
- 恢复先前状态；
- 执行补偿；
- 升级给有权限的主体。

恢复方式必须服从 Core 动作契约。可补偿动作不得被描述为完全可逆。

## 10. 责任与审计

每次执行至少记录：

- 使用的主要身份与角色；
- 所依据的授权版本；
- 所依据的规约和接受版本；
- 实际动作、对象与效果；
- 预算消耗；
- 升级、批准和撤销事件。

日志支持责任追踪，但不自动决定过错、法律责任或组织责任。

## 11. 最小一致实现

首版至少支持：

- 默认拒绝和显式允许；
- 动作、对象与上下文范围；
- 建议与执行两种自主级别；
- 预算和到期时间；
- 条件升级；
- 精确计划批准；
- 授权撤销与动作审计。


## v0.2 候选修订关联

补充用途、字段、接收方和外部效果边界；读取、分析、生成文件不自动授权传输、发布、预算调整。

参见[候选语义合同](docs/gil-v0.2-semantic-contract.md)与[双场景验收](docs/gil-v0.2-dual-scenario-acceptance.md)。这些扩展尚未冻结或实现，不改变本文v0.1原型的符合性声明。
