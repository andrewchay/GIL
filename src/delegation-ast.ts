import type { Linked } from './ast.ts';
import type { State } from './runtime.ts';
export interface Scope { studyId: string; siteId: string; findingId: string }
export interface Identity { actorId: string; kind: 'human' | 'agent'; role: 'Coordinator' | 'CRA' | 'CTM' | 'Agent' | 'Service' }
export interface Grant { id: string; version: string; actorId: string; scope: Scope; actions: string[]; effect: 'allow' | 'deny'; autonomy: 'Suggest' | 'Execute'; validFrom: number; validUntil: number; budgetId: string; maxActions: number }
export interface BoundPlan { kind: 'bound-plan'; version: string; hash: string; interpretationHash: string; templateHash: string; resolvedHash: string; acceptanceEventId: string; sourceHash: string; scope: Scope; specHash: string; ontologyHashes: string[]; requirementHash: string; body: Record<string, unknown> }
export interface ActionRequest { actorId: string; action: string; params: State; inputs: State; expectedStateHash: string; expectedPlanHash: string }
export interface Approval { id: string; version: string; actorId: string; planHash: string; requestHash: string; validUntil: number }
export interface Decision { outcome: 'Allow' | 'Deny' | 'Escalate'; code: string; grantHash?: string; budgetId?: string }
export interface AuditEvent { id: string; parent: string | null; type: 'Attempt' | 'Denied' | 'Escalated' | 'Failed' | 'Succeeded' | 'Control'; actorId: string; time: number; payload: Record<string, unknown> }
export interface GateSnapshot { state: State; stateHash: string; planHash: string; scope: Scope; usage: Record<string, number>; events: AuditEvent[] }
export interface GateConfig { linked: Linked; state: State; plan: BoundPlan; identities: Identity[]; grants: Grant[]; now: () => number; submitterId?: string; reviewerId?: string }
