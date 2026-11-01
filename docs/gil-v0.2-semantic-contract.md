# GIL v0.2 候选语义合同

日期：2026-11-01。状态：候选规范，尚未冻结；本文类型框不是已实现语法。

## 1. 兼容边界

保留 v0.1 的 Core 三值逻辑与分层依赖方向。不新增第四种真值，不改变现有 AST、哈希 profile、B1 时序绑定或 TypeScript 原型。新增合同必须使用独立 profile ID，不能借 v0.1 摘要暗示新语义已经受检。

本文中的必须/不得约束采用本候选 profile 的实现。现有临床原型不自动声明符合本文。

## 2. 六类正交状态

一次判定不得只有一个 `status` 或 `confidence` 字段。

| 维度 | 含义 | 不等于 |
|---|---|---|
| truth | True / False / Unknown | 批准、授权、临床结论 |
| knowledge | 断言、假设、开放项、歧义、争议 | 真值强弱等级 |
| observation | 范围、可读性、覆盖、水位 | 现实世界全部事实 |
| freshness | 相对某项时效要求的新鲜度 | 真值或业务不存在 |
| review | 某个动作前必须完成的审阅/裁决 | 第四种真值 |
| authorization | 当前主体是否有权作当前动作 | 有证据、已接受、可计算 |

Freshness 必须引用批准或选定的规则、评估时刻和来源水位。没有时效规则时返回未判定，不能默认 Fresh 或 Stale。连接失败是运行可用性；历史快照是否过期必须另算。

## 3. 带原因与依赖的求值报告

Core只以类型化输入、表达式、显式假设与语义profile求值。下列EvaluationReport是外层包装：输入依赖与真值来自Core，证据、审阅与权限元数据由外围协议附加。Accept、Pass、Grant和审阅完成均不得直接改写truth。ClaimContract的命题类别与测量引用可属Core可选profile；evidence是Assurance侧车引用，不是Core的权威输入。

```text
EvaluationReport {
  claim: ClaimRef
  truth: True | False | Unknown
  inputSnapshot: ArtifactRef
  semanticProfile: ProfileRef
  usedInputs: Set<ArtifactRef>
  relevantUnresolved: Set<UnresolvedRef>
  reviewRequirements: Set<ReviewRequirementRef>
  issues: Set<IssueRef>
  trace: ArtifactRef
}
```

- ill-formed 仍在求值前拒绝，不包装成 Unknown。
- 开放项须记录类型、来源与影响哪些主张/动作。无关开放项不阻塞全部工作。
- 普通缺值采用 Strong Kleene 真值表：`False AND Unknown` 可为 False，`True OR Unknown` 可为 True。
- 真值收敛不得删除与当前任务相关的争议或审阅义务。无关争议也不得自动阻塞当前动作；相关性必须显式给出。
- 真正多候选 AST 的歧义仍走 Exchange。可呈现候选间共同成立的命题，但不得把一个候选静默设为当前权威。
- 同一绑定有未裁决的矛盾来源时，当前绑定为Unknown，诊断INPUT_CONFLICT，附独立裁决义务；不是普通缺字段。其他确定输入仍可使组合命题按三值逻辑收敛。
- 裁决事件选定可引用输入版本；重新求值使用该版本，不通过“已批准”直接把Unknown改成True。相关性映射必须固定规则版本。

业务适配器可以投影为 ALLOW/BLOCK/NEEDS_INFORMATION/NEEDS_REVIEW。投影须有版本化规则，不能反推原始维度，也不能把名称 ALLOW 当执行授权。

## 4. 测量合同与可比性

```text
MeasurementContract {
  id: ArtifactRef
  quantity: ConceptRef
  population: PopulationDefinitionRef
  numerator: ExpressionRef
  denominator: ExpressionRef | NotApplicable
  inclusion: PredicateRef
  deduplication: IdentityRuleRef
  grain: GrainRef
  window: WindowDefinitionRef
  unit: UnitRef
  sourceMapping: ArtifactRef
}
Measurement {
  contract: ArtifactRef
  value: TypedValue
  inputSnapshot: ArtifactRef
  observedThrough: Instant | Unknown
}
```

适用人群、分子分母、去重、粒度、窗口锚点、端点包含规则、单位和状态映射进入合同身份。源快照进入测量身份，两者分开以支持同口径跨期比较。

- 比较前必须校验合同兼容及快照时间对齐。不要求跨期比较的两个快照哈希相同，但必须声明跨期关系。
- 不同合同不得仅因同名指标而相减、排序或汇总。
- 显式 Mapping/Alignment 工件可以使不同合同可比；转换保存原值、规则、损失和接受范围。
- 人口、去重或窗口不明时，操作不合法或存在未决前提；适配器必须声明是哪一种，不可随便返回一个数。
- GIL 不自动换算未知单位，不规定默认临床窗、最低样本量或游戏阈值。

## 5. 观察覆盖与缺失主张

```text
ObservationContract {
  snapshot: ArtifactRef
  universe: ScopeDefinitionRef
  interval: TimeInterval
  mapping: ArtifactRef
  readability: Available | Unavailable | Partial
  completeness: Complete | Partial | Unknown
  observedThrough: Instant | Unknown
  closureBasis: ArtifactRef | None
}
```

`ConfirmedAbsent(p)` 必须同时满足：目标谓词p零命中；目标范围Complete；搜索范围覆盖p的对象与时间；相关内容可读；映射有效；水位覆盖预期窗口；存在该范围的闭合依据；无未决冲突或适用性缺口。

只有有效、适用且未被冲突悬置的正向命中才报告Observed。映射无效、适用性未定或同绑定冲突使命中无法解释时，优先报告UnableToDetermine，保留原始命中与诊断/审阅义务，不先判Observed。可读范围完成检索、没有有效命中但不满足闭合条件时报告NotObserved（不意味着不存在）；检索未完成或不可读也报告UnableToDetermine。

否则只能报告 NotObserved 或 UnableToDetermine，不能声称现实中没发生。完整性只是相对明确范围的声明，不是绝对完整。来源更新时间、导入时间、事件发生时间、业务日期不能合并。

## 6. 主张类别、方法与不确定性

```text
ClaimContract {
  proposition: ExpressionRef
  kind: Descriptive | Associational | Causal | Predictive | Normative
  applicability: ScopeDefinitionRef
  measurementContracts: Set<ArtifactRef>
  assumptions: Set<AssumptionRef>
  evidence: Set<ArtifactRef>
}
Uncertainty {
  kind: ConfidenceInterval | PredictiveInterval | ScenarioEnvelope
      | SensitivityRange | ModelScore | ExplicitUnknown
  method: VerifierRef
  parameters: ArtifactRef
  assumptions: Set<AssumptionRef>
}
```

- 主张类别不是等级阶梯。不得从描述、相关、预测隐式升级为因果或规范授权。
- 因果主张必须引用识别设计、处理/结果、适用人群、假设及局限；有这些字段不等于设计正确，须由匹配方法验证。
- low/mid/high 情景包络不得标为统计置信区间。模拟分位数必须声明采样模型及相关性假设。
- 模型分数不能当统计区间，统计显著不能当业务价值，更不能当 Accept 或 Grant。
- 描述性分析通过，不证明因果主张通过。验证凭证必须绑定具体主张类别与方法。
- 定性访谈、代理指标、观测数据、实验数据不使用无条件的统一强弱序；是否支持主张由适用性与方法判断。

## 7. 来源谱系、独立性与影响传播

派生关系记录 `derivedFrom`、转换版本、输入 hash 和用途。共享来源根的文件不能仅因数量不同而计作独立支持。

独立性必须说明维度：来源、采样、随机分配、验证人或组织。不同审阅人不使同源数据独立；不同数据源不证明无共同偏差。

变更传播采用依赖关系：`source → measurement → claim → attestation → accepted plan/action request`。

- 变更生成新工件，旧结论和接受保留为历史。
- 相同语义合同下新增数据产生新测量，不一定撤销旧历史结论；必须重评其当前适用性。
- 当前批准/凭证是否失效由精确绑定与适用策略决定。仅受影响依赖进入待重评，不全局撤销。
- 签名证明出处/完整性，不证明内容为真、临床批准或因果成立。

## 8. 受限效果与恢复

```text
EffectRequest {
  action: ActionRef
  actor: ActorRef
  purpose: PurposeRef
  objects: ScopeDefinitionRef
  fields: Set<FieldRef>
  recipient: ActorRef | Internal
  destination: DestinationRef
  plan: ArtifactRef
  inputSnapshot: ArtifactRef
  requiredReviews: Set<ReviewRequirementRef>
}
```

读取、聚合、模型处理、导出、发布、写入、投放分别声明效果。读取许可、生成报告、接受分析方案不得自动授予传输、发布或预算调整。

行动门必须联合检查 Core 前置条件、当前 Grant、相关审阅义务、证据/批准有效性、用途/字段/接收方与预算。预检成功不保证最终提交时仍有权限。

业务成功必须由适配器回执与预定验证建立。任务卡 complete、工具 exit=0、文件存在不自动证明业务结果。超时后副作用未知时先核对或使用幂等键，不能盲目重试。

恢复必须声明待恢复对象和验证方式。断连可改用明确允许且标明水位的历史只读快照；不得冒充实时结果。没有降级授权则暂停该路径，但独立可用的规则路径无需被模型故障一起停止。

## 9. 符合性

本候选 profile 的符合性由[双场景验收](gil-v0.2-dual-scenario-acceptance.md)规定。每项实现声明必须列出支持范围及不支持诊断。只实现结构序列化、只运行合成案例或通过 v0.1 测试均不等于符合此 profile。
