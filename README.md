# GIL — Grounded Intent Language

**English** | [简体中文](README.zh-CN.md)

**Grounded Intent Language (GIL)** is a declarative specification language for collaboration between people and AI agents. It describes meaning, goals, constraints, actions, and acceptable behavior. Layered protocols support clarification, acceptance, shared artifacts, delegation, verification, and recovery.

**Project status:** a v0.1 design draft, a v0.2 candidate semantic contract, and experimental TypeScript/Node.js implementations. The specifications are not frozen. Implementations cover explicit subsets; this is not a production authorization platform.

## Why GIL?

An agent must not turn “I think this is what the user means” into “the user accepted it,” or into “I am authorized to execute it.” GIL separates those steps:

```text
User intent and source material
  → model proposes a candidate contract
  → check semantics, types, sources, and unresolved inputs
  → clarify and accept an exact version
  → check reviews, evidence, current grants, and budgets
  → host adapter executes
  → verify receipts, monitor, and recover
```

This is the target architecture. The current agent demo uses an offline model fixture, synthetic identities, and an in-memory adapter. It calls no live LLM or production business system.

GIL is not a general-purpose programming language. It does not replace an agent framework, database, or business execution engine. Text, structured objects, and a UI can serve as front ends; the canonical AST or contract artifact determines meaning. Hosts can use GIL through libraries, HTTP interfaces, or domain adapters.

## Core principles

1. **LLMs propose interpretations; they do not define language semantics.** Model confidence is neither acceptance nor authorization.
2. **Natural language carries no hidden normative effect.** Execution-relevant requirements must enter contracts, assumptions, or unresolved items.
3. **Goals, hard constraints, preferences, permissions, and evidence stay separate.** Expected benefits cannot compensate for a violated hard constraint.
4. **Unknown values, missing parameters, ambiguity, and disputes remain distinct.** Unknown is not satisfaction.
5. **Conclusions have scope and versions.** Evidence supports only specified targets, contexts, methods, assumptions, and coverage.
6. **Keep Core small.** Collaboration and authorization belong to outer layers and cannot directly rewrite Core truth.

## Quick start

New here? Start with the [hands-on guide](docs/getting-started.md) — three adoption paths, five tutorials, and an explicit pre-production checklist. Requires **Node.js >=24**. Node executes the TypeScript source using native type stripping. There are no third-party runtime dependencies; `npm install` is unnecessary. Native execution is not a `tsc` type check.

```sh
npm test
npm run demo:agent
npm run check:clinical
npm run parse:examples
```

The current test baseline is **304 passing tests** (run `npm test` for the live count). This validates tested implementations and synthetic fixtures, not production security, clinical approval, or full specification conformance.

### Other demos

| Command | Demonstrates |
|---|---|
| `npm run demo:clinical` | Synthetic Core state transitions and constraint checks |
| `npm run clarify:clinical` | Questions only; no automatic answers |
| `npm run demo:clarification` | Synthetic answers and exact acceptance |
| `npm run demo:delegation` | Simulated grants, approvals, budgets, and denials |
| `npm run demo:assurance` | Attestation binding, invalidation, challenges, and rotation |
| `npm run demo:governance` | Blockers, overdue escalation, and rejected backdating |
| `npm run demo:rl` | Seeded replay, termination states, and reward breakdown |
| `npm run demo:workspace` | Artifacts, sources, snapshots, and memory lifecycle |
| `npm run demo:evaluation` | Quantifiers, knowledge items, preference ranking, and action results |
| `npm run demo:decision-log` | Append-only decision log and L1 determinism rate |
| `npm run demo:bench` | Blind-annotation pipeline: pack generation, Fleiss' κ, bootstrap interval |

Inspect a canonical AST and its content hash:

```sh
node src/cli.ts ast docs/clinical-operations/monitoring-remediation/ontology.gil
```

`parse:examples` parses the hotel example as `spec + interpretation + delegate` and the robot example as `environment`. **Parsing does not imply successful type checking or execution.**

## Agent SDK and cross-language HTTP

Experimental profile: `gil-agent-contract-0.2-experimental`.

The SDK supports candidate validation, recipient clarification, exact acceptance, independent review, scoped grants, action-count budgets, bound receipts, idempotency, and timeout reconciliation. Mandatory claims and reviews are fixed by the host; a model cannot weaken them. HTTP references host-loaded `snapshotId` values rather than accepting client-supplied facts or roles.

The local server requires three distinct operator-supplied tokens, each at least 16 characters long:

```sh
export GIL_AGENT_TOKEN='<operator-provided-agent-token>'
export GIL_OWNER_TOKEN='<operator-provided-owner-token>'
export GIL_REVIEWER_TOKEN='<operator-provided-reviewer-token>'
npm run serve:agent
```

Replace the placeholders. Never commit tokens or give human tokens to an agent. The server binds only to `127.0.0.1`, defaults to port `8787`, and accepts a `PORT` override.

Set the same environment variables in another terminal, then run:

```sh
python3 examples/agent-client.py
```

The Python client uses only the standard library and exercises both clinical and growth fixtures. It automatically uses three identities for the demonstration; **this is not actual human approval**.

See the [Agent SDK and HTTP integration guide](docs/agent-integration.md). Any configured demo token can read contracts in that server. Restarting loses sessions, budgets, and idempotency records. Do not store real business data or execute production actions with it.

## Layered architecture

| Layer | Responsibility | Specification |
|---|---|---|
| Core | Types, grounding, goals, constraints, action contracts, and three-valued semantics | [01-GIL-Core.md](01-GIL-Core.md) |
| Exchange | Proposals, clarification, answers, exact acceptance, objections, and revisions | [02-GIL-Exchange.md](02-GIL-Exchange.md) |
| Workspace | Immutable artifacts, source locations, snapshots, views, and user-controlled memory | [03-GIL-Workspace.md](03-GIL-Workspace.md) |
| Delegation | Identities, grants, scopes, budgets, approvals, and revocation | [04-GIL-Delegation.md](04-GIL-Delegation.md) |
| Assurance | Methods, evidence, attestations, invalidation, challenges, and recovery | [05-GIL-Assurance.md](05-GIL-Assurance.md) |
| RL extension | Environments, stochastic transitions, termination, rewards, and constrained optimization | [06-GIL-RL.md](06-GIL-RL.md) |

Dependencies point from outer layers toward Core. Acceptance, permissions, long-term memory, and attestations do not determine Core's basic logical semantics.

Cross-layer references bind immutable content:

```text
ArtifactRef {
  id: ArtifactId
  version: Version
  hash: ContentHash
  mediaType: MediaType
}
```

Display names are not stable identities. Changing an accepted artifact creates a new content hash and requires explicit revision and invalidation handling. SHA-256 identifies content; it is not a signature, authentication, or proof of semantic equivalence.

## v0.2 candidate: clinical operations and game growth

The candidate specification separates **truth, knowledge state, observation coverage, freshness, review requirements, and authorization**. It adds measurement definitions, claim kinds, statistical uncertainty, source independence, and external-effect boundaries.

- [Cross-domain design rationale](docs/gil-v0.2-cross-domain-design.md)
- [Candidate semantic contract](docs/gil-v0.2-semantic-contract.md)
- [16 paired cases and 17 document fixtures](docs/gil-v0.2-dual-scenario-acceptance.md)

Type blocks describe candidate models, not implemented `.gil` syntax. The agent prototype implements only a structured-contract subset. The complete document cases have not run as a full automated conformance suite. These additions do not upgrade the v0.1 language or hash profile.

## Implemented capabilities and important limits

| Module | Experimental capability and boundary |
|---|---|
| Core | Parsing, ontology linking, finite static checking, Strong Kleene evaluation, and deterministic postcondition assignments. Parsing covers more than checking and execution. |
| Evaluation extensions | Host-supplied finite quantifier domains; Unknown for `open`; rejected ambiguous references; priority-based preferences; explicit action results. Some expressions remain unsupported by the checker. |
| Exchange | Exact source, answer, and acceptance bindings. Sessions are process-local capabilities; JSON cannot reconstruct their authority. |
| Delegation / Assurance | Simulated identities, grants, approvals, and unsigned attestations. Assurance is optional in the clinical gate; the legacy path does not verify evidence authenticity. |
| Governance | Source-bound deadlines, blocker ledgers, and separation of execution time from declared business dates. |
| Workspace | Artifacts, source references, snapshots, and memory correction/deletion/expiry. No persistence, real access control, or redacted views. |
| RL | Host primitives, explicit seeds, and finite replay. Success/failure/cutoff and task/shaping rewards stay separate. No POMDP solver or policy learning. |
| Agent SDK / HTTP | Two offline contract loops. Structural checks and declarations do not prove causal identification, source authenticity, or scientific independence. |

General unit arithmetic, Core compensation execution, Core retry semantics, actual verifier calls for declarative `verification`, live model compilation, production identity, signatures, durable audit, and distributed transactions remain unimplemented. Agent timeout reconciliation is not full Core retry semantics.

`Int` uses JavaScript safe integers. `Decimal` uses finite-precision Number values and is **unsuitable for exact financial or clinical calculations**. Finite-prefix observation cannot prove `always` over all future traces.

The clinical A01–A30 matrix records **29 implemented cases and 1 partial case**, only for that synthetic scenario. **Simulated CLOSED is not clinical authorization to close a finding. Passing tests does not mean all of GIL is complete.**

## Documentation and repository map

- [Hands-on guide](docs/getting-started.md) · [Core implementation profile](docs/core-profile.md) · [Interpretation and clarification](docs/interpretation-profile.md)
- [Delegation and audit](docs/delegation-profile.md) · [Attestations and recovery](docs/assurance-profile.md)
- [Deadlines, blockers, and time](docs/phase5-profile.md) · [RL](docs/rl-profile.md) · [Workspace](docs/workspace-profile.md)
- [Clinical scenario](docs/clinical-operations/monitoring-remediation/scenario.md) · [Acceptance cases](docs/clinical-operations/monitoring-remediation/acceptance.md) · [Coverage matrix](docs/clinical-operations/monitoring-remediation/coverage.md)
- [Terminology](docs/terminology.md) · [Decision log and alignment metrics](docs/decision-log.md) · [Blind annotation procedure](docs/annotation/README.md) · [Grammar draft](grammar/GIL-Core.ebnf)
- [Hotel example](examples/酒店预订.gil) · [Robot example](examples/机器人导航.gil)

`src/` contains implementations; `test/` contains Node built-in tests; `conformance/` contains synthetic fixtures; `docs/` contains profiles and candidate specifications; `examples/` contains language examples and a cross-language client. Detailed specifications are currently primarily in Chinese.

## Normative terms and non-goals

**MUST** denotes a requirement, **SHOULD** permits a justified exception, and **MAY** denotes an option. An ill-formed object has invalid syntax, types, or references. An unresolved object has open parameters or ambiguity. Unknown means truth cannot currently be determined; it is not False.

GIL does not aim for general-purpose Turing-complete computation, a mandatory universal ontology, automatic equivalence proofs for arbitrary specifications, resolution of high-impact ambiguity through model scores alone, or automatic legal/moral attribution from logs.

> Core defines acceptable behavior; Exchange forms shared understanding; Workspace fixes shared artifacts; Delegation bounds action; Assurance checks trust and recovery.
