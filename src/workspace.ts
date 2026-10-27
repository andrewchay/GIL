// GIL-Workspace：共享工件、来源引用、状态快照与用户可控记忆。
// 本层只提供共享世界的外部表示：工件可访问不等于其中断言被接受，快照不等于真实世界已被捕获。
// 记忆默认不自动产生；写入必须带用途、来源和保留策略，且用户可查看、纠正、删除。
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import { HASH_PATTERN, denseArray, fail, freeze, nonEmpty, plainRecord, readOwn, rejectUnknown } from './artifact.ts';

export const WORKSPACE_VERSION = 'gil-workspace-artifact-0.1';
export const MEMORY_VERSION = 'gil-workspace-memory-0.1';

/** 过程内工作空间能力。JSON 无法重建；伪造对象在 WeakMap 中查不到。 */
export interface Workspace { readonly kind: 'workspace' }

export interface Artifact {
  kind: 'artifact';
  version: string;
  id: string;
  /** 显示名称不是稳定身份：id 与 version 只用于人读，引用一律走 contentHash。 */
  mediaType: string;
  payloadHash: string;
  contentHash: string;
}

export type SourceRef =
  | { kind: 'text-span'; artifactHash: string; start: number; end: number }
  | { kind: 'object-selection'; artifactHash: string; objectIds: string[] };

export interface Snapshot {
  kind: 'snapshot';
  version: string;
  id: string;
  timestamp: number;
  specHash: string | null;
  artifactHashes: string[];
  parent: string | null;
  contentHash: string;
}

export type RetentionPolicy =
  | { kind: 'session' }
  | { kind: 'until'; until: number }
  | { kind: 'legal-hold'; authority: string; reason: string };

export type MemoryStatus = 'Active' | 'Superseded' | 'Deleted';
export type MemoryScope = 'session' | 'project' | 'user';
export type MemoryContent = { kind: 'artifact'; artifactHash: string } | { kind: 'value'; value: string };

export interface MemoryRecord {
  kind: 'memory-record';
  version: string;
  id: string;
  revision: number;
  owner: string;
  scope: MemoryScope;
  purpose: string;
  content: MemoryContent;
  provenance: SourceRef[];
  createdAt: number;
  retention: RetentionPolicy;
  access: 'owner-only' | 'workspace';
  status: MemoryStatus;
  supersededBy: string | null;
  /** 删除保留审计哈希：历史依据不因删除而消失。 */
  deletedAt: number | null;
  contentHash: string;
}

export interface ArtifactInput { id: string; version: string; mediaType: string; payloadHash: string }
export interface SnapshotInput { id: string; timestamp: number; specHash?: string; artifactHashes: string[]; parent?: string }
export interface MemoryInput {
  owner: string; scope: MemoryScope; purpose: string; content: MemoryContent;
  provenance: SourceRef[]; retention: RetentionPolicy; access: 'owner-only' | 'workspace';
  /** 显式创建时间；不接受隐式"现在"，便于审计与测试复现。 */
  createdAt: number;
}
export interface CorrectionInput { id: string; actor: string; at: number; content: MemoryContent; provenance: SourceRef[] }
export interface DeletionInput { id: string; actor: string; at: number }

interface Cell {
  artifacts: Record<string, Artifact>;
  /** 每个记忆 id 的完整版本链；最后一项是当前版本。 */
  memories: Record<string, MemoryRecord[]>;
  snapshots: Record<string, Snapshot>;
  order: string[];
}

const stores = new WeakMap<Workspace, Cell>();
const ARTIFACT_KEYS = ['kind', 'version', 'id', 'mediaType', 'payloadHash', 'contentHash'];
const SCOPES: readonly MemoryScope[] = ['session', 'project', 'user'];
const SCOPES_SET = new Set<string>(SCOPES);

/** 显示名称与版本号不进入摘要：同内容的工件无论叫什么都必须是同一个引用。 */
function artifactDigest(content: Omit<Artifact, 'contentHash'>): string {
  return hashValue({ version: content.version, mediaType: content.mediaType, payloadHash: content.payloadHash });
}

function memoryDigest(content: Omit<MemoryRecord, 'contentHash'>): string {
  return hashValue({ version: content.version, id: content.id, revision: content.revision, owner: content.owner,
    scope: content.scope, purpose: content.purpose, content: content.content, provenance: content.provenance,
    createdAt: content.createdAt, retention: content.retention, access: content.access, status: content.status,
    supersededBy: content.supersededBy, deletedAt: content.deletedAt });
}

function cellFor(workspace: Workspace): Cell {
  const cell = stores.get(workspace);
  if (!cell) fail('UNTRUSTED_WORKSPACE', 'Use createWorkspace; serialized workspaces convey no shared state');
  return cell;
}

function pickSourceRef(value: unknown): SourceRef {
  const record = plainRecord(value, 'INVALID_SOURCE_REF');
  const kind = readOwn(record, 'kind', 'INVALID_SOURCE_REF');
  const artifactHash = nonEmpty(readOwn(record, 'artifactHash', 'INVALID_SOURCE_REF'), 'INVALID_SOURCE_REF', 'artifactHash');
  if (!HASH_PATTERN.test(artifactHash)) fail('INVALID_SOURCE_REF', 'artifactHash must be sha256:<64 hex>');
  if (kind === 'text-span') {
    rejectUnknown(record, ['kind', 'artifactHash', 'start', 'end'], 'INVALID_SOURCE_REF');
    const start = readOwn(record, 'start', 'INVALID_SOURCE_REF');
    const end = readOwn(record, 'end', 'INVALID_SOURCE_REF');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
      fail('INVALID_SOURCE_REF', 'text-span requires 0 <= start < end');
    }
    return { kind: 'text-span', artifactHash, start: start as number, end: end as number };
  }
  if (kind === 'object-selection') {
    rejectUnknown(record, ['kind', 'artifactHash', 'objectIds'], 'INVALID_SOURCE_REF');
    const objectIds = denseArray(readOwn(record, 'objectIds', 'INVALID_SOURCE_REF'), 'INVALID_SOURCE_REF', 'objectIds')
      .map(id => nonEmpty(id, 'INVALID_SOURCE_REF', 'objectIds entry'));
    // 对象选择必须有稳定顺序之外的唯一性：重复 id 会让选择不可内容寻址。
    if (new Set(objectIds).size !== objectIds.length) fail('INVALID_SOURCE_REF', 'objectIds must be unique');
    if (objectIds.length === 0) fail('INVALID_SOURCE_REF', 'object-selection must select at least one object');
    return { kind: 'object-selection', artifactHash, objectIds };
  }
  return fail('INVALID_SOURCE_REF', 'SourceRef must be text-span or object-selection');
}

function pickRetention(value: unknown): RetentionPolicy {
  const record = plainRecord(value, 'INVALID_RETENTION');
  const kind = readOwn(record, 'kind', 'INVALID_RETENTION');
  if (kind === 'session') { rejectUnknown(record, ['kind'], 'INVALID_RETENTION'); return { kind: 'session' }; }
  if (kind === 'until') {
    rejectUnknown(record, ['kind', 'until'], 'INVALID_RETENTION');
    const until = readOwn(record, 'until', 'INVALID_RETENTION');
    if (typeof until !== 'number' || !Number.isFinite(until)) fail('INVALID_RETENTION', 'until must be a finite time');
    return { kind: 'until', until };
  }
  if (kind === 'legal-hold') {
    rejectUnknown(record, ['kind', 'authority', 'reason'], 'INVALID_RETENTION');
    return { kind: 'legal-hold', authority: nonEmpty(readOwn(record, 'authority', 'INVALID_RETENTION'), 'INVALID_RETENTION', 'authority'),
      reason: nonEmpty(readOwn(record, 'reason', 'INVALID_RETENTION'), 'INVALID_RETENTION', 'reason') };
  }
  return fail('INVALID_RETENTION', 'Retention must be session, until or legal-hold');
}

function pickContent(value: unknown): MemoryContent {
  const record = plainRecord(value, 'INVALID_MEMORY');
  const kind = readOwn(record, 'kind', 'INVALID_MEMORY');
  if (kind === 'artifact') {
    rejectUnknown(record, ['kind', 'artifactHash'], 'INVALID_MEMORY');
    const artifactHash = nonEmpty(readOwn(record, 'artifactHash', 'INVALID_MEMORY'), 'INVALID_MEMORY', 'artifactHash');
    if (!HASH_PATTERN.test(artifactHash)) fail('INVALID_MEMORY', 'artifactHash must be sha256:<64 hex>');
    return { kind: 'artifact', artifactHash };
  }
  if (kind === 'value') {
    rejectUnknown(record, ['kind', 'value'], 'INVALID_MEMORY');
    return { kind: 'value', value: nonEmpty(readOwn(record, 'value', 'INVALID_MEMORY'), 'INVALID_MEMORY', 'value') };
  }
  return fail('INVALID_MEMORY', 'Memory content must be artifact or value');
}

function pickProvenance(value: unknown): SourceRef[] {
  const refs = denseArray(value, 'INVALID_MEMORY', 'provenance').map(pickSourceRef);
  // 没有来源的记忆不是可审计的记忆。
  if (refs.length === 0) fail('MEMORY_WITHOUT_PROVENANCE', 'A memory record needs at least one provenance reference');
  return refs;
}

export function createWorkspace(): Workspace {
  const workspace: Workspace = Object.freeze({ kind: 'workspace' });
  stores.set(workspace, { artifacts: {}, memories: {}, snapshots: {}, order: [] });
  return workspace;
}

/** 登记不可变工件引用。内容相同的工件得到相同 contentHash。 */
export function addArtifact(workspace: Workspace, input: ArtifactInput): Artifact {
  const cell = cellFor(workspace);
  const record = plainRecord(input, 'INVALID_ARTIFACT');
  rejectUnknown(record, ['id', 'version', 'mediaType', 'payloadHash'], 'INVALID_ARTIFACT');
  const payloadHash = nonEmpty(readOwn(record, 'payloadHash', 'INVALID_ARTIFACT'), 'INVALID_ARTIFACT', 'payloadHash');
  if (!HASH_PATTERN.test(payloadHash)) fail('INVALID_ARTIFACT', 'payloadHash must be sha256:<64 hex>');
  const content = { kind: 'artifact' as const, version: WORKSPACE_VERSION,
    id: nonEmpty(readOwn(record, 'id', 'INVALID_ARTIFACT'), 'INVALID_ARTIFACT', 'id'),
    mediaType: nonEmpty(readOwn(record, 'mediaType', 'INVALID_ARTIFACT'), 'INVALID_ARTIFACT', 'mediaType'),
    payloadHash };
  const artifact: Artifact = freeze({ ...content, contentHash: artifactDigest(content) });
  cell.artifacts[artifact.contentHash] = artifact;
  return artifact;
}

export function getArtifact(workspace: Workspace, contentHash: string): Artifact {
  const cell = cellFor(workspace);
  if (!Object.hasOwn(cell.artifacts, contentHash)) fail('UNKNOWN_ARTIFACT', `No artifact ${contentHash} in this workspace`);
  return cell.artifacts[contentHash];
}

/** 来源引用必须绑定真实存在的工件版本，否则接地是假的。 */
export function assertRefs(workspace: Workspace, refs: SourceRef[]): SourceRef[] {
  const cell = cellFor(workspace);
  for (const ref of refs.map(pickSourceRef)) {
    if (!Object.hasOwn(cell.artifacts, ref.artifactHash)) {
      fail('DANGLING_SOURCE_REF', `Source reference points at unknown artifact ${ref.artifactHash}`);
    }
  }
  return refs;
}

/** 快照是可引用的历史视图，不承诺捕获真实世界或可回滚副作用。 */
export function addSnapshot(workspace: Workspace, input: SnapshotInput): Snapshot {
  const cell = cellFor(workspace);
  const record = plainRecord(input, 'INVALID_SNAPSHOT');
  rejectUnknown(record, ['id', 'timestamp', 'specHash', 'artifactHashes', 'parent'], 'INVALID_SNAPSHOT');
  const id = nonEmpty(readOwn(record, 'id', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT', 'id');
  const timestamp = readOwn(record, 'timestamp', 'INVALID_SNAPSHOT');
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) fail('INVALID_SNAPSHOT', 'timestamp must be a finite time');
  const specHash = readOwn(record, 'specHash', 'INVALID_SNAPSHOT');
  if (specHash !== undefined && (typeof specHash !== 'string' || !HASH_PATTERN.test(specHash))) {
    fail('INVALID_SNAPSHOT', 'specHash must be sha256:<64 hex> when provided');
  }
  const artifactHashes = denseArray(readOwn(record, 'artifactHashes', 'INVALID_SNAPSHOT'), 'INVALID_SNAPSHOT', 'artifactHashes')
    .map(hash => nonEmpty(hash, 'INVALID_SNAPSHOT', 'artifactHashes entry'));
  for (const hash of artifactHashes) {
    if (!Object.hasOwn(cell.artifacts, hash)) fail('DANGLING_ARTIFACT', `Snapshot names unknown artifact ${hash}`);
  }
  const parent = readOwn(record, 'parent', 'INVALID_SNAPSHOT');
  if (parent !== undefined && !Object.hasOwn(cell.snapshots, parent as string)) fail('UNKNOWN_SNAPSHOT', 'Parent snapshot does not exist');
  const content = { kind: 'snapshot' as const, version: WORKSPACE_VERSION, id, timestamp,
    specHash: typeof specHash === 'string' ? specHash : null, artifactHashes, parent: typeof parent === 'string' ? parent : null };
  const snapshot: Snapshot = freeze({ ...content, contentHash: hashValue(content) });
  cell.snapshots[snapshot.contentHash] = snapshot;
  return snapshot;
}

/** 示例与反例是一等输入；示例不自动成为规则。 */
export function addExampleSet(workspace: Workspace, input: { name: string; positive: SourceRef[]; negative: SourceRef[] }): {
  kind: 'example-set'; version: string; name: string; positive: SourceRef[]; negative: SourceRef[]; contentHash: string;
} {
  const record = plainRecord(input, 'INVALID_EXAMPLES');
  rejectUnknown(record, ['name', 'positive', 'negative'], 'INVALID_EXAMPLES');
  const name = nonEmpty(readOwn(record, 'name', 'INVALID_EXAMPLES'), 'INVALID_EXAMPLES', 'name');
  const positive = assertRefs(workspace, denseArray(readOwn(record, 'positive', 'INVALID_EXAMPLES'), 'INVALID_EXAMPLES', 'positive').map(pickSourceRef));
  const negative = assertRefs(workspace, denseArray(readOwn(record, 'negative', 'INVALID_EXAMPLES'), 'INVALID_EXAMPLES', 'negative').map(pickSourceRef));
  if (positive.length === 0) fail('INVALID_EXAMPLES', 'An example set needs at least one positive example');
  // 同一来源不能同时是正例和反例：那会让标签失去意义。
  const overlap = positive.filter(ref => negative.some(other => other.artifactHash === ref.artifactHash
    && JSON.stringify(other) === JSON.stringify(ref)));
  if (overlap.length) fail('CONFLICTING_EXAMPLES', 'The same reference cannot be both positive and negative');
  const content = { kind: 'example-set' as const, version: WORKSPACE_VERSION, name, positive, negative };
  return freeze({ ...content, contentHash: hashValue(content) });
}

/** 写入记忆：必须显式给出用途、来源与保留策略。没有"顺手记住"的入口。 */
export function addMemory(workspace: Workspace, input: MemoryInput): MemoryRecord {
  const cell = cellFor(workspace);
  const record = plainRecord(input, 'INVALID_MEMORY');
  rejectUnknown(record, ['owner', 'scope', 'purpose', 'content', 'provenance', 'retention', 'access', 'createdAt'], 'INVALID_MEMORY');
  const owner = nonEmpty(readOwn(record, 'owner', 'INVALID_MEMORY'), 'INVALID_MEMORY', 'owner');
  const scope = readOwn(record, 'scope', 'INVALID_MEMORY');
  if (!SCOPES_SET.has(scope as string)) fail('INVALID_MEMORY', 'scope must be session, project or user');
  const purpose = nonEmpty(readOwn(record, 'purpose', 'INVALID_MEMORY'), 'INVALID_MEMORY', 'purpose');
  const content = pickContent(readOwn(record, 'content', 'INVALID_MEMORY'));
  const provenance = assertRefs(workspace, pickProvenance(readOwn(record, 'provenance', 'INVALID_MEMORY')));
  // 内容指向工件时，该工件必须存在。
  if (content.kind === 'artifact') getArtifact(workspace, content.artifactHash);
  const retention = pickRetention(readOwn(record, 'retention', 'INVALID_MEMORY'));
  const access = readOwn(record, 'access', 'INVALID_MEMORY');
  if (access !== 'owner-only' && access !== 'workspace') fail('INVALID_MEMORY', 'access must be owner-only or workspace');
  const createdAt = readOwn(record, 'createdAt', 'INVALID_MEMORY');
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) fail('INVALID_MEMORY', 'createdAt must be a finite time');
  const id = `mem-${hashValue({ owner, purpose, createdAt, seq: cell.order.length }).slice(7, 23)}`;
  const body = { kind: 'memory-record' as const, version: MEMORY_VERSION, id, revision: 1, owner,
    scope: scope as MemoryScope, purpose, content, provenance, createdAt,
    retention, access: access as 'owner-only' | 'workspace', status: 'Active' as MemoryStatus,
    supersededBy: null, deletedAt: null };
  const memory: MemoryRecord = freeze({ ...body, contentHash: memoryDigest(body) });
  cell.memories[id] = [memory];
  cell.order.push(id);
  return memory;
}

function currentOf(cell: Cell, id: string): MemoryRecord {
  if (!Object.hasOwn(cell.memories, id)) fail('UNKNOWN_MEMORY', `No memory ${id} in this workspace`);
  const chain = cell.memories[id];
  return chain[chain.length - 1];
}

/** 用户纠正：产生新版本，旧版本标记为 Superseded，历史内容不被静默改写。 */
export function correctMemory(workspace: Workspace, input: CorrectionInput): MemoryRecord {
  const cell = cellFor(workspace);
  const record = plainRecord(input, 'INVALID_CORRECTION');
  rejectUnknown(record, ['id', 'actor', 'at', 'content', 'provenance'], 'INVALID_CORRECTION');
  const id = nonEmpty(readOwn(record, 'id', 'INVALID_CORRECTION'), 'INVALID_CORRECTION', 'id');
  const actor = nonEmpty(readOwn(record, 'actor', 'INVALID_CORRECTION'), 'INVALID_CORRECTION', 'actor');
  const at = readOwn(record, 'at', 'INVALID_CORRECTION');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_CORRECTION', 'at must be a finite time');
  const previous = currentOf(cell, id);
  // 只有所有者能纠正自己的记忆。
  if (previous.owner !== actor) fail('MEMORY_OWNER_REQUIRED', 'Only the owner may correct this memory');
  if (previous.status === 'Deleted') fail('MEMORY_DELETED', 'A deleted memory cannot be corrected; create a new record instead');
  if (previous.status === 'Superseded') fail('MEMORY_SUPERSEDED', 'Only the current revision can be corrected');
  const content = pickContent(readOwn(record, 'content', 'INVALID_CORRECTION'));
  const provenance = assertRefs(workspace, pickProvenance(readOwn(record, 'provenance', 'INVALID_CORRECTION')));
  if (content.kind === 'artifact') getArtifact(workspace, content.artifactHash);
  const body = { kind: 'memory-record' as const, version: MEMORY_VERSION, id, revision: previous.revision + 1,
    owner: previous.owner, scope: previous.scope, purpose: previous.purpose, content, provenance,
    createdAt: at, retention: previous.retention, access: previous.access,
    status: 'Active' as MemoryStatus, supersededBy: null, deletedAt: null };
  const next: MemoryRecord = freeze({ ...body, contentHash: memoryDigest(body) });
  // 旧版本只改状态标记，内容与来源保持不变：这正是"不静默修改历史依据"。
  const chain = cell.memories[id];
  const retired: MemoryRecord = freeze({ ...chain[chain.length - 1], status: 'Superseded', supersededBy: next.contentHash });
  cell.memories[id] = [...chain.slice(0, -1), retired, next];
  return next;
}

/**
 * 用户删除：当前版本标记为 Deleted，历史保留。
 * 法律保留是显式例外，不能被普通删除绕过。
 */
export function deleteMemory(workspace: Workspace, input: DeletionInput): MemoryRecord {
  const cell = cellFor(workspace);
  const record = plainRecord(input, 'INVALID_DELETION');
  rejectUnknown(record, ['id', 'actor', 'at'], 'INVALID_DELETION');
  const id = nonEmpty(readOwn(record, 'id', 'INVALID_DELETION'), 'INVALID_DELETION', 'id');
  const actor = nonEmpty(readOwn(record, 'actor', 'INVALID_DELETION'), 'INVALID_DELETION', 'actor');
  const at = readOwn(record, 'at', 'INVALID_DELETION');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_DELETION', 'at must be a finite time');
  const previous = currentOf(cell, id);
  if (previous.owner !== actor) fail('MEMORY_OWNER_REQUIRED', 'Only the owner may delete this memory');
  if (previous.retention.kind === 'legal-hold') {
    fail('LEGAL_HOLD_BLOCKS_DELETION', 'Legal hold is an explicit exception; deletion requires a separate authority');
  }
  if (previous.status === 'Deleted') return previous;
  // 删除不产生新内容，因此不新增 revision：只把当前版本标记为 Deleted，内容与来源原样保留。
  const retired: MemoryRecord = freeze({ ...previous, status: 'Deleted', deletedAt: at });
  const chain = cell.memories[id];
  cell.memories[id] = [...chain.slice(0, -1), retired];
  return retired;
}

/** 用户查看自己的记忆；默认不含已删除项。 */
export function listMemories(workspace: Workspace, owner: string, options: { includeDeleted?: boolean } = {}): MemoryRecord[] {
  const cell = cellFor(workspace);
  const includeDeleted = options.includeDeleted === true;
  return freeze(cell.order
    .map(id => currentOf(cell, id))
    .filter(memory => memory.owner === owner && (includeDeleted || memory.status !== 'Deleted')));
}

/** 完整版本链：用于审计"纠正过什么"，不是当前上下文。 */
export function memoryHistory(workspace: Workspace, id: string): MemoryRecord[] {
  const cell = cellFor(workspace);
  currentOf(cell, id);
  return freeze([...cell.memories[id]]);
}

/** 保留期限到期且非法律保留的记录可以清理；这里只报告，不擅自删除。 */
export function purgeable(workspace: Workspace, now: number): MemoryRecord[] {
  const cell = cellFor(workspace);
  return freeze(cell.order.map(id => currentOf(cell, id)).filter(memory => {
    if (memory.retention.kind === 'legal-hold') return false;
    if (memory.retention.kind === 'session') return memory.status === 'Deleted';
    return memory.status === 'Deleted' || now >= memory.retention.until;
  }));
}

/**
 * 可作为新决策上下文使用的记忆。
 * 已删除与已被取代的版本一律排除——删除后不得继续影响新决策。
 */
export function contextFor(workspace: Workspace, owner: string, now: number): MemoryRecord[] {
  const cell = cellFor(workspace);
  return freeze(cell.order
    .map(id => currentOf(cell, id))
    .filter(memory => memory.status === 'Active'
      && (memory.access === 'workspace' || memory.owner === owner)
      && !(memory.retention.kind === 'until' && now >= memory.retention.until)));
}
