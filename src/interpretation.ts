import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { GilError } from './ast.ts';
import type { Diagnostic } from './ast.ts';
import type { GroundingContext, Interpretation, SourceArtifact } from './interpretation-ast.ts';

export const INTERPRETATION_PROFILE = 'gil-exchange-interpretation-0.1';
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validName = (value: unknown): value is string => typeof value === 'string' && identifier.test(value) && !dangerous.has(value);
const validPath = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(validName);

/** Plain JSON only. Never invoke getters/toJSON or silently discard properties. */
function ordered(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) throw new GilError('CANONICAL_ERROR', 'Expected a finite plain JSON value');
  if (nodeTypes.isProxy(value)) throw new GilError('CANONICAL_ERROR', 'Proxies are not plain JSON');
  if (active.has(value)) throw new GilError('CANONICAL_ERROR', 'Cannot hash cyclic JSON');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    throw new GilError('CANONICAL_ERROR', 'Only plain JSON objects and arrays are supported');
  }
  if (Object.getOwnPropertySymbols(value).length) throw new GilError('CANONICAL_ERROR', 'Symbol properties are not JSON');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (dangerous.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new GilError('CANONICAL_ERROR', `Unsafe or non-JSON property ${key}`);
    }
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (value as unknown[]).length)) {
      throw new GilError('CANONICAL_ERROR', 'Arrays cannot have extra properties');
    }
  }
  active.add(value);
  try {
    if (array) {
      const result: unknown[] = [];
      for (let i = 0; i < (value as unknown[]).length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) throw new GilError('CANONICAL_ERROR', 'Sparse arrays are not JSON');
        result.push(ordered(descriptors[String(i)].value, active));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) result[key] = ordered(descriptors[key].value, active);
    return result;
  } finally { active.delete(value); }
}

/** Profile-tagged SHA-256. Arrays retain order; object keys sort recursively. */
export function hashValue(value: unknown): string {
  const json = JSON.stringify(ordered({ profile: INTERPRETATION_PROFILE, value }));
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

export function interpretationHash(value: Interpretation): string { return hashValue(value); }

/** Source digest binds all three fields, not text alone. No authority is conveyed. */
export function sourceArtifact(id: string, version: string, text: string): SourceArtifact {
  if (typeof id !== 'string' || !id || typeof version !== 'string' || !version || typeof text !== 'string') {
    throw new GilError('INVALID_SOURCE', 'Source requires a non-empty id and version and string text');
  }
  return { id, version, text, hash: hashValue({ id, version, text }) };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const splitsSurrogate = (text: string, offset: number): boolean => offset > 0 && offset < text.length &&
  text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff &&
  text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;

/** Structural and grounding checks only. open/ambiguous stay unresolved, not errors. */
export function validateInterpretation(value: Interpretation, context: GroundingContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string) => { diagnostics.push({ code, message }); };
  // Clone via the safe canonicalizer before property reads to avoid user getters.
  let document: Record<string, unknown>, ctx: Record<string, unknown>;
  try {
    document = ordered(value) as Record<string, unknown>;
    ctx = ordered(context) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof GilError)) throw error;
    return [{ code: error.code, message: error.message }];
  }
  if (!record(document) || !shape(document, ['kind', 'name', 'sourceText', 'imports', 'items']) ||
      document.kind !== 'interpretation' || !validName(document.name) || typeof document.sourceText !== 'string' ||
      !Array.isArray(document.imports) || !Array.isArray(document.items)) {
    return [{ code: 'INVALID_INTERPRETATION', message: 'Invalid interpretation structure' }];
  }
  if (!record(ctx) || !Array.isArray(ctx.sources) || !Array.isArray(ctx.references) || !Array.isArray(ctx.types) ||
      !ctx.references.every(item => typeof item === 'string' && validPath(item.split('.'))) ||
      !ctx.types.every(item => typeof item === 'string' && validPath(item.split('.')))) {
    return [{ code: 'INVALID_CONTEXT', message: 'Expected source, reference and type catalogs' }];
  }
  const references = new Set(ctx.references as string[]), types = new Set(ctx.types as string[]);
  const aliases = new Set<string>();
  for (const item of document.imports) {
    if (!record(item) || !shape(item, ['name', 'alias']) || typeof item.name !== 'string' || !validName(item.alias)) {
      report('INVALID_IMPORT', 'Import requires name and a safe alias'); continue;
    }
    if (aliases.has(item.alias)) report('DUPLICATE_ALIAS', `Duplicate import alias ${item.alias}`);
    aliases.add(item.alias);
    const at = item.name.lastIndexOf('@'), version = item.name.slice(at + 1);
    if (at < 1 || !version || version === 'latest' || /[\s*^~<>|@]/.test(version)) {
      report('IMPORT_VERSION_REQUIRED', `Import ${item.name} must use an exact version`);
    }
  }
  const checkReference = (path: unknown): void => {
    if (!validPath(path)) { report('INVALID_REFERENCE', 'Reference requires a safe identifier path'); return; }
    const name = path.join('.');
    if (path.length > 1 && !aliases.has(path[0])) report('UNRESOLVED_ALIAS', `Unimported alias ${path[0]}`);
    if (!references.has(name)) report('UNRESOLVED_REFERENCE', `Reference ${name} is absent from the explicit catalog`);
  };
  const sources = new Map<string, SourceArtifact>();
  for (const item of ctx.sources) {
    if (!record(item) || !shape(item, ['id', 'version', 'text', 'hash']) || typeof item.id !== 'string' || !item.id ||
        typeof item.version !== 'string' || !item.version || typeof item.text !== 'string' || typeof item.hash !== 'string') {
      report('INVALID_SOURCE', 'Source requires id, version, text and hash'); continue;
    }
    if (sources.has(item.id)) report('DUPLICATE_SOURCE', `Source id ${item.id} must resolve uniquely`);
    const source = item as unknown as SourceArtifact;
    sources.set(source.id, source);
    if (source.hash !== sourceArtifact(source.id, source.version, source.text).hash) {
      report('SOURCE_HASH_MISMATCH', `Source ${source.id} hash does not bind its id, version and text`);
    }
  }
  if (![...sources.values()].some(source => source.text === document.sourceText)) {
    report('SOURCE_TEXT_MISMATCH', 'Interpretation sourceText does not match any supplied source');
  }
  const names = new Set<string>();
  for (const item of document.items) {
    if (!record(item)) { report('INVALID_ITEM', 'Expected interpretation item'); continue; }
    if (item.kind === 'open' || item.kind === 'ambiguous') {
      if (!validName(item.name)) report('INVALID_NAME', 'Declaration requires a safe name');
      else {
        if (names.has(item.name)) report('DUPLICATE_NAME', `Duplicate declaration ${item.name}`);
        names.add(item.name);
      }
    }
    if (item.kind === 'open') {
      if (!shape(item, ['kind', 'name', 'type']) || typeof item.type !== 'string' || !validPath(item.type.split('.'))) {
        report('INVALID_TYPE', 'open requires a safe type path'); continue;
      }
      const path = item.type.split('.');
      if (path.length > 1 && !aliases.has(path[0])) report('UNRESOLVED_ALIAS', `Unimported type alias ${path[0]}`);
      if (!types.has(item.type)) report('UNRESOLVED_TYPE', `Type ${item.type} is absent from the explicit catalog`);
    } else if (item.kind === 'ambiguous') {
      if (!shape(item, ['kind', 'name', 'candidates']) || !Array.isArray(item.candidates)) {
        report('INVALID_CANDIDATES', 'ambiguous requires a candidate array'); continue;
      }
      if (item.candidates.length === 0) report('EMPTY_CANDIDATES', `Ambiguity ${String(item.name)} has no candidates`);
      const seen = new Set<string>();
      for (const candidate of item.candidates) {
        checkReference(candidate);
        if (!validPath(candidate)) continue;
        const name = candidate.join('.');
        if (seen.has(name)) report('DUPLICATE_CANDIDATE', `Duplicate candidate ${name}`);
        seen.add(name);
      }
    } else if (item.kind === 'ground') {
      if (!shape(item, ['kind', 'source', 'target']) || !record(item.source) ||
          !shape(item.source, ['artifactId', 'start', 'end'])) {
        report('INVALID_GROUND', 'ground requires sourceSpan and reference target'); continue;
      }
      if (!record(item.target) || !shape(item.target, ['kind', 'path'], ['next']) ||
          item.target.kind !== 'ref' || (Object.hasOwn(item.target, 'next') && item.target.next !== false)) {
        report('UNSUPPORTED_TARGET', 'Ground target must be an explicit non-prime reference');
      } else checkReference(item.target.path);
      const { artifactId, start, end } = item.source;
      const source = typeof artifactId === 'string' ? sources.get(artifactId) : undefined;
      if (!source) report('UNRESOLVED_SOURCE', `Unknown source ${String(artifactId)}`);
      else if (source.text !== document.sourceText) report('SOURCE_TEXT_MISMATCH', `Source ${source.id} differs from interpretation sourceText`);
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || end < start || (source && end > source.text.length)) {
        report('INVALID_SOURCE_SPAN', 'sourceSpan requires safe UTF-16 offsets 0 <= start <= end <= text.length');
      } else if (source && (splitsSurrogate(source.text, start) || splitsSurrogate(source.text, end))) {
        report('SURROGATE_SPLIT', 'sourceSpan boundary splits a UTF-16 surrogate pair');
      }
    } else if (item.kind === 'assume') {
      if (!validName(item.name)) report('INVALID_NAME', 'Declaration requires a safe name');
      else {
        if (names.has(item.name)) report('DUPLICATE_NAME', `Duplicate declaration ${item.name}`);
        names.add(item.name);
      }
      if (!shape(item, ['kind', 'name', 'expr'], ['provenance']) || !record(item.expr)) {
        report('INVALID_ITEM', 'assume requires an expression');
      }
    } else report('INVALID_ITEM', `Unsupported item kind ${String(item.kind)}`);
  }
  return diagnostics;
}
