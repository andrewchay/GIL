import { readFileSync } from 'node:fs';
import { parse, parseInterpretation } from './parser.ts';
import { link, check } from './checker.ts';
import { initialize } from './runtime.ts';
import { sourceArtifact } from './interpretation.ts';
import { startSession, answer, accept, resolvedHash } from './exchange.ts';
import { bindPlan } from './plans.ts';
import { createGate, snapshot, execute, requestHash, approve } from './delegation.ts';
import { GilError } from './ast.ts';
import type { ActionRequest, Grant } from './delegation-ast.ts';

export function delegationDemo(): unknown {
  const base = 'docs/clinical-operations/monitoring-remediation/';
  const spec = parse(readFileSync(base + 'workflow.gil', 'utf8'));
  const ontology = parse(readFileSync(base + 'ontology.gil', 'utf8'));
  if (spec.kind !== 'spec' || ontology.kind !== 'ontology') throw new GilError('DEMO_ERROR', 'Invalid demo documents');
  const linked = link(spec, [ontology]);
  const diagnostics = check(linked);
  if (diagnostics.length) throw new GilError('DEMO_ERROR', JSON.stringify(diagnostics));
  const core = JSON.parse(readFileSync('conformance/clinical-core.json', 'utf8'));
  const intent = JSON.parse(readFileSync('conformance/clinical-interpretation.json', 'utf8'));
  const controls = JSON.parse(readFileSync('conformance/clinical-delegation.json', 'utf8'));
  const source = sourceArtifact(intent.source.id, intent.source.version, intent.source.text);
  const interpretation = parseInterpretation(readFileSync(base + 'interpretation.gil', 'utf8'));
  // Explicit synthetic broader plan: accepting it is not granting its steps.
  const template = { ...intent.plan, operation: '${intendedOperation}', workflow: 'training-remediation', execution: 'requires-separate-grants' };
  let session = startSession(source, { id: intent.candidateId, interpretation, plan: template, affects: intent.affects }, { actorId: 'AGENT-DEMO', kind: 'agent', mayAnswer: false, mayAccept: false }, { sources: [source], references: intent.references, types: intent.types });
  const human = { actorId: 'CTM-DEMO', kind: 'human' as const, mayAnswer: true, mayAccept: true };
  for (const question of session.questions) session = answer(session, question.id, question.target === 'intendedOperation' ? 'Clinical.RequestClosure' : intent.answers[question.target], human);
  session = accept(session, { interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolvedHash(session) }, human);
  const initialState = initialize(linked, core.initialState);
  const plan = bindPlan(session, linked, controls.scope, core.initialState.requirement.contentHash);
  const grants: Grant[] = controls.grantTemplates.map((item: {id:string;actorId:string;actions:string[]}) => ({ ...item, version: '1', scope: controls.scope, effect: 'allow', autonomy: 'Execute', validFrom: controls.now - 1000, validUntil: controls.now + 86400000, budgetId: item.id, maxActions: item.id === 'G-AGENT' ? 2 : 10 }));
  const gate = createGate({ linked, state: initialState, plan, identities: controls.identities, grants, now: () => controls.now });
  const outcomes: unknown[] = [];
  let ok = true;
  for (const step of controls.steps) {
    const current = snapshot(gate);
    const req: ActionRequest = { actorId: step.actorId, action: step.action, params: step.action === 'recordAcceptedPlan' ? { planHash: plan.hash } : {}, inputs: core.inputs, expectedStateHash: current.stateHash, expectedPlanHash: current.planHash };
    if (step.approve) approve(gate, { id: 'APPROVAL-DEMO', version: '1', actorId: 'CTM-DEMO', planHash: current.planHash, requestHash: requestHash(gate, req), validUntil: controls.now + 10000 });
    const outcome = execute(gate, req);
    outcomes.push({ actorId: step.actorId, action: step.action, expectedDenied: !!step.expectDenied, ...outcome });
    if (step.expectDenied ? outcome.ok : !outcome.ok) { ok = false; break; }
  }
  return { ok, mode: 'synthetic-authorized-simulation', authorization: 'simulated-registry-and-grants', assurance: 'synthetic-inputs-only', warning: 'NOT real authentication, clinical approval, verified evidence or clinical execution', plan, outcomes, snapshot: snapshot(gate) };
}
