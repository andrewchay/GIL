import { createHash } from 'node:crypto';
import { GilError } from './ast.ts';
import type { Document } from './ast.ts';

export const PROFILE = 'gil-core-clinical-0.1';

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
  return JSON.stringify(ordered({ profile: PROFILE, document }));
}

/** SHA-256 of UTF-8 canonical JSON. This is a content ID, not an authorization. */
export function contentHash(document: Document): string {
  return `sha256:${createHash('sha256').update(canonical(document), 'utf8').digest('hex')}`;
}
