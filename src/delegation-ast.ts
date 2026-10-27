import type { Binding, Expr, Linked } from './ast.ts';
import type { State } from './runtime.ts';
import type { BlockerLedger } from './blockers.ts';
import type { EscalationAck, Obligation } from './deadlines.ts';
/**
 * `delegate` 声明的语法形式。
 *
 * 它是**请求的语法**，不是授权：这里出现的 scope、budget、autonomy 都不构成
 * 执行许可。真正的许可由 Grant 与 bound plan 在运行期判定。
 */
export interface DelegationDocument {
  kind: 'delegate';
  name: string;
  params: Binding[];
  to: string[];
  scope: string[];
  autonomy?: 'supervised' | 'bounded' | 'autonomous';
  budget?: { amount: number; currency: string };
  requires: Expr[];
  requiresEvidence: string[][];
  approval?: { role: string[]; when: Expr };
  onConflict?: string[];
  onUncertainty?: string[];
  revokeBy?: string[];
  expires?: { amount: number; unit: string; after: string[] };
}

export interface Scope { studyId: string; siteId: string; findingId: string }
export interface Identity { actorId: string; kind: 'human' | 'agent'; role: 'Coordinator' | 'CRA' | 'CTM' | 'Agent' | 'Service' }
export interface Grant { id: string; version: string; actorId: string; scope: Scope; actions: string[]; effect: 'allow' | 'deny'; autonomy: 'Suggest' | 'Execute'; validFrom: number; validUntil: number; budgetId: string; maxActions: number }
export interface BoundPlan { kind: 'bound-plan'; version: string; hash: string; interpretationHash: string; templateHash: string; resolvedHash: string; acceptanceEventId: string; sourceHash: string; scope: Scope; specHash: string; ontologyHashes: string[]; requirementHash: string; body: Record<string, unknown> }
export interface ActionRequest { actorId: string; action: string; params: State; inputs: State; expectedStateHash: string; expectedPlanHash: string }
export interface Approval { id: string; version: string; actorId: string; planHash: string; requestHash: string; validUntil: number }
export interface Decision { outcome: 'Allow' | 'Deny' | 'Escalate'; code: string; grantHash?: string; budgetId?: string }
export interface AuditEvent { id: string; parent: string | null; type: 'Attempt' | 'Denied' | 'Escalated' | 'Failed' | 'Succeeded' | 'Control' | 'Escalation'; actorId: string; time: number; payload: Record<string, unknown> }
export interface GateSnapshot { state: State; stateHash: string; planHash: string; scope: Scope; usage: Record<string, number>; events: AuditEvent[] }
export interface GateConfig {
  linked: Linked; state: State; plan: BoundPlan; identities: Identity[]; grants: Grant[]; now: () => number;
  submitterId?: string; reviewerId?: string; assurance?: AssuranceBinding;
  /** Phase5：阻断项台账能力。缺省即视为"阻断项未知"，复核与关闭一律拒绝。 */
  blockers?: BlockerLedger;
  /** Phase5：期限义务能力。缺省即视为"期限未定义"，关闭一律拒绝。 */
  deadline?: Obligation;
}
/** Phase4 凭证绑定：注册表能力 + 精确凭证与证据摘要。缺失即不启用凭证门。 */
export interface AssuranceBinding {
  registry: { readonly kind: 'assurance-registry' };
  attestationHash: string;
  evidenceHash: string;
  requirementHash: string;
}
