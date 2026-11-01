import { AgentService, FixtureModel } from './agent-sdk.ts';
import type { Draft, ActionAdapter, HostConfig, Receipt } from './agent-sdk.ts';
import type { Snapshot as AgentSnapshot } from './agent-semantics.ts';

export function scenario(domain: 'clinical' | 'growth') {
  const draft: Draft = {
    domain, goal: domain === 'clinical' ? 'Prepare a visit-gap review' : 'Prepare a source-bound growth report',
    action: 'prepareReport', purpose: 'internal-review', fields: ['summary'], recipient: null, destination: 'internal',
    claim: { kind: 'Descriptive', fact: domain === 'clinical' ? 'recordAbsent' : 'analysisReady', causalDesign: null,
      uncertainty: 'None', uncertaintyMethod: 'None', requiresIndependentSources: false }, requiredReviews: ['publication-review'] };
  const snapshot: AgentSnapshot = { facts: { analysisReady: true }, conflicts: [], lineageRoots: ['synthetic-source-v1'],
    observation: { readability: 'Available', completeness: 'Complete', searched: true, matches: 0,
      mappingValid: true, applicable: true, windowMature: true, scopeCovered: true, watermarkCovered: true, closureBasis: 'fixture-closure-v1' } };
  return { draft, snapshot };
}
export function demoHost(adapter?: ActionAdapter): HostConfig {
  const offline: ActionAdapter = adapter ?? {
    async execute(r) { return { requestHash: r.requestHash, status: 'Succeeded', output: { summary: 'Synthetic internal report', destination: r.destination } }; },
    verify(r, receipt: Receipt) { return receipt.output.destination === r.destination && typeof receipt.output.summary === 'string'; },
  };
  return { principals: [
    { id: 'agent', kind: 'agent', canAccept: false, reviews: [] },
    { id: 'owner', kind: 'human', canAccept: true, reviews: [] },
    { id: 'reviewer', kind: 'human', canAccept: false, reviews: ['publication-review'] },
  ], grants: ['clinical','growth'].map(domain => ({ id: `grant-${domain}`, actor: 'agent', domain, action: 'prepareReport',
    purpose: 'internal-review', fields: ['summary'], recipient: 'internal-reviewers', destination: 'internal', maxActions: 3, validUntil: 2000000000000 })),
    actionReviews: { prepareReport: ['publication-review'] },
    actionClaims: { 'clinical:prepareReport': scenario('clinical').draft.claim, 'growth:prepareReport': scenario('growth').draft.claim },
    adapters: { prepareReport: offline }, now: Date.now };
}
export async function agentDemo() {
  const outputs = [];
  for (const domain of ['clinical','growth'] as const) {
    const service = new AgentService(demoHost()), fixture = scenario(domain);
    let view = await service.propose('agent', 'Prepare the requested review, not an external action.', fixture.snapshot, domain, new FixtureModel(fixture.draft));
    const questions = view.questions;
    view = service.answer('owner', String(view.id), String(view.binding), 'internal-reviewers');
    view = service.accept('owner', String(view.id), String(view.binding));
    view = service.approve('reviewer', String(view.id), String(view.binding), 'publication-review');
    const execution = await service.execute('agent', String(view.id), String(view.binding), `${domain}-request-1`);
    const replay = await service.execute('agent', String(view.id), String(view.binding), `${domain}-request-1`);
    outputs.push({ domain, questions, view, execution, replay });
  }
  return { ok: outputs.every(o => o.execution.status === 'Succeeded'), mode: 'synthetic-agent-contract-loop', productionAuthorization: false,
    warning: 'SYNTHETIC ONLY: fixture model, simulated identities/grants and in-memory adapter; no clinical execution, publishing or real model calls', scenarios: outputs };
}
