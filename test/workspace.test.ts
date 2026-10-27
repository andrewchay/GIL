// GIL-Workspace 验收测试：不可变工件、来源引用、快照、示例集与用户可控记忆。
// 全部为过程内合成数据；不连接真实文件系统、存储或访问控制。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GilError } from '../src/ast.ts';
import {
  addArtifact, addExampleSet, addMemory, addSnapshot, assertRefs, contextFor, correctMemory, createWorkspace,
  deleteMemory, getArtifact, listMemories, memoryHistory, purgeable,
} from '../src/workspace.ts';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);
const error = (code: string) => (thrown: unknown) => thrown instanceof GilError && thrown.code === code;

function fixture() {
  const workspace = createWorkspace();
  const report = addArtifact(workspace, { id: 'policy.pdf', version: '1', mediaType: 'application/pdf', payloadHash: HASH_A });
  const dataset = addArtifact(workspace, { id: 'rows.csv', version: '2', mediaType: 'text/csv', payloadHash: HASH_B });
  return { workspace, report, dataset };
}

test('Workspace: artifacts are content-addressed and display names are not identity', () => {
  const { workspace, report } = fixture();
  assert.match(report.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(getArtifact(workspace, report.contentHash).payloadHash, HASH_A);
  // 同名不同内容必然得到不同哈希；同内容不同 id 也只是不同引用。
  const renamed = addArtifact(workspace, { id: 'policy-copy.pdf', version: '1', mediaType: 'application/pdf', payloadHash: HASH_A });
  assert.equal(renamed.contentHash, report.contentHash);
  const changed = addArtifact(workspace, { id: 'policy.pdf', version: '2', mediaType: 'application/pdf', payloadHash: HASH_B });
  assert.notEqual(changed.contentHash, report.contentHash);
  assert.throws(() => getArtifact(workspace, HASH_A), error('UNKNOWN_ARTIFACT'));
  assert.throws(() => addArtifact(workspace, { id: 'x', version: '1', mediaType: 'text/plain', payloadHash: 'not-a-hash' }),
    error('INVALID_ARTIFACT'));
});

test('Workspace: source references bind an exact artifact version and reject dangling refs', () => {
  const { workspace, report } = fixture();
  const span = { kind: 'text-span', artifactHash: report.contentHash, start: 3, end: 9 };
  assert.deepEqual(assertRefs(workspace, [span]), [span]);
  assert.throws(() => assertRefs(workspace, [{ kind: 'text-span', artifactHash: HASH_A, start: 0, end: 1 }]),
    error('DANGLING_SOURCE_REF'));
  // 反向区间与重复对象选择都不可内容寻址。
  assert.throws(() => assertRefs(workspace, [{ kind: 'text-span', artifactHash: report.contentHash, start: 9, end: 3 }]),
    error('INVALID_SOURCE_REF'));
  assert.throws(() => assertRefs(workspace, [{ kind: 'object-selection', artifactHash: report.contentHash, objectIds: ['a', 'a'] }]),
    error('INVALID_SOURCE_REF'));
});

test('Workspace: snapshots are views over exact artifact versions, not world captures', () => {
  const { workspace, report, dataset } = fixture();
  const first = addSnapshot(workspace, { id: 's1', timestamp: 100, artifactHashes: [report.contentHash] });
  const second = addSnapshot(workspace, { id: 's2', timestamp: 200, artifactHashes: [report.contentHash, dataset.contentHash],
    parent: first.contentHash, specHash: HASH_B });
  assert.equal(second.parent, first.contentHash);
  assert.equal(second.specHash, HASH_B);
  assert.equal(second.artifactHashes.length, 2);
  assert.throws(() => addSnapshot(workspace, { id: 's3', timestamp: 300, artifactHashes: [HASH_A] }), error('DANGLING_ARTIFACT'));
  assert.throws(() => addSnapshot(workspace, { id: 's4', timestamp: 300, artifactHashes: [], parent: HASH_A }),
    error('UNKNOWN_SNAPSHOT'));
});

test('Workspace: example sets keep positive and negative apart', () => {
  const { workspace, report, dataset } = fixture();
  const positive = { kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 5 };
  const negative = { kind: 'object-selection', artifactHash: dataset.contentHash, objectIds: ['row-1'] };
  const set = addExampleSet(workspace, { name: 'labelled', positive: [positive], negative: [negative] });
  assert.equal(set.positive.length, 1);
  assert.match(set.contentHash, /^sha256:/);
  assert.throws(() => addExampleSet(workspace, { name: 'empty', positive: [], negative: [negative] }), error('INVALID_EXAMPLES'));
  assert.throws(() => addExampleSet(workspace, { name: 'both', positive: [positive], negative: [positive] }),
    error('CONFLICTING_EXAMPLES'));
});

test('Workspace: memory requires an explicit purpose, provenance and retention policy', () => {
  const { workspace, report } = fixture();
  const provenance = [{ kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 4 }];
  const base = { owner: 'alice', scope: 'user' as const, purpose: 'answer preference',
    content: { kind: 'value' as const, value: 'prefers Chinese' }, provenance,
    retention: { kind: 'session' as const }, access: 'owner-only' as const, createdAt: 100 };
  const memory = addMemory(workspace, base);
  assert.equal(memory.revision, 1);
  assert.equal(memory.status, 'Active');
  assert.match(memory.contentHash, /^sha256:/);
  // 空缺的用途、来源或保留策略一律拒绝，不存在"顺手记住"。
  assert.throws(() => addMemory(workspace, { ...base, purpose: '  ' }), error('INVALID_MEMORY'));
  assert.throws(() => addMemory(workspace, { ...base, provenance: [] }), error('MEMORY_WITHOUT_PROVENANCE'));
  assert.throws(() => addMemory(workspace, { ...base, retention: { kind: 'forever' } as never }), error('INVALID_RETENTION'));
  assert.throws(() => addMemory(workspace, { ...base, scope: 'global' as never }), error('INVALID_MEMORY'));
});

test('Workspace: correction creates a new revision and preserves the old evidence', () => {
  const { workspace, report } = fixture();
  const provenance = [{ kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 4 }];
  const memory = addMemory(workspace, { owner: 'alice', scope: 'user', purpose: 'pref',
    content: { kind: 'value', value: 'A' }, provenance, retention: { kind: 'session' }, access: 'owner-only', createdAt: 100 });
  const corrected = correctMemory(workspace, { id: memory.id, actor: 'alice', at: 200,
    content: { kind: 'value', value: 'B' }, provenance });
  assert.equal(corrected.revision, 2);
  const history = memoryHistory(workspace, memory.id);
  assert.deepEqual(history.map(record => [record.revision, record.status]), [[1, 'Superseded'], [2, 'Active']]);
  // 旧版本内容不被静默改写，并指明确切的替代版本。
  assert.equal((history[0].content as { value: string }).value, 'A');
  assert.equal(history[0].supersededBy, corrected.contentHash);
  assert.deepEqual(contextFor(workspace, 'alice', 300).map(record => (record.content as { value: string }).value), ['B']);
  // 只有所有者能纠正；已取代版本不能再改。
  assert.throws(() => correctMemory(workspace, { id: memory.id, actor: 'bob', at: 300,
    content: { kind: 'value', value: 'C' }, provenance }), error('MEMORY_OWNER_REQUIRED'));
});

test('Workspace: a deleted memory stops being context but its history remains', () => {
  const { workspace, report } = fixture();
  const provenance = [{ kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 4 }];
  const memory = addMemory(workspace, { owner: 'alice', scope: 'user', purpose: 'pref',
    content: { kind: 'value', value: 'A' }, provenance, retention: { kind: 'session' }, access: 'owner-only', createdAt: 100 });
  assert.equal(contextFor(workspace, 'alice', 150).length, 1);
  deleteMemory(workspace, { id: memory.id, actor: 'alice', at: 200 });
  assert.equal(contextFor(workspace, 'alice', 250).length, 0);
  assert.deepEqual(listMemories(workspace, 'alice'), []);
  assert.equal(listMemories(workspace, 'alice', { includeDeleted: true }).length, 1);
  const history = memoryHistory(workspace, memory.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'Deleted');
  assert.equal(history[0].deletedAt, 200);
  // 删除后不能纠正；他人不能删除。
  assert.throws(() => correctMemory(workspace, { id: memory.id, actor: 'alice', at: 300,
    content: { kind: 'value', value: 'B' }, provenance }), error('MEMORY_DELETED'));
  assert.throws(() => deleteMemory(workspace, { id: memory.id, actor: 'bob', at: 300 }), error('MEMORY_OWNER_REQUIRED'));
});

test('Workspace: legal hold is an explicit exception and cannot be deleted away', () => {
  const { workspace, report } = fixture();
  const provenance = [{ kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 4 }];
  const memory = addMemory(workspace, { owner: 'alice', scope: 'project', purpose: 'audit trail',
    content: { kind: 'value', value: 'retained' }, provenance,
    retention: { kind: 'legal-hold', authority: 'AUDIT-OFFICE', reason: 'statutory retention' },
    access: 'workspace', createdAt: 100 });
  assert.throws(() => deleteMemory(workspace, { id: memory.id, actor: 'alice', at: 200 }), error('LEGAL_HOLD_BLOCKS_DELETION'));
  assert.equal(purgeable(workspace, 1e12).length, 0);
  // 工作空间可见的记忆对其他参与者也可作为上下文，但所有者仍是 alice。
  assert.deepEqual(contextFor(workspace, 'bob', 300).map(record => record.id), [memory.id]);
});

test('Workspace: expired and session memories are reported for purge, not silently dropped', () => {
  const { workspace, report } = fixture();
  const provenance = [{ kind: 'text-span', artifactHash: report.contentHash, start: 0, end: 4 }];
  const expiring = addMemory(workspace, { owner: 'alice', scope: 'user', purpose: 'temp',
    content: { kind: 'value', value: 'x' }, provenance, retention: { kind: 'until', until: 500 },
    access: 'owner-only', createdAt: 100 });
  assert.equal(contextFor(workspace, 'alice', 400).length, 1);
  // 到期后不再作为上下文，但仍留在工作空间里等待显式清理。
  assert.equal(contextFor(workspace, 'alice', 600).length, 0);
  assert.deepEqual(purgeable(workspace, 600).map(record => record.id), [expiring.id]);
  assert.equal(listMemories(workspace, 'alice', { includeDeleted: true }).length, 1);
});

test('Workspace: workspaces are process-local capabilities', () => {
  const forged = { kind: 'workspace' };
  assert.throws(() => addArtifact(forged, { id: 'x', version: '1', mediaType: 'text/plain', payloadHash: HASH_A }),
    error('UNTRUSTED_WORKSPACE'));
  assert.throws(() => addArtifact(JSON.parse(JSON.stringify(createWorkspace())),
    { id: 'x', version: '1', mediaType: 'text/plain', payloadHash: HASH_A }), error('UNTRUSTED_WORKSPACE'));
});

test('Workspace CLI demo reports artifact, memory and retention behaviour', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'demo-workspace'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  const out = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(out));
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'synthetic-workspace-simulation');
  assert.match(out.warning, /SYNTHETIC ONLY/);
  assert.equal(out.artifacts.renamedSameContent.sameAsPolicy, true);
  assert.equal(out.artifacts.revisedDifferentContent.differsFromPolicy, true);
  assert.equal(out.sourceRefs.danglingSnapshot, 'DANGLING_ARTIFACT');
  assert.equal(out.memory.rejectedWithoutProvenance, 'MEMORY_WITHOUT_PROVENANCE');
  assert.equal(out.memory.foreignCorrection, 'MEMORY_OWNER_REQUIRED');
  assert.deepEqual(out.memory.history.map((record: { status: string }) => record.status), ['Superseded', 'Deleted']);
  assert.equal(out.memory.contextAfterDelete, 0);
  assert.equal(out.policy.legalHold.deletionAttempt, 'LEGAL_HOLD_BLOCKS_DELETION');
  assert.equal(out.policy.expiring.inPurgeList, true);
});
