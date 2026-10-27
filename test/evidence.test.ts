import test from 'node:test';
import assert from 'node:assert/strict';
import { GilError } from '../src/ast.ts';
import type { EvidenceSnapshot, MaterialRef, RequirementSnapshot } from '../src/assurance-ast.ts';
import { createEvidence, createRequirement, evidenceHash, evidenceReady, inconsistentMaterials,
  materialDiagnostics, missingMaterials, requirementHash, scopeMatches, validateEvidence, validateRequirement }
  from '../src/evidence.ts';

const H = (char: string) => `sha256:${char.repeat(64)}`;
const TRAINING = H('a');
const DELEGATION = H('b');
const MONITORING = H('c');
const error = (code: string) => (err: unknown) => err instanceof GilError && err.code === code;

function requirementInput(over: Record<string, unknown> = {}) {
  return { studyId: 'STUDY-1', siteId: 'SITE-1', findingId: 'FINDING-1', staffId: 'STAFF-1', protocolVersion: 'P3',
    materials: [{ id: 'training-log', contentHash: TRAINING }, { id: 'delegation-record', contentHash: DELEGATION }],
    ...over };
}
function evidenceInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { studyId: 'STUDY-1', siteId: 'SITE-1', findingId: 'FINDING-1', staffId: 'STAFF-1', protocolVersion: 'P3',
    materials: [{ id: 'training-log', contentHash: TRAINING }, { id: 'delegation-record', contentHash: DELEGATION }],
    ...over };
}
const requirement = (over: Record<string, unknown> = {}) => createRequirement(requirementInput(over) as never);
const evidenceOf = (req: RequirementSnapshot, over: Record<string, unknown> = {}, options = {}) =>
  createEvidence(req, evidenceInput(over) as never, options);
/** Plain copy: same bytes, no process provenance. */
const plainCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('requirement snapshots are content addressed over kind, version, scope, protocol and ordered materials', () => {
  const req = requirement();
  assert.equal(req.kind, 'requirement');
  assert.match(req.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(req.contentHash, requirementHash(req));
  assert.deepEqual(req.materials.map(material => material.id), ['training-log', 'delegation-record']);
  // Field insertion order must not matter; material order must.
  const reordered = createRequirement({ protocolVersion: 'P3', materials: requirementInput().materials,
    staffId: 'STAFF-1', findingId: 'FINDING-1', siteId: 'SITE-1', studyId: 'STUDY-1' });
  assert.equal(reordered.contentHash, req.contentHash);
  const swapped = requirement({ materials: [requirementInput().materials[1], requirementInput().materials[0]] });
  assert.notEqual(swapped.contentHash, req.contentHash);
  for (const change of [{ protocolVersion: 'P4' }, { staffId: 'STAFF-2' }, { siteId: 'SITE-2' }, { studyId: 'STUDY-2' }]) {
    assert.notEqual(requirement(change).contentHash, req.contentHash);
  }
  // A digest never collides with an evidence digest because kind/version are bound.
  assert.notEqual(req.contentHash, evidenceHash(evidenceOf(req)));
  validateRequirement(req);
});

test('evidence binds the exact requirement hash, scope and protocol version', () => {
  const req = requirement();
  const evidence = evidenceOf(req);
  assert.equal(evidence.kind, 'evidence');
  assert.equal(evidence.requirementHash, req.contentHash);
  assert.equal(evidence.protocolVersion, 'P3');
  assert.deepEqual(evidence.materials.map(material => material.id), ['training-log', 'delegation-record']);
  assert.match(evidenceHash(evidence), /^sha256:[0-9a-f]{64}$/);
  assert.equal(evidenceHash(evidence), evidenceHash(evidenceOf(req)));
  validateEvidence(evidence);
  validateEvidence(evidence, req);
  assert.deepEqual(evidenceReady(req, evidence), { ready: true, reasons: [] });
  // Material order is retained but does not change coverage.
  const swapped = evidenceOf(req, { materials: [evidenceInput().materials[1], evidenceInput().materials[0]] });
  assert.notEqual(evidenceHash(swapped), evidenceHash(evidence));
  assert.deepEqual(evidenceReady(req, swapped), { ready: true, reasons: [] });
});

test('scope and protocol mismatches are rejected at creation and on validation', () => {
  const req = requirement();
  for (const change of [{ findingId: 'FINDING-9' }, { siteId: 'SITE-9' }, { studyId: 'STUDY-9' }, { staffId: 'STAFF-9' }]) {
    assert.throws(() => evidenceOf(req, change), error('EVIDENCE_SCOPE_MISMATCH'));
  }
  assert.throws(() => evidenceOf(req, { protocolVersion: 'P2' }), error('PROTOCOL_VERSION_MISMATCH'));
  const evidence = evidenceOf(req);
  // Any other requirement version fails the hash binding first, before protocol/scope are consulted.
  const otherProtocol = requirement({ protocolVersion: 'P4' });
  assert.throws(() => validateEvidence(evidence, otherProtocol), error('REQUIREMENT_HASH_MISMATCH'));
  const otherStaff = requirement({ staffId: 'STAFF-2' });
  assert.throws(() => validateEvidence(evidence, otherStaff), error('REQUIREMENT_HASH_MISMATCH'));
  assert.equal(scopeMatches(req, evidence), true);
  assert.equal(scopeMatches({ ...req, staffId: 'STAFF-2' } as never, evidence), false);
  assert.equal(scopeMatches({ ...req, findingId: 'X' } as never, evidence), false);
  // Delegation scopes carry no staffId, so they never match a requirement scope.
  assert.equal(scopeMatches({ studyId: 'STUDY-1', siteId: 'SITE-1', findingId: 'FINDING-1' } as never, evidence), false);
  assert.equal(scopeMatches(null as never, evidence), false);
  // Findings are per scope: the same material content in another finding is a different requirement.
  const otherFinding = requirement({ findingId: 'FINDING-2' });
  assert.throws(() => createEvidence(otherFinding, evidenceInput() as never), error('EVIDENCE_SCOPE_MISMATCH'));
});

test('material version mismatch and undeclared ids are rejected instead of being silently accepted', () => {
  const req = requirement();
  const stale = evidenceInput().materials as MaterialRef[];
  assert.throws(() => evidenceOf(req, { materials: [{ id: 'training-log', contentHash: H('d') }, stale[1]] }),
    error('MATERIAL_HASH_MISMATCH'));
  assert.throws(() => evidenceOf(req, { materials: [...stale, { id: 'monitoring-log', contentHash: MONITORING }] }),
    error('UNDECLARED_MATERIAL'));
  assert.throws(() => evidenceOf(req, { materials: [{ id: 'training-log', contentHash: 'sha256:abc' }] }),
    error('INVALID_MATERIAL'));
  assert.throws(() => evidenceOf(req, { materials: [{ id: 'training-log' }] }), error('INVALID_EVIDENCE'));
});

test('missing materials are rejected by default and only explicitly incomplete when allowed', () => {
  const req = requirement();
  const partial = [evidenceInput().materials[0]];
  assert.throws(() => evidenceOf(req, { materials: partial }), error('MISSING_EVIDENCE'));
  const incomplete = evidenceOf(req, { materials: partial }, { allowMissingMaterials: true });
  validateEvidence(incomplete, req);
  const readiness = evidenceReady(req, incomplete);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.reasons, ['MISSING_EVIDENCE:delegation-record']);
  assert.deepEqual(missingMaterials(req, incomplete), [{ code: 'MISSING_EVIDENCE', materialId: 'delegation-record',
    message: 'No evidence material for delegation-record' }]);
  assert.deepEqual(inconsistentMaterials(req, incomplete), []);
  assert.throws(() => evidenceOf(req, { materials: partial }, { allowMissingMaterials: 'yes' as never }),
    error('INVALID_EVIDENCE'));
  assert.throws(() => evidenceOf(req, { materials: partial }, { allowIncomplete: true } as never),
    error('INVALID_EVIDENCE'));
});

test('submitter claims never affect readiness: asserted authenticity cannot cover a missing material', () => {
  const req = requirement();
  const partial = [evidenceInput().materials[0]];
  const claimed = evidenceOf(req, { materials: partial,
    submitterClaims: { authenticityEstablished: true, complete: true } }, { allowMissingMaterials: true });
  const readiness = evidenceReady(req, claimed);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.reasons, ['MISSING_EVIDENCE:delegation-record']);
  // Claims are excluded from the digest, so they cannot even shift the identity of the content.
  const withoutClaims = evidenceOf(req, { materials: partial }, { allowMissingMaterials: true });
  assert.equal(evidenceHash(claimed), evidenceHash(withoutClaims));
  // A false claim does not block a complete submission either: claims are simply not input.
  const honest = evidenceOf(req, { submitterClaims: { authenticityEstablished: false, complete: false } });
  assert.deepEqual(evidenceReady(req, honest), { ready: true, reasons: [] });
  assert.equal(evidenceHash(honest), evidenceHash(evidenceOf(req)));
  for (const claims of [{ authenticityEstablished: 'yes' }, { complete: 1 }, { verified: true }]) {
    assert.throws(() => evidenceOf(req, { submitterClaims: claims }), error('INVALID_EVIDENCE'));
  }
});

test('readiness never reads submitterClaims: a getter on that key is not invoked', () => {
  const req = requirement();
  const evidence = evidenceOf(req, { submitterClaims: { authenticityEstablished: true } });
  let traps = 0;
  const trap = (): never => { traps++; throw new Error('must not execute'); };
  const withGetter = { ...evidence } as Record<string, unknown>;
  Object.defineProperty(withGetter, 'submitterClaims', { enumerable: true, configurable: true, get: trap });
  const readiness = evidenceReady(req, withGetter as unknown as EvidenceSnapshot);
  assert.equal(readiness.ready, true);
  assert.equal(traps, 0);
  // The same object is still not trusted evidence.
  assert.throws(() => validateEvidence(withGetter as unknown as EvidenceSnapshot), error('UNTRUSTED_EVIDENCE'));
  assert.equal(traps, 0);
});

test('JSON-rebuilt snapshots are not trusted although their checksums are stable', () => {
  const req = requirement();
  const evidence = evidenceOf(req);
  assert.equal(evidenceHash(plainCopy(evidence)), evidenceHash(evidence));
  assert.equal(requirementHash(plainCopy(req)), req.contentHash);
  for (const copy of [plainCopy(evidence), Object.create(evidence) as EvidenceSnapshot,
    { ...evidence } as EvidenceSnapshot]) {
    assert.throws(() => validateEvidence(copy), error('UNTRUSTED_EVIDENCE'));
    assert.throws(() => validateEvidence(copy, req), error('UNTRUSTED_EVIDENCE'));
  }
  for (const copy of [plainCopy(req), Object.create(req) as RequirementSnapshot]) {
    assert.throws(() => validateRequirement(copy), error('UNTRUSTED_REQUIREMENT'));
  }
  // A rebuilt requirement cannot be used to create evidence either, even with matching content.
  assert.throws(() => createEvidence(plainCopy(req), evidenceInput() as never), error('UNTRUSTED_REQUIREMENT'));
  // A self-consistent forged requirement with a recomputed hash still has no provenance.
  const forged = plainCopy(req) as RequirementSnapshot & { contentHash: string };
  forged.contentHash = requirementHash(forged);
  assert.throws(() => validateRequirement(forged), error('UNTRUSTED_REQUIREMENT'));
});

test('snapshots are frozen and decoupled from caller-owned inputs', () => {
  const input = requirementInput();
  const req = createRequirement(input as never);
  input.materials[0].contentHash = H('e');
  input.materials.length = 0;
  input.protocolVersion = 'P9';
  assert.equal(req.protocolVersion, 'P3');
  assert.deepEqual(req.materials, [{ id: 'training-log', contentHash: TRAINING }, { id: 'delegation-record', contentHash: DELEGATION }]);
  const evidenceInputs = evidenceInput();
  const evidence = createEvidence(req, evidenceInputs as never);
  evidenceInputs.materials.length = 0;
  assert.equal(evidence.materials.length, 2);
  // Frozen: in-place tampering throws instead of silently invalidating a live snapshot.
  assert.throws(() => { req.contentHash = H('f'); }, TypeError);
  assert.throws(() => { req.materials.push({ id: 'x', contentHash: H('f') }); }, TypeError);
  assert.throws(() => { evidence.materials[0].contentHash = H('f'); }, TypeError);
  assert.throws(() => { evidence.requirementHash = H('f'); }, TypeError);
  assert.throws(() => { (evidence as { submitterClaims?: unknown }).submitterClaims = { complete: true }; }, TypeError);
  assert.equal(requirementHash(req), req.contentHash);
  assert.deepEqual(evidenceReady(req, evidence), { ready: true, reasons: [] });
  // Other findings or protocol versions are simply different requirements.
  assert.notEqual(requirement({ protocolVersion: 'P4' }).contentHash, req.contentHash);
});

test('duplicate material ids are rejected in requirements and evidence', () => {
  assert.throws(() => requirement({ materials: [{ id: 'training-log', contentHash: TRAINING },
    { id: 'training-log', contentHash: DELEGATION }] }), error('DUPLICATE_MATERIAL_ID'));
  const req = requirement();
  assert.throws(() => evidenceOf(req, { materials: [{ id: 'training-log', contentHash: TRAINING },
    { id: 'training-log', contentHash: TRAINING }, { id: 'delegation-record', contentHash: DELEGATION }] }),
    error('DUPLICATE_MATERIAL_ID'));
});

test('dangerous keys, getters and proxies are rejected before reflection', () => {
  const req = requirement();
  let traps = 0;
  const trap = (): never => { traps++; throw new Error('must not execute'); };
  const wrap = <T extends object>(value: T): T =>
    new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  // Dangerous own keys, including a JSON-parsed __proto__ own property.
  const dangerous = JSON.parse(`{"studyId":"STUDY-1","siteId":"SITE-1","findingId":"FINDING-1","staffId":"STAFF-1",
    "protocolVersion":"P3","materials":[{"id":"training-log","contentHash":"${TRAINING}"}],"__proto__":{"x":1}}`);
  assert.throws(() => createRequirement(dangerous), error('INVALID_REQUIREMENT'));
  const constructorKey = requirementInput();
  Object.defineProperty(constructorKey, 'constructor', { enumerable: true, value: 'x' });
  assert.throws(() => createRequirement(constructorKey as never), error('INVALID_REQUIREMENT'));
  const prototypeKey = requirementInput() as Record<string, unknown>;
  Object.defineProperty(prototypeKey, 'prototype', { enumerable: true, value: {} });
  assert.throws(() => createRequirement(prototypeKey as never), error('INVALID_REQUIREMENT'));
  // Accessors, extra material fields, class instances and prototypes from elsewhere.
  const getterInput = requirementInput();
  Object.defineProperty(getterInput, 'protocolVersion', { enumerable: true, get: trap });
  assert.throws(() => createRequirement(getterInput as never), error('INVALID_REQUIREMENT'));
  assert.throws(() => requirement({ materials: [{ id: 'training-log', contentHash: TRAINING, note: 'x' }] }),
    error('INVALID_REQUIREMENT'));
  class Fake { studyId = 'STUDY-1'; siteId = 'SITE-1'; findingId = 'FINDING-1'; staffId = 'STAFF-1';
    protocolVersion = 'P3'; materials = [{ id: 'training-log', contentHash: TRAINING }]; }
  assert.throws(() => createRequirement(new Fake() as never), error('INVALID_REQUIREMENT'));
  // Proxies never reach a trap: input and snapshot boundaries are guarded by identity first.
  assert.throws(() => createRequirement(wrap(requirementInput()) as never), error('INVALID_REQUIREMENT'));
  const evidence = evidenceOf(req);
  assert.throws(() => createEvidence(wrap(req), evidenceInput() as never), error('UNTRUSTED_REQUIREMENT'));
  assert.throws(() => createEvidence(req, wrap(evidenceInput()) as never), error('INVALID_EVIDENCE'));
  assert.throws(() => validateEvidence(wrap(evidence)), error('UNTRUSTED_EVIDENCE'));
  assert.throws(() => evidenceHash(wrap(evidence)), error('INVALID_EVIDENCE'));
  const revoked = Proxy.revocable(evidence, {}); revoked.revoke();
  assert.throws(() => validateEvidence(revoked.proxy as EvidenceSnapshot), error('UNTRUSTED_EVIDENCE'));
  assert.equal(traps, 0);
});

test('diagnostics keep confirmed absence, version mismatch and unassessable coverage distinct', () => {
  const req = requirement();
  const evidence = evidenceOf(req);
  assert.deepEqual(materialDiagnostics(req, evidence), []);
  assert.deepEqual(missingMaterials(req, evidence), []);
  assert.deepEqual(inconsistentMaterials(req, evidence), []);
  // Confirmed absence: the id simply is not submitted.
  const absent = { ...evidence, materials: [evidence.materials[1]] } as EvidenceSnapshot;
  assert.deepEqual(missingMaterials(req, absent).map(diagnostic => diagnostic.code), ['MISSING_EVIDENCE']);
  assert.deepEqual(inconsistentMaterials(req, absent), []);
  // Version mismatch: same id, different content hash.
  const stale = { ...evidence, materials: [{ id: 'training-log', contentHash: H('d') }, evidence.materials[1]] } as EvidenceSnapshot;
  assert.deepEqual(inconsistentMaterials(req, stale).map(diagnostic => `${diagnostic.code}:${diagnostic.materialId}`),
    ['MATERIAL_HASH_MISMATCH:training-log']);
  assert.deepEqual(missingMaterials(req, stale), []);
  // Unassessable: evidence binds another requirement version, so coverage cannot be attributed at all.
  const foreign = { ...evidence, requirementHash: requirement({ protocolVersion: 'P5' }).contentHash } as EvidenceSnapshot;
  assert.deepEqual(inconsistentMaterials(req, foreign).map(diagnostic => diagnostic.code), ['UNABLE_TO_EVALUATE']);
  assert.deepEqual(missingMaterials(req, foreign).map(diagnostic => diagnostic.code), ['UNABLE_TO_EVALUATE']);
  // Unassessable: material not declared by the requirement.
  const extra = { ...evidence, materials: [...evidence.materials, { id: 'monitoring-log', contentHash: MONITORING }] } as EvidenceSnapshot;
  assert.deepEqual(inconsistentMaterials(req, extra).map(diagnostic => `${diagnostic.code}:${diagnostic.materialId}`),
    ['UNABLE_TO_EVALUATE:monitoring-log']);
  // Malformed input is unassessable, not "missing".
  assert.deepEqual(missingMaterials(req, null as never), [{ code: 'UNABLE_TO_EVALUATE', materialId: '*',
    message: 'Requirement or evidence is not assessable plain data' }]);
  assert.equal(evidenceReady(req, stale).reasons.includes('MATERIAL_HASH_MISMATCH:training-log'), true);
  assert.equal(evidenceReady(req, stale).ready, false);
});

test('readiness is a pure derivation over coverage only, separate from the provenance gate', () => {
  const req = requirement();
  const evidence = evidenceOf(req);
  // Same bytes, no provenance: the derivation still describes coverage, validation still refuses it.
  assert.deepEqual(evidenceReady(plainCopy(req), plainCopy(evidence)), { ready: true, reasons: [] });
  assert.throws(() => validateEvidence(plainCopy(evidence), plainCopy(req)), error('UNTRUSTED_EVIDENCE'));
  const tampered = plainCopy(evidence) as EvidenceSnapshot;
  (tampered.materials as MaterialRef[])[0] = { id: 'training-log', contentHash: H('d') };
  assert.deepEqual(evidenceReady(plainCopy(req), tampered).reasons, ['MATERIAL_HASH_MISMATCH:training-log']);
  // A requirement whose contentHash no longer matches its own content is never ready.
  const inconsistentRequirement = { ...plainCopy(req), protocolVersion: 'P6' } as RequirementSnapshot;
  const reasons = evidenceReady(inconsistentRequirement, evidence).reasons;
  assert.equal(reasons.includes('REQUIREMENT_TAMPERED:contentHash does not match content'), true);
  assert.equal(reasons.includes('MATERIAL_HASH_MISMATCH:training-log'), false);
});
