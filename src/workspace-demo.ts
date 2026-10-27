// GIL-Workspace 演示：不可变工件、来源引用、快照与用户可控记忆。
// 全部为过程内合成数据；不连接真实存储、访问控制或文件系统。
import { GilError } from './ast.ts';
import {
  addArtifact, addExampleSet, addMemory, addSnapshot, contextFor, correctMemory, createWorkspace,
  deleteMemory, listMemories, memoryHistory, purgeable,
} from './workspace.ts';

const HASH_PDF = 'sha256:' + 'a'.repeat(64);
const HASH_CSV = 'sha256:' + 'b'.repeat(64);
const NOW = 1793016000000;

function code(thrown: unknown): string { return thrown instanceof GilError ? thrown.code : 'UNEXPECTED_ERROR'; }

export function workspaceDemo(): unknown {
  const workspace = createWorkspace();
  const policy = addArtifact(workspace, { id: 'policy.pdf', version: '1', mediaType: 'application/pdf', payloadHash: HASH_PDF });
  const dataset = addArtifact(workspace, { id: 'rows.csv', version: '2', mediaType: 'text/csv', payloadHash: HASH_CSV });

  // 同内容不同显示名 → 同一个引用；同名字不同内容 → 不同引用。
  const renamed = addArtifact(workspace, { id: 'policy-copy.pdf', version: '9', mediaType: 'application/pdf', payloadHash: HASH_PDF });
  const revised = addArtifact(workspace, { id: 'policy.pdf', version: '2', mediaType: 'application/pdf', payloadHash: HASH_CSV });

  const span = { kind: 'text-span' as const, artifactHash: policy.contentHash, start: 12, end: 48 };
  const selection = { kind: 'object-selection' as const, artifactHash: dataset.contentHash, objectIds: ['row-7', 'row-9'] };
  const danglingRef = (() => {
    try { addSnapshot(workspace, { id: 'bad', timestamp: NOW, artifactHashes: [HASH_PDF] }); return 'ACCEPTED'; }
    catch (error) { return code(error); }
  })();

  const first = addSnapshot(workspace, { id: 'snap-1', timestamp: NOW, artifactHashes: [policy.contentHash] });
  const second = addSnapshot(workspace, { id: 'snap-2', timestamp: NOW + 1000,
    artifactHashes: [policy.contentHash, dataset.contentHash], parent: first.contentHash });
  const examples = addExampleSet(workspace, { name: 'training-labels', positive: [span], negative: [selection] });

  const memory = addMemory(workspace, { owner: 'ALICE', scope: 'user', purpose: 'answer-language-preference',
    content: { kind: 'value', value: 'prefers Chinese' }, provenance: [span],
    retention: { kind: 'session' }, access: 'owner-only', createdAt: NOW });
  // 没有来源的记忆不是可审计记忆。
  const memoryWithoutProvenance = (() => {
    try {
      addMemory(workspace, { owner: 'ALICE', scope: 'user', purpose: 'x', content: { kind: 'value', value: 'y' },
        provenance: [], retention: { kind: 'session' }, access: 'owner-only', createdAt: NOW });
      return 'ACCEPTED';
    } catch (error) { return code(error); }
  })();

  const corrected = correctMemory(workspace, { id: memory.id, actor: 'ALICE', at: NOW + 100,
    content: { kind: 'value', value: 'prefers English' }, provenance: [span] });
  const foreignCorrection = (() => {
    try {
      correctMemory(workspace, { id: memory.id, actor: 'BOB', at: NOW + 200,
        content: { kind: 'value', value: 'prefers French' }, provenance: [span] });
      return 'ACCEPTED';
    } catch (error) { return code(error); }
  })();
  const contextBeforeDelete = contextFor(workspace, 'ALICE', NOW + 300).map(record => record.content);

  deleteMemory(workspace, { id: memory.id, actor: 'ALICE', at: NOW + 400 });
  const contextAfterDelete = contextFor(workspace, 'ALICE', NOW + 500).length;

  const held = addMemory(workspace, { owner: 'ALICE', scope: 'project', purpose: 'audit-trail',
    content: { kind: 'value', value: 'retained-for-inspection' }, provenance: [span],
    retention: { kind: 'legal-hold', authority: 'AUDIT-OFFICE', reason: 'statutory retention' },
    access: 'workspace', createdAt: NOW });
  const legalHoldDeletion = (() => {
    try { deleteMemory(workspace, { id: held.id, actor: 'ALICE', at: NOW + 600 }); return 'DELETED'; }
    catch (error) { return code(error); }
  })();
  const expiring = addMemory(workspace, { owner: 'BOB', scope: 'user', purpose: 'temporary-note',
    content: { kind: 'value', value: 'scratch' }, provenance: [selection],
    retention: { kind: 'until', until: NOW + 1000 }, access: 'owner-only', createdAt: NOW });

  const history = memoryHistory(workspace, memory.id);
  const result = {
    ok: renamed.contentHash === policy.contentHash
      && revised.contentHash !== policy.contentHash
      && danglingRef === 'DANGLING_ARTIFACT'
      && memoryWithoutProvenance === 'MEMORY_WITHOUT_PROVENANCE'
      && foreignCorrection === 'MEMORY_OWNER_REQUIRED'
      && corrected.revision === 2
      && contextBeforeDelete.length === 1
      && contextAfterDelete === 0
      && legalHoldDeletion === 'LEGAL_HOLD_BLOCKS_DELETION'
      && purgeable(workspace, NOW + 2000).some(record => record.id === expiring.id),
    mode: 'synthetic-workspace-simulation',
    warning: 'SYNTHETIC ONLY: in-process artifacts and memories; no real storage, access control or deletion guarantee',
    artifacts: {
      policy: { hash: policy.contentHash, mediaType: policy.mediaType },
      renamedSameContent: { hash: renamed.contentHash, sameAsPolicy: renamed.contentHash === policy.contentHash },
      revisedDifferentContent: { hash: revised.contentHash, differsFromPolicy: revised.contentHash !== policy.contentHash },
      displayNamesAreNotIdentity: true,
    },
    sourceRefs: { textSpan: span, objectSelection: selection, danglingSnapshot: danglingRef },
    snapshots: { first: first.contentHash, second: second.contentHash, parent: second.parent },
    examples: { name: examples.name, positive: examples.positive.length, negative: examples.negative.length },
    memory: {
      created: { id: memory.id, revision: memory.revision, status: memory.status, purpose: memory.purpose },
      rejectedWithoutProvenance: memoryWithoutProvenance,
      corrected: { revision: corrected.revision, content: corrected.content },
      foreignCorrection,
      history: history.map(record => ({ revision: record.revision, status: record.status, supersededBy: record.supersededBy })),
      contextBeforeDelete,
      contextAfterDelete,
    },
    policy: {
      legalHold: { id: held.id, deletionAttempt: legalHoldDeletion },
      expiring: { id: expiring.id, purgeableAt: NOW + 2000,
        inPurgeList: purgeable(workspace, NOW + 2000).some(record => record.id === expiring.id) },
      visibleToOwner: listMemories(workspace, 'ALICE', { includeDeleted: true }).length,
    },
    // 明确区分"工件可访问"与"其中断言已被接受"：本层不做接受判定。
    note: 'Artifact access and memory presence never imply the claim inside was accepted or verified.',
  };
  return result;
}
