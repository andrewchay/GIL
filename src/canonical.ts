import { createHash } from 'node:crypto';
import { GilError } from './ast.ts';
import type { Document } from './ast.ts';

export const PROFILE = 'gil-core-clinical-0.1';

/**
 * 摘要稳定性约束：
 * - `typeExpr` 是 `type` 的冗余结构，`type` 已是规范文本，二者信息等价。
 * - `spec.output` / `spec.knowledge` / `spec.verification` 是本阶段新增章节，
 *   为空时不得改变既有文档的摘要。
 * 任何新增的可选章节都必须加入 `OMIT_WHEN_EMPTY`，否则历史摘要会无故漂移。
 */
const OMIT_WHEN_EMPTY = new Set(['output', 'knowledge', 'verification']);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined || key === 'typeExpr') continue;
    const normalized = normalize(inner);
    if (Array.isArray(normalized) && normalized.length === 0 && OMIT_WHEN_EMPTY.has(key)) continue;
    result[key] = normalized;
  }
  return result;
}

/** Recursive JSON key order is deterministic; declaration/argument order is retained. */
function ordered(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GilError('CANONICAL_ERROR', 'Cannot canonicalize non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(ordered);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, ordered((value as Record<string, unknown>)[key])]));
  }
  throw new GilError('CANONICAL_ERROR', 'AST contains a non-JSON value');
}

/** Profile-tagged canonical JSON, not a pretty-printed GIL source projection. */
export function canonical(document: Document): string {
  return JSON.stringify(ordered(normalize({ profile: PROFILE, document })));
}

/** SHA-256 of UTF-8 canonical JSON. This is a content ID, not an authorization. */
export function contentHash(document: Document): string {
  return `sha256:${createHash('sha256').update(canonical(document), 'utf8').digest('hex')}`;
}
