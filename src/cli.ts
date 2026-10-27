import { readFileSync } from 'node:fs';
import { delegationDemo } from './delegation-demo.ts';
import { assuranceDemo } from './assurance-demo.ts';
import { governanceDemo } from './governance-demo.ts';
import { parse, parseInterpretation } from './parser.ts';
import { sourceArtifact } from './interpretation.ts';
import { startSession, answer, accept, resolvedHash } from './exchange.ts';
import { canonical, contentHash } from './canonical.ts';
import { link, check } from './checker.ts';
import { initialize, simulate, monitor } from './runtime.ts';
import { GilError } from './ast.ts';
import type { Spec, Ontology } from './ast.ts';
import type { State } from './runtime.ts';

const usage = 'Usage: node src/cli.ts ast FILE | check SPEC ONTOLOGY... | simulate SPEC ONTOLOGY FIXTURE.json | clarify INTERPRETATION FIXTURE.json [--demo-answer]';
function emit(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function load(path: string) { return parse(readFileSync(path, 'utf8')); }
function program(specPath: string, ontologyPaths: string[]) {
  const spec = load(specPath);
  if (spec.kind !== 'spec') throw new GilError('CLI_ERROR', 'Expected spec document');
  const ontologies = ontologyPaths.map(path => {
    const doc = load(path);
    if (doc.kind !== 'ontology') throw new GilError('CLI_ERROR', `Expected ontology: ${path}`);
    return doc;
  });
  const linked = link(spec as Spec, ontologies as Ontology[]);
  const diagnostics = check(linked);
  return { linked, diagnostics, hashes: { spec: contentHash(spec), ontologies: ontologies.map(doc => ({ name: doc.name, version: doc.version, hash: contentHash(doc) })) } };
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'demo-assurance' && args.length === 0) {
    const result = assuranceDemo() as { ok: boolean };
    emit(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'demo-governance' && args.length === 0) {
    const result = governanceDemo() as { ok: boolean };
    emit(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'demo-delegation' && args.length === 0) {
    const result = delegationDemo() as { ok: boolean };
    emit(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === 'ast' && args.length === 1) {
    const doc = load(args[0]);
    emit({ hash: contentHash(doc), ast: JSON.parse(canonical(doc)) });
  } else if (command === 'clarify' && (args.length === 2 || (args.length === 3 && args[2] === '--demo-answer'))) {
    const interpretation = parseInterpretation(readFileSync(args[0], 'utf8'));
    const fixture = JSON.parse(readFileSync(args[1], 'utf8'));
    const source = sourceArtifact(fixture.source.id, fixture.source.version, fixture.source.text);
    const context = { sources: [source], references: fixture.references, types: fixture.types };
    const agent = { actorId: 'AGENT-DEMO', kind: 'agent' as const, mayAnswer: false, mayAccept: false };
    let session = startSession(source, { id: fixture.candidateId, interpretation, plan: fixture.plan, affects: fixture.affects }, agent, context);
    const initialQuestions = session.questions;
    if (args[2] === '--demo-answer') {
      // This context is a synthetic fixture, never credentials inferred from input text.
      const human = { actorId: 'HUMAN-DEMO', kind: 'human' as const, mayAnswer: true, mayAccept: true };
      for (const question of initialQuestions) {
        if (!Object.hasOwn(fixture.answers ?? {}, question.target)) throw new GilError('CLI_ERROR', `Missing demo answer: ${question.target}`);
        session = answer(session, question.id, fixture.answers[question.target], human);
      }
      session = accept(session, { interpretationHash: session.interpretationHash, planHash: session.planHash, resolvedHash: resolvedHash(session) }, human);
    }
    emit({ ok: true, mode: 'synthetic-clarification', authorization: 'not-implemented', warning: 'Demo answers are synthetic, not actual user consent or clinical authorization', initialQuestions, session });
  } else if (command === 'check' && args.length >= 1) {
    const result = program(args[0], args.slice(1));
    emit({ ok: result.diagnostics.length === 0, profile: 'gil-core-clinical-0.1', ...result.hashes, diagnostics: result.diagnostics });
    if (result.diagnostics.length) process.exitCode = 1;
  } else if (command === 'simulate' && args.length === 3) {
    const result = program(args[0], [args[1]]);
    if (result.diagnostics.length) { emit({ ok: false, diagnostics: result.diagnostics }); process.exitCode = 1; }
    else {
      const fixture = JSON.parse(readFileSync(args[2], 'utf8'));
      if (!fixture || !Array.isArray(fixture.steps)) throw new GilError('CLI_ERROR', 'Fixture requires steps array');
      let state = initialize(result.linked, fixture.initialState);
      const trace: unknown[] = [];
      let ok = true;
      for (const step of fixture.steps) {
        if (!step || typeof step.action !== 'string') throw new GilError('CLI_ERROR', 'Each step requires action');
        const inputs: State = { ...fixture.inputs, ...step.inputs };
        const outcome = simulate(result.linked, state, inputs, step.action, step.params);
        trace.push({ action: step.action, ...outcome });
        if (!outcome.ok) { ok = false; break; }
        state = outcome.state;
      }
      emit({ ok, mode: 'core-simulation', authorization: 'not-implemented', warning: 'SYNTHETIC ONLY: contract success is not authorization, approval or clinical execution', ...result.hashes, state, trace, monitor: monitor(result.linked, state, fixture.inputs) });
      if (!ok) process.exitCode = 1;
    }
  } else throw new GilError('CLI_ERROR', usage);
} catch (error) {
  emit({ ok: false, code: error instanceof GilError ? error.code : 'IO_OR_INPUT_ERROR', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
