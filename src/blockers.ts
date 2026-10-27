// Phase5 阻断项台账：内容寻址、不可变、过程内签发。
// 台账只记录阻断事实与解除权限；它不是豁免，也不能让调用者用 Bool 声称"已解除"。
// 解除必须由台账声明的 resolutionAuthority 执行，并产生新台账（旧台账与旧批准同时失效）。
import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';
import { HASH_PATTERN, denseArray, fail, freeze, nonEmpty, plainRecord, readOwn, rejectUnknown } from './artifact.ts';

export const BLOCKER_VERSION = 'gil-assurance-blockers-0.1';

export type BlockerState = 'OPEN' | 'RESOLVED' | 'WAIVED';
export type BlockerKind = 'policy' | 'dispute' | 'escalation';

export interface BlockerEntry {
  id: string;
  /** 被阻断的目标，例如动作名或需要解除的对象。用于显示"阻断目标"。 */
  target: string;
  kind: BlockerKind;
  owner: string;
  /** 唯一有权解除本条的主体。 */
  resolutionAuthority: string;
  state: BlockerState;
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface BlockerLedger {
  kind: 'blocker-ledger';
  version: string;
  findingId: string;
  ledgerHash: string;
  entries: BlockerEntry[];
  openIds: string[];
}

/** 与 GIL `C.BlockerStatus` concept 逐字段一致；只能由 blockerStatus 从受信台账派生。 */
export interface BlockerStatus {
  ledgerHash: string;
  findingId: string;
  openCount: number;
  total: number;
}

export interface BlockerLedgerInput { findingId: string; entries: BlockerEntry[] }
export interface ResolutionInput { id: string; actor: string; at: number; waiver?: boolean }

const STATES: readonly BlockerState[] = ['OPEN', 'RESOLVED', 'WAIVED'];
const KINDS: readonly BlockerKind[] = ['policy', 'dispute', 'escalation'];
const ENTRY_KEYS = ['id', 'target', 'kind', 'owner', 'resolutionAuthority', 'state', 'resolvedBy', 'resolvedAt'];
const LEDGER_KEYS = ['kind', 'version', 'findingId', 'ledgerHash', 'entries', 'openIds'];

/** 过程内签发记录。JSON 重建的台账没有 provenance，不能作为检查输入。 */
const ledgers = new WeakMap<object, { seal: string }>();

type EntryContent = Omit<BlockerEntry, 'resolvedBy' | 'resolvedAt'> & { resolvedBy?: string; resolvedAt?: number };
type LedgerContent = { kind: 'blocker-ledger'; version: string; findingId: string; entries: EntryContent[]; openIds: string[] };

function pickEntry(value: unknown): EntryContent {
  const record = plainRecord(value, 'INVALID_BLOCKER');
  rejectUnknown(record, ENTRY_KEYS, 'INVALID_BLOCKER');
  const id = nonEmpty(readOwn(record, 'id', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'id');
  const target = nonEmpty(readOwn(record, 'target', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'target');
  const owner = nonEmpty(readOwn(record, 'owner', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'owner');
  const authority = nonEmpty(readOwn(record, 'resolutionAuthority', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'resolutionAuthority');
  const kind = readOwn(record, 'kind', 'INVALID_BLOCKER');
  const state = readOwn(record, 'state', 'INVALID_BLOCKER');
  if (!KINDS.includes(kind as BlockerKind)) fail('INVALID_BLOCKER', 'kind must be policy, dispute or escalation');
  if (!STATES.includes(state as BlockerState)) fail('INVALID_BLOCKER', 'state must be OPEN, RESOLVED or WAIVED');
  const resolvedBy = readOwn(record, 'resolvedBy', 'INVALID_BLOCKER');
  const resolvedAt = readOwn(record, 'resolvedAt', 'INVALID_BLOCKER');
  const entry: EntryContent = { id, target, kind: kind as BlockerKind, owner, resolutionAuthority: authority, state: state as BlockerState };
  if (entry.state === 'OPEN') {
    // OPEN 条目不得携带解除痕迹，避免"已解除但状态没变"的双重叙述。
    if (resolvedBy !== undefined || resolvedAt !== undefined) fail('INVALID_BLOCKER', `Open blocker ${id} cannot carry a resolution`);
    return entry;
  }
  const who = nonEmpty(resolvedBy, 'INVALID_BLOCKER', `resolvedBy of ${id}`);
  const at = readOwn(record, 'resolvedAt', 'INVALID_BLOCKER');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_BLOCKER', `resolvedAt of ${id} must be a finite time`);
  // 解除只能由台账声明的权限主体完成：自证解除无效。
  if (who !== authority) fail('RESOLUTION_AUTHORITY_REQUIRED', `${id} must be resolved by its declared authority`);
  return { ...entry, resolvedBy: who, resolvedAt: at };
}

function ledgerDigest(content: LedgerContent): string {
  return hashValue({ version: content.version, findingId: content.findingId, entries: content.entries });
}

function openIdsOf(entries: EntryContent[]): string[] {
  return entries.filter(entry => entry.state === 'OPEN').map(entry => entry.id);
}

/** 建立不可变阻断项台账。id 必须唯一；OPEN 条目必须声明 owner 与解除权限。 */
export function createBlockerLedger(input: BlockerLedgerInput): BlockerLedger {
  const record = plainRecord(input, 'INVALID_BLOCKER');
  rejectUnknown(record, ['findingId', 'entries'], 'INVALID_BLOCKER');
  const findingId = nonEmpty(readOwn(record, 'findingId', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'findingId');
  const entries = denseArray(readOwn(record, 'entries', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'entries').map(pickEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail('DUPLICATE_BLOCKER', `Blocker id ${entry.id} appears more than once`);
    seen.add(entry.id);
  }
  const content: LedgerContent = { kind: 'blocker-ledger', version: BLOCKER_VERSION, findingId, entries, openIds: openIdsOf(entries) };
  const ledger: BlockerLedger = freeze({ ...content, ledgerHash: ledgerDigest(content) });
  ledgers.set(ledger, { seal: ledgerDigest(content) });
  return ledger;
}

/** provenance + 自洽校验：复制或 JSON 重建的台账一律拒绝。 */
export function validateBlockerLedger(value: BlockerLedger): BlockerLedger {
  if (value === null || typeof value !== 'object' || !ledgers.has(value)) {
    fail('UNTRUSTED_BLOCKER_LEDGER', 'Use a BlockerLedger returned by createBlockerLedger; copies and JSON rebuilds are rejected');
  }
  const record = plainRecord(value, 'INVALID_BLOCKER');
  rejectUnknown(record, LEDGER_KEYS, 'INVALID_BLOCKER');
  if (readOwn(record, 'kind', 'INVALID_BLOCKER') !== 'blocker-ledger') fail('INVALID_BLOCKER', 'kind must be blocker-ledger');
  const ledgerHash = nonEmpty(readOwn(record, 'ledgerHash', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'ledgerHash');
  if (!HASH_PATTERN.test(ledgerHash)) fail('INVALID_BLOCKER', 'ledgerHash must be sha256:<64 hex>');
  const content: LedgerContent = {
    kind: 'blocker-ledger', version: nonEmpty(readOwn(record, 'version', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'version'),
    findingId: nonEmpty(readOwn(record, 'findingId', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'findingId'),
    entries: denseArray(readOwn(record, 'entries', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'entries').map(pickEntry),
    openIds: denseArray(readOwn(record, 'openIds', 'INVALID_BLOCKER'), 'INVALID_BLOCKER', 'openIds')
      .map(id => nonEmpty(id, 'INVALID_BLOCKER', 'openIds entry')),
  };
  if (ledgerDigest(content) !== ledgerHash) fail('TAMPERED_BLOCKER_LEDGER', 'ledgerHash must match ledger content');
  if (hashValue(content.openIds) !== hashValue(openIdsOf(content.entries))) {
    fail('TAMPERED_BLOCKER_LEDGER', 'openIds must equal the open entries');
  }
  if (ledgers.get(value)!.seal !== ledgerHash) fail('TAMPERED_BLOCKER_LEDGER', 'Ledger no longer matches its in-process seal');
  return value;
}

/** 派生给 Core 的阻断状态。计数来自台账本身，绝不来自调用者输入。 */
export function blockerStatus(ledger: BlockerLedger): BlockerStatus {
  const valid = validateBlockerLedger(ledger);
  const openCount = valid.openIds.length;
  return freeze({ ledgerHash: valid.ledgerHash, findingId: valid.findingId, openCount, total: valid.entries.length });
}

/** 用于诊断展示：哪些目标仍被阻断、谁有权解除。 */
export function openBlockers(ledger: BlockerLedger): BlockerEntry[] {
  const valid = validateBlockerLedger(ledger);
  return freeze(valid.entries.filter(entry => entry.state === 'OPEN'));
}

/**
 * 解除单个阻断项，返回新台账。旧台账保持不可变，因此旧批准与旧请求摘要自然失效。
 * 重复解除同一 id 返回 alreadyResolved=true 且不产生新版本。
 */
export function resolveBlocker(ledger: BlockerLedger, input: ResolutionInput): { ledger: BlockerLedger; alreadyResolved: boolean } {
  const valid = validateBlockerLedger(ledger);
  const record = plainRecord(input, 'INVALID_RESOLUTION');
  rejectUnknown(record, ['id', 'actor', 'at', 'waiver'], 'INVALID_RESOLUTION');
  const id = nonEmpty(readOwn(record, 'id', 'INVALID_RESOLUTION'), 'INVALID_RESOLUTION', 'id');
  const actor = nonEmpty(readOwn(record, 'actor', 'INVALID_RESOLUTION'), 'INVALID_RESOLUTION', 'actor');
  const at = readOwn(record, 'at', 'INVALID_RESOLUTION');
  if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_RESOLUTION', 'at must be a finite synthetic time');
  const waiver = readOwn(record, 'waiver', 'INVALID_RESOLUTION');
  if (waiver !== undefined && typeof waiver !== 'boolean') fail('INVALID_RESOLUTION', 'waiver must be a boolean');
  const entry = valid.entries.find(item => item.id === id);
  if (!entry) fail('UNKNOWN_BLOCKER', `Blocker ${id} is not in this ledger`);
  if (entry.state !== 'OPEN') return { ledger: valid, alreadyResolved: true };
  if (actor !== entry.resolutionAuthority) {
    fail('RESOLUTION_AUTHORITY_REQUIRED', `${id} can only be resolved by ${entry.resolutionAuthority}`);
  }
  const next: EntryContent = { id: entry.id, target: entry.target, kind: entry.kind, owner: entry.owner,
    resolutionAuthority: entry.resolutionAuthority, state: waiver === true ? 'WAIVED' : 'RESOLVED',
    resolvedBy: actor, resolvedAt: at };
  const entries = valid.entries.map(item => item.id === id ? next : item);
  const content: LedgerContent = { kind: 'blocker-ledger', version: BLOCKER_VERSION, findingId: valid.findingId, entries, openIds: openIdsOf(entries) };
  const created: BlockerLedger = freeze({ ...content, ledgerHash: ledgerDigest(content) });
  ledgers.set(created, { seal: ledgerDigest(content) });
  return { ledger: created, alreadyResolved: false };
}

/** 纯查询：台账是否所有阻断项都已解除。缺项/不可读输入视为未解除。 */
export function blockersCleared(ledger: BlockerLedger): boolean {
  try { return blockerStatus(ledger).openCount === 0; } catch (error) {
    if (error instanceof GilError) return false;
    throw error;
  }
}
