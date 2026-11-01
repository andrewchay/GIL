# GIL-Assurance：独立验证、证据、运行监控、挑战、恢复与责任追踪

**版本：** v0.1 设计草案  
**依赖：** GIL-Core、Exchange、Workspace 与 Delegation 的引用模型

## 1. 范围

Assurance 定义为什么相信某个结论或实现、如何持续检查，以及如何挑战、恢复和追踪责任。

它不把“有证据”简化为“无条件为真”。所有验证结论都受目标、环境、假设、覆盖范围和验证方法限制。

## 2. 声明与验证计划

Core 中的目标、约束、动作契约和精化关系都可以成为可验证声明。

```text
VerificationPlan {
  id: PlanId
  claim: ClaimRef
  target: ArtifactRef
  method: VerifierRef
  coverage: CoverageSpec
  assumptions: Set<AssumptionRef>
  requiredBefore: ActionPattern?
  independence: IndependenceRequirement?
}
```

验证计划只表示打算如何检查，不表示检查已通过。

## 3. 验证方法

```text
VerificationMethod =
  Proof
  | ModelCheck
  | TypeCheck
  | DeterministicTest
  | StatisticalEvaluation
  | Simulation
  | RuntimeObservation
  | SourceInspection
  | HumanReview
```

不同方法产生不同强度的证据。统计评估不得被表述为普遍证明；模型检查不得自动被表述为部署实现检查。

## 4. 验证凭证

```text
Attestation {
  id: AttestationId
  plan: PlanId
  specHash: ContentHash
  targetHash: ContentHash
  contextHash: ContentHash
  verifier: VerifierRef
  verifierVersion: Version
  method: VerificationMethod
  coverage: CoverageSpec
  assumptions: Set<AssumptionRef>
  result: Pass | Fail | Unknown
  evidence: Set<ArtifactRef>
  counterexamples: Set<ArtifactRef>
  timestamp: Instant
  validUntil: Instant?
}
```

规则：

1. `Pass` 只对指定哈希、环境、假设和覆盖范围有效。
2. `Unknown` 不得当作 `Pass`。
3. 验证器版本是证据的一部分。
4. 失败应尽可能提供可重放反例。
5. 人工审查必须记录审查者和审查范围，不能只记录“已审核”。
6. 证据缺失与验证失败可以不同，但都不得支持无条件通过。

## 5. 独立性

```text
IndependenceRequirement =
  SeparateVerifierFromProposer
  | SeparateVerifierFromExecutor
  | IndependentHumanApproval
  | IndependentOrganization
```

不是所有检查都必须独立。类型检查、单元测试、统计评估和独立审计应在证据模型中保持可区分。

提出答案的系统不得成为自己唯一的高风险裁判。

## 6. 证据失效与依赖

以下变化必须使证据失效或进入待重估状态：

- 规约变化；
- 实现或模型变化；
- 验证器或验证参数变化；
- 上下文和环境变化；
- 假设被撤销；
- 输入分布超出覆盖范围；
- 依赖证据失效。

证据系统应维护依赖图，避免只更新顶层哈希而继续使用已经失效的底层结论。

## 7. 运行监控

```text
Monitor {
  id: MonitorId
  claim: ClaimRef
  target: ArtifactRef
  mode: Continuous | Periodic | OnAction
  scope: MonitoringScope
  onViolation: Halt | Escalate | Compensate | Record
}
```

监控事件至少记录观察时间、目标版本、观察数据、判定和响应。无法观察关键条件时，应报告监控盲区，而不是报告正常。

## 8. 挑战与争议

```text
Challenge {
  id: ChallengeId
  challenger: ActorRef
  target: ClaimRef | AttestationRef | ActionEventRef
  reason: Reason
  evidence: Set<ArtifactRef>
  requestedRemedy: Remedy
  status: Open | Accepted | Rejected | Resolved
}
```

挑战是否阻止执行由适用策略决定。策略可以按风险、证据独立性和动作可逆性设置不同响应。

处理挑战时必须保留原结论和挑战记录，不得通过覆盖结论消除争议历史。

## 9. 恢复

恢复方式：

- **Restore：**真正恢复到定义的先前状态；
- **Compensate：**执行补偿，但不声称完全恢复；
- **Escalate：**交由有权限的主体处理；
- **Halt：**停止后续动作；
- **Record：**仅记录，仅适用于策略明确允许的情况。

```text
RecoveryPlan {
  trigger: TriggerRef
  snapshot: SnapshotRef?
  action: Restore | Compensate | Escalate | Halt
  compensatingAction: ActionRef?
  authorization: GrantRef
  verification: VerificationPlan?
}
```

恢复本身也是动作，必须具有权限、前置条件和验证要求。

## 10. 责任追踪

审计记录应能够回答：

- 谁提出了什么；
- 谁接受了哪个版本；
- 谁授予了什么权限；
- 哪个实现执行了什么动作；
- 使用了哪些证据；
- 哪些警告、异议和升级被忽略或处理；
- 后续采取了什么恢复措施。

责任追踪不等于自动归责。系统不得仅凭“最后一个点击者”推断完整责任。

## 11. 最小一致实现

首版至少支持：

- 验证计划与目标绑定凭证；
- `Pass`、`Fail`、`Unknown` 三态结果；
- 覆盖范围、假设和验证器版本；
- 证据失效；
- 运行违规记录；
- 挑战对象与恢复动作；
- 端到端审计引用。


## v0.2 候选修订关联

补充主张类别、统计不确定性类型、独立性维度及依赖影响传播；情景包络不得冒充置信区间。

参见[候选语义合同](docs/gil-v0.2-semantic-contract.md)与[双场景验收](docs/gil-v0.2-dual-scenario-acceptance.md)。这些扩展尚未冻结或实现，不改变本文v0.1原型的符合性声明。
