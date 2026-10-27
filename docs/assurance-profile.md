# Phase4：验证凭证、失效与恢复

状态：实验性 `gil-assurance-attestation-0.1` / `gil-assurance-evidence-0.1`。
全部为过程内合成实现：无签名、无证书、无生产身份、无持久化。

## 1. 已实现能力

| 能力 | 实现 |
|---|---|
| 不可变要求快照 | `src/evidence.ts` 内容寻址，绑定作用域、方案版本与材料清单 |
| 不可变证据快照 | 材料覆盖与哈希比对，提交方断言不进摘要 |
| 凭证签发 | `src/assurance.ts` 受信注册表签发 Pass/Fail/Unknown |
| 失效投影 | 撤销、过期、规约/目标/上下文/证据变化、挑战 |
| 授权门集成 | `src/delegation.ts` 复核与关闭必须由凭证支撑 |
| 挑战与重开 | 挑战使凭证失活；CTM 授权重开，历史保留 |

## 2. 证据与要求

要求和证据都是内容寻址对象，摘要绑定 `kind/version/scope/protocolVersion/materials`。材料保持给出顺序，换序即换摘要；不做隐式版本归一化。

- `MISSING_EVIDENCE`：清单核对后确认缺失。
- `MATERIAL_HASH_MISMATCH`：同 id 不同内容 = 版本不匹配。
- `UNABLE_TO_EVALUATE`：证据绑定了另一要求版本或来源不可读。

三者不合并。确认缺失不等于 Unknown，Unknown 也不等于确认缺失。

**提交方断言被隔离**：`submitterClaims.authenticityEstablished` / `complete` 不进入摘要，`evidenceReady` 不读取。上传者勾选无法让缺失材料的证据通过。

缺项策略为 fail-closed：默认拒绝签发不完整证据；显式 `allowMissingMaterials` 才能取到永久 `ready=false` 的快照。

## 3. 凭证

凭证绑定：规约摘要、目标摘要（默认等于证据摘要）、上下文摘要、内部绑定的证据与要求摘要、审核者、方法及方法版本、覆盖范围、假设、签发时间与有效期。

- 只有受信注册表能签发，签发者必须是 CRA 且不等于提交者（`PERSON_SEPARATION`）。
- 注册表是过程内能力对象，JSON 无法重建；伪造凭证在 `evaluate` 前即被拒绝。
- 覆盖范围非空且不重复。

`Pass` 只表示指定覆盖范围内的审核结论。它不证明培训真实发生、材料为真，也不构成法规合规认证。

## 4. 失效规则

`evaluate` 累积原因，任一成立即 `active=false` 且对外结果强制为 `Unknown`（原始结论仍可查，但不作为通过依据）：

| 原因 | 条件 |
|---|---|
| `REVOKED` | 注册表已撤销该凭证 |
| `EXPIRED` | `now >= validUntil` |
| `SPEC_CHANGED` | 规约摘要变化 |
| `TARGET_MISMATCH` | 目标摘要不匹配当前证据 |
| `CONTEXT_MISMATCH` | 上下文（要求）摘要变化 |
| `EVIDENCE_CHANGED` | 内部绑定的证据摘要与当前不同 |
| `CHALLENGED` | 存在针对该凭证的挑战 |

挑战后凭证永久失活，凭证与挑战历史都保留；恢复只能靠新的 Exact 凭证或授权重开，不能改写旧结论。

## 5. 授权门集成

配置了凭证绑定时，`recordReviewPass` 与 `closeFinding` 必须满足：

1. 凭证来源为本进程签发。
2. `evaluate` 结果为 `Pass` 且 `active`。
3. 凭证绑定的证据摘要等于当前提交的证据摘要。
4. 凭证绑定的要求摘要等于当前计划的要求摘要。

同时 Core 的 `reviewStillValid` 输入被凭证结果覆盖：调用者传入的 Bool 不再构成依据。成功事件的审计记录同时写入凭证、证据、要求摘要与 `overrodeSelfReport` 标记。

请求摘要包含凭证三元组，因此换凭证或换证据会使旧批准失效；关闭仍需 CTM 的精确批准。

## 6. 必须写明的限制

1. **`assurance` 是可选配置。** 不配置时门退回 Phase3 行为，仅检查 Core 契约与角色/Grant，不校验证据真实性。这是为既有回归保留的 legacy 路径，**不是** Phase4 合规路径。生产适配器必须强制配置。
2. **信任边界只是持有 Gate 的进程内代码。** `setAssurance` 属受信管理面，不能暴露给普通请求者；它本身已校验凭证有效、Pass、证据一致，但仍不代替真实身份认证。
3. **凭证门只覆盖复核与关闭。** `invalidateReview`、`reopenFinding`、`updateRequirement` 由 Grant 与角色约束，不受凭证约束——它们是控制动作，不宣称证据合格。
4. **`reviewStillValid` 被无条件覆盖为凭证结果。** 若凭证仍有效却被 `invalidateReview` 清空状态，再次复核仍会通过；出现该情形说明凭证与状态不一致，需由适配器保证二者同步。
5. **注册表不参与内容摘要**，审计只存三个摘要而非注册表身份与 `evaluate` 的 reasons；事后无法从事件还原判定细节。
6. **证据不完全时绑定会被拒绝**（`EVIDENCE_CHANGED` / `ATTESTATION_INVALID`），轮换凭证必须在证据一致时进行，否则会短暂锁死相关动作。
7. **每次执行调用两轮 `evaluate`**（决策 + 提交前重查），成本需在真实适配器中评估。
8. 未实现：签名与时间戳服务、证据失效依赖图、`RecoveryPlan`、`Monitor`、跨进程事务与持久化。

## 7. 运行

```sh
npm run demo:assurance
npm test
```

演示依次展示：合法路径关闭、凭证绑定错误被拒、自报 Bool 无效、CRA 自审被拒、撤销后降级 Unknown、关闭后挑战并使凭证失活、CTM 重开保留历史、换证据使旧凭证失效、重新签发后可合法轮换。

输出标记 `synthetic-assurance-simulation` 与 `process-local-unsigned-attestations`。
