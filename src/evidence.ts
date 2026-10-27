// Phase4 证据快照层：仅为合成、过程内数据，不构成真实认证、签名或材料真实性证明。
// 关键分离：submission 的 submitterClaims 只是提交方断言，绝不进入准备度推导或摘要绑定。
import { types as nodeTypes } from 'node:util';
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import type { EvidenceSnapshot, MaterialRef, RequirementSnapshot } from './assurance-ast.ts';

/** Synthetic in-process profile tag for requirement/evidence digests. Not a signature or credential. */
export const EVIDENCE_VERSION = 'gil-assurance-evidence-0.1';

/** 三态诊断码：确认缺失 / 版本不匹配 / 无法评估。三者不得合并。 */
export type MaterialDiagnosticCode = 'MISSING_EVIDENCE' | 'MATERIAL_HASH_MISMATCH' | 'UNABLE_TO_EVALUATE';
export interface MaterialDiagnostic { code: MaterialDiagnosticCode; materialId: string; message: string }
export interface EvidenceReadiness { ready: boolean; reasons: string[] }
export interface EvidenceScope { studyId: string; siteId: string; findingId: string; staffId: string }
export interface RequirementInput extends EvidenceScope { protocolVersion: string; materials: MaterialRef[] }
export interface EvidenceInput extends EvidenceScope {
  protocolVersion: string;
  materials: MaterialRef[];
  /** Untrusted submitter assertions. Never read by evidenceReady or bound into evidenceHash. */
  submitterClaims?: { authenticityEstablished?: boolean; complete?: boolean };
}
export interface EvidenceOptions { allowMissingMaterials?: boolean }

type RequirementContent = Omit<RequirementSnapshot, 'contentHash'>;
type EvidenceContent = Omit<EvidenceSnapshot, 'submitterClaims'>;

const MATERIAL_KEYS = ['id', 'contentHash'];
const REQUIREMENT_KEYS = ['kind', 'version', 'contentHash', 'studyId', 'siteId', 'findingId', 'staffId', 'protocolVersion', 'materials'];
const EVIDENCE_KEYS = ['kind', 'version', 'studyId', 'siteId', 'findingId', 'staffId', 'protocolVersion', 'requirementHash', 'materials', 'submitterClaims'];
const INPUT_KEYS = ['studyId', 'siteId', 'findingId', 'staffId', 'protocolVersion', 'materials', 'submitterClaims'];
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** In-process provenance only. JSON rebuilds cannot be registered here. */
const requirements = new WeakSet<object>();
const evidences = new WeakMap<object, { seal: string }>();

const fail = (code: string, message: string): never => { throw new GilError(code, message); };

/** Reject Proxy before any reflection so no trap or getter can execute. */
function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, 'Expected a plain object');
  if (nodeTypes.isProxy(value)) fail(code, 'Proxies are not accepted as evidence input');
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) fail(code, 'Only plain objects are accepted');
  if (Object.getOwnPropertySymbols(value as object).length) fail(code, 'Symbol keys are not accepted');
  return value as Record<string, unknown>;
}

/** Own data properties only; accessors are rejected instead of invoked. */
function readOwn(record: Record<string, unknown>, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code, `Property ${key} must be a data property, not a getter`);
  if (!descriptor.enumerable) fail(code, `Property ${key} must be enumerable`);
  return descriptor.value;
}

function text(record: Record<string, unknown>, key: string, code: string): string {
  const value = readOwn(record, key, code);
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${key} must be a non-empty string`);
  return value;
}

function rejectUnknown(record: Record<string, unknown>, allowed: string[], code: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(code, `Unknown field ${key}`);
}

function pickScope(record: Record<string, unknown>, code: string): EvidenceScope {
  return {
    studyId: text(record, 'studyId', code), siteId: text(record, 'siteId', code),
    findingId: text(record, 'findingId', code), staffId: text(record, 'staffId', code),
  };
}

/** Materials keep the given order; ids must be unique and hashes well formed. */
function pickMaterials(value: unknown, code: string): MaterialRef[] {
  if (!Array.isArray(value)) fail(code, 'materials must be an array');
  if (nodeTypes.isProxy(value)) fail(code, 'Proxies are not accepted as evidence input');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    fail(code, 'materials must be a dense array without extra properties');
  }
  const seen = new Set<string>();
  const materials: MaterialRef[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = plainRecord(readOwn(value, String(index), code), code);
    rejectUnknown(entry, MATERIAL_KEYS, code);
    const id = text(entry, 'id', code);
    const contentHash = text(entry, 'contentHash', code);
    if (!HASH_PATTERN.test(contentHash)) fail('INVALID_MATERIAL', `contentHash of ${id} must be sha256:<64 hex>`);
    if (seen.has(id)) fail('DUPLICATE_MATERIAL_ID', `Material id ${id} appears more than once`);
    seen.add(id);
    materials.push({ id, contentHash });
  }
  return materials;
}

/** Projection that deliberately drops submitterClaims: readiness never sees it. */
function pickEvidence(value: unknown, code: string): EvidenceContent {
  const record = plainRecord(value, code);
  rejectUnknown(record, EVIDENCE_KEYS, code);
  const kind = text(record, 'kind', code);
  if (kind !== 'evidence') fail(code, 'kind must be evidence');
  const requirementHash = text(record, 'requirementHash', code);
  if (!HASH_PATTERN.test(requirementHash)) fail(code, 'requirementHash must be sha256:<64 hex>');
  return {
    kind: 'evidence', version: text(record, 'version', code), ...pickScope(record, code),
    protocolVersion: text(record, 'protocolVersion', code), requirementHash,
    materials: pickMaterials(readOwn(record, 'materials', code), code),
  };
}

function pickRequirement(value: unknown, code: string): RequirementSnapshot {
  const record = plainRecord(value, code);
  rejectUnknown(record, REQUIREMENT_KEYS, code);
  const kind = text(record, 'kind', code);
  if (kind !== 'requirement') fail(code, 'kind must be requirement');
  const contentHash = text(record, 'contentHash', code);
  if (!HASH_PATTERN.test(contentHash)) fail(code, 'contentHash must be sha256:<64 hex>');
  return {
    kind: 'requirement', version: text(record, 'version', code), contentHash, ...pickScope(record, code),
    protocolVersion: text(record, 'protocolVersion', code),
    materials: pickMaterials(readOwn(record, 'materials', code), code),
  };
}

function pickClaims(value: unknown): EvidenceInput['submitterClaims'] {
  if (value === undefined) return undefined;
  const record = plainRecord(value, 'INVALID_EVIDENCE');
  rejectUnknown(record, ['authenticityEstablished', 'complete'], 'INVALID_EVIDENCE');
  const claims: { authenticityEstablished?: boolean; complete?: boolean } = {};
  for (const key of ['authenticityEstablished', 'complete'] as const) {
    if (!Object.hasOwn(record, key)) continue;
    const flag = readOwn(record, key, 'INVALID_EVIDENCE');
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') fail('INVALID_EVIDENCE', 'Submitter claims must be booleans');
    claims[key] = flag;
  }
  return claims;
}

function pickOptions(value: unknown): EvidenceOptions {
  const record = plainRecord(value, 'INVALID_EVIDENCE');
  rejectUnknown(record, ['allowMissingMaterials'], 'INVALID_EVIDENCE');
  if (!Object.hasOwn(record, 'allowMissingMaterials')) return {};
  const flag = readOwn(record, 'allowMissingMaterials', 'INVALID_EVIDENCE');
  if (typeof flag !== 'boolean') fail('INVALID_EVIDENCE', 'allowMissingMaterials must be a boolean');
  return { allowMissingMaterials: flag };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Digest binds kind/version/scope/protocol/materials; arrays keep the given order. */
function requirementDigest(value: RequirementContent & { materials: MaterialRef[] }): string {
  return hashValue({ kind: value.kind, version: value.version, studyId: value.studyId, siteId: value.siteId,
    findingId: value.findingId, staffId: value.staffId, protocolVersion: value.protocolVersion, materials: value.materials });
}

/** Digest excludes submitterClaims: untrusted assertions must not become bound check input. */
function evidenceDigest(value: EvidenceContent): string {
  return hashValue({ kind: value.kind, version: value.version, studyId: value.studyId, siteId: value.siteId,
    findingId: value.findingId, staffId: value.staffId, protocolVersion: value.protocolVersion,
    requirementHash: value.requirementHash, materials: value.materials });
}

/** Content checksum of an evidence snapshot. A checksum is not authority. */
export function evidenceHash(value: EvidenceSnapshot): string {
  return evidenceDigest(pickEvidence(value, 'INVALID_EVIDENCE'));
}

/** Content checksum of a requirement snapshot, recomputed from its fields. */
export function requirementHash(value: RequirementSnapshot): string {
  return requirementDigest(pickRequirement(value, 'INVALID_REQUIREMENT'));
}

/** 明确的策略：缺项默认拒绝，只有显式 allowMissingMaterials 才能签发不完整快照。 */
export function createRequirement(input: RequirementInput): RequirementSnapshot {
  const record = plainRecord(input, 'INVALID_REQUIREMENT');
  rejectUnknown(record, INPUT_KEYS.filter(key => key !== 'submitterClaims'), 'INVALID_REQUIREMENT');
  const scope = pickScope(record, 'INVALID_REQUIREMENT');
  const protocolVersion = text(record, 'protocolVersion', 'INVALID_REQUIREMENT');
  const materials = pickMaterials(readOwn(record, 'materials', 'INVALID_REQUIREMENT'), 'INVALID_REQUIREMENT');
  // A requirement without materials would be vacuously satisfied by any evidence.
  if (materials.length === 0) fail('INVALID_REQUIREMENT', 'A requirement needs at least one material to be checkable');
  const content: RequirementContent = { kind: 'requirement', version: EVIDENCE_VERSION, ...scope, protocolVersion, materials };
  const snapshot: RequirementSnapshot = freeze({ ...content, contentHash: requirementDigest(content) });
  requirements.add(snapshot);
  return snapshot;
}

/**
 * Evidence creation is fail-closed for inconsistent submissions:
 * undeclared ids, duplicated ids and hash (version) mismatches are rejected.
 * Missing requirement materials are rejected unless `allowMissingMaterials` is set;
 * in that case evidenceReady stays false and the snapshot is explicitly incomplete.
 */
export function createEvidence(
  requirement: RequirementSnapshot, input: EvidenceInput, options: EvidenceOptions = {},
): EvidenceSnapshot {
  // Provenance first: a copied or JSON-rebuilt requirement is never a check input.
  const req = pickRequirement(validateRequirement(requirement), 'INVALID_REQUIREMENT');
  const opts = pickOptions(options);
  const record = plainRecord(input, 'INVALID_EVIDENCE');
  rejectUnknown(record, INPUT_KEYS, 'INVALID_EVIDENCE');
  const scope = pickScope(record, 'INVALID_EVIDENCE');
  if (!scopeMatches(req, scope)) fail('EVIDENCE_SCOPE_MISMATCH', 'Evidence scope must match the requirement scope exactly');
  const protocolVersion = text(record, 'protocolVersion', 'INVALID_EVIDENCE');
  if (protocolVersion !== req.protocolVersion) {
    fail('PROTOCOL_VERSION_MISMATCH', `Evidence must cite protocol ${req.protocolVersion}`);
  }
  const materials = pickMaterials(readOwn(record, 'materials', 'INVALID_EVIDENCE'), 'INVALID_EVIDENCE');
  const required = new Map(req.materials.map(material => [material.id, material.contentHash]));
  for (const material of materials) {
    const expected = required.get(material.id);
    if (expected === undefined) fail('UNDECLARED_MATERIAL', `Material ${material.id} is not declared by the requirement`);
    if (expected !== material.contentHash) {
      fail('MATERIAL_HASH_MISMATCH', `Material ${material.id} does not match the required version`);
    }
  }
  const supplied = new Set(materials.map(material => material.id));
  const missing = req.materials.filter(material => !supplied.has(material.id));
  if (missing.length && opts.allowMissingMaterials !== true) {
    fail('MISSING_EVIDENCE', `Missing required materials: ${missing.map(material => material.id).join(', ')}`);
  }
  const claims = pickClaims(readOwn(record, 'submitterClaims', 'INVALID_EVIDENCE'));
  const content: EvidenceContent = { kind: 'evidence', version: EVIDENCE_VERSION, ...scope, protocolVersion,
    requirementHash: req.contentHash, materials };
  const snapshot: EvidenceSnapshot = freeze(claims ? { ...content, submitterClaims: claims } : { ...content });
  evidences.set(snapshot, { seal: evidenceDigest(content) });
  return snapshot;
}

/** Recomputes the digest; a self-consistent JSON rebuild still has no provenance. */
export function validateRequirement(value: RequirementSnapshot): RequirementSnapshot {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || !requirements.has(value)) {
    fail('UNTRUSTED_REQUIREMENT', 'Use a RequirementSnapshot returned by createRequirement; copies and JSON rebuilds are rejected');
  }
  const picked = pickRequirement(value, 'INVALID_REQUIREMENT');
  if (requirementDigest(picked) !== picked.contentHash) {
    fail('TAMPERED_REQUIREMENT', 'Requirement contentHash must match its own content');
  }
  return value;
}

/** Seal check plus, optionally, exact binding to one requirement. */
export function validateEvidence(value: EvidenceSnapshot, requirement?: RequirementSnapshot): EvidenceSnapshot {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || !evidences.has(value)) {
    fail('UNTRUSTED_EVIDENCE', 'Use an EvidenceSnapshot returned by createEvidence; copies and JSON rebuilds are rejected');
  }
  const seal = evidences.get(value)!;
  const picked = pickEvidence(value, 'INVALID_EVIDENCE');
  if (evidenceDigest(picked) !== seal.seal) fail('TAMPERED_EVIDENCE', 'Evidence content must match its in-process seal');
  if (requirement !== undefined) {
    const req = validateRequirement(requirement);
    if (picked.requirementHash !== req.contentHash) {
      fail('REQUIREMENT_HASH_MISMATCH', 'Evidence must bind the exact requirement contentHash');
    }
    if (picked.protocolVersion !== req.protocolVersion) fail('PROTOCOL_VERSION_MISMATCH', 'Protocol version must match');
    if (!scopeMatches(req, picked)) fail('EVIDENCE_SCOPE_MISMATCH', 'Evidence scope must match the requirement scope');
  }
  return value;
}

/** Total predicate: malformed or unreadable scopes are not a match. */
export function scopeMatches(left: EvidenceScope, right: EvidenceScope): boolean {
  try {
    const a = pickScope(plainRecord(left, 'INVALID_SCOPE'), 'INVALID_SCOPE');
    const b = pickScope(plainRecord(right, 'INVALID_SCOPE'), 'INVALID_SCOPE');
    return a.studyId === b.studyId && a.siteId === b.siteId && a.findingId === b.findingId && a.staffId === b.staffId;
  } catch (error) {
    if (error instanceof GilError) return false;
    throw error;
  }
}

/**
 * Plain-data diagnosis, no provenance required: it describes what the bytes say.
 * Codes stay distinct: MISSING_EVIDENCE / MATERIAL_HASH_MISMATCH / UNABLE_TO_EVALUATE.
 */
export function materialDiagnostics(
  requirement: RequirementSnapshot, evidence: EvidenceSnapshot,
): MaterialDiagnostic[] {
  const unassessable = (message: string): MaterialDiagnostic[] =>
    [{ code: 'UNABLE_TO_EVALUATE', materialId: '*', message }];
  let req: RequirementSnapshot, ev: EvidenceContent;
  try {
    req = pickRequirement(requirement, 'INVALID_REQUIREMENT');
    ev = pickEvidence(evidence, 'INVALID_EVIDENCE');
  } catch (error) {
    if (error instanceof GilError) return unassessable('Requirement or evidence is not assessable plain data');
    throw error;
  }
  if (requirementDigest(req) !== req.contentHash) return unassessable('Requirement content no longer matches its contentHash');
  if (ev.requirementHash !== req.contentHash) return unassessable('Evidence binds a different requirement version');
  if (new Set(ev.materials.map(material => material.id)).size !== ev.materials.length) {
    return unassessable('Duplicate material ids make coverage unassessable');
  }
  const required = new Map(req.materials.map(material => [material.id, material.contentHash]));
  const supplied = new Map(ev.materials.map(material => [material.id, material.contentHash]));
  const diagnostics: MaterialDiagnostic[] = [];
  for (const [id, hash] of required) {
    if (!supplied.has(id)) diagnostics.push({ code: 'MISSING_EVIDENCE', materialId: id, message: `No evidence material for ${id}` });
    else if (supplied.get(id) !== hash) {
      diagnostics.push({ code: 'MATERIAL_HASH_MISMATCH', materialId: id, message: `Evidence material ${id} is a different version` });
    }
  }
  for (const id of supplied.keys()) {
    if (!required.has(id)) {
      diagnostics.push({ code: 'UNABLE_TO_EVALUATE', materialId: id, message: `Material ${id} is not declared by the requirement` });
    }
  }
  return diagnostics;
}

/** Confirmed absence (plus unassessable input) — never reports a version mismatch as missing. */
export function missingMaterials(requirement: RequirementSnapshot, evidence: EvidenceSnapshot): MaterialDiagnostic[] {
  return materialDiagnostics(requirement, evidence).filter(diagnostic => diagnostic.code !== 'MATERIAL_HASH_MISMATCH');
}

/** Version mismatch and unassessable coverage — never confirms absence. */
export function inconsistentMaterials(requirement: RequirementSnapshot, evidence: EvidenceSnapshot): MaterialDiagnostic[] {
  return materialDiagnostics(requirement, evidence).filter(diagnostic => diagnostic.code !== 'MISSING_EVIDENCE');
}

/**
 * Pure derivation from material coverage and hash equality only.
 * submitterClaims is never read (the projection drops it), so a submitter cannot assert readiness.
 * This is a derivation, not a trust gate: call validateEvidence separately.
 */
export function evidenceReady(requirement: RequirementSnapshot, evidence: EvidenceSnapshot): EvidenceReadiness {
  const reasons: string[] = [];
  const unassessable = (message: string): EvidenceReadiness => ({ ready: false, reasons: [`UNABLE_TO_EVALUATE:${message}`] });
  let req: RequirementSnapshot, ev: EvidenceContent;
  try {
    req = pickRequirement(requirement, 'INVALID_REQUIREMENT');
    ev = pickEvidence(evidence, 'INVALID_EVIDENCE');
  } catch (error) {
    if (error instanceof GilError) return unassessable('requirement or evidence is not assessable plain data');
    throw error;
  }
  if (!scopeMatches(req, ev)) reasons.push('SCOPE_MISMATCH:study, site, finding and staff must match');
  if (req.protocolVersion !== ev.protocolVersion) {
    reasons.push(`PROTOCOL_VERSION_MISMATCH:${req.protocolVersion}!=${ev.protocolVersion}`);
  }
  if (requirementDigest(req) !== req.contentHash) reasons.push('REQUIREMENT_TAMPERED:contentHash does not match content');
  if (ev.requirementHash !== req.contentHash) reasons.push('REQUIREMENT_HASH_MISMATCH:evidence binds another requirement');
  for (const diagnostic of materialDiagnostics(req, ev)) reasons.push(`${diagnostic.code}:${diagnostic.materialId}`);
  return { ready: reasons.length === 0, reasons: freeze(reasons) };
}
