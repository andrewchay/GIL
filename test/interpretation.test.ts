import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse, parseInterpretation } from '../src/parser.ts';
import { canonical, contentHash } from '../src/canonical.ts';
import { GilError } from '../src/ast.ts';
import type { Expr } from '../src/ast.ts';
import { hashValue, interpretationHash, sourceArtifact, validateInterpretation } from '../src/interpretation.ts';
import type { GroundingContext, Interpretation } from '../src/interpretation-ast.ts';

const text = '培训😀记录';
const code = `interpretation Training of ${JSON.stringify(text)} {
  use ontology "clinical/training@0.1" as C;
  ground sourceSpan("source-1", 0, 4) -> C.Requirement;
  open dueDate: Text;
  ambiguous evidence { candidates C.Current, C.Previous; }
}`;
const context = (): GroundingContext => ({
  sources: [sourceArtifact('source-1', 'v1', text)],
  references: ['C.Requirement', 'C.Current', 'C.Previous'],
  types: ['Text', 'C.Requirement'],
});
const codes = (value = parseInterpretation(code), ctx = context()) => validateInterpretation(value, ctx).map(d => d.code);
const ground = (value: Interpretation) => {
  const result = value.items[0]; assert.equal(result.kind, 'ground');
  if (result.kind !== 'ground') throw new Error('Expected ground');
  return result;
};
const ambiguity = (value: Interpretation) => {
  const result = value.items[2]; assert.equal(result.kind, 'ambiguous');
  if (result.kind !== 'ambiguous') throw new Error('Expected ambiguity');
  return result;
};
const rejects = (source: string, code?: string) => assert.throws(() => parseInterpretation(source), (error: unknown) => {
  assert.ok(error instanceof GilError);
  if (code) assert.equal(error.code, code);
  return true;
});

test('interpretation parser reuses Core tokens, preserves unresolved declarations', () => {
  const value = parseInterpretation(code);
  assert.deepEqual(value, {
    kind: 'interpretation', name: 'Training', sourceText: text,
    imports: [{ name: 'clinical/training@0.1', alias: 'C' }],
    items: [
      { kind: 'ground', source: { artifactId: 'source-1', start: 0, end: 4 }, target: { kind: 'ref', path: ['C', 'Requirement'] } },
      { kind: 'open', name: 'dueDate', type: 'Text' },
      { kind: 'ambiguous', name: 'evidence', candidates: [['C', 'Current'], ['C', 'Previous']] },
    ],
  });
  assert.deepEqual(codes(value), []);
  assert.equal(interpretationHash(value), interpretationHash(parseInterpretation(`(* hello *)\n// comment\n${code}`)));
  assert.throws(() => parse(code), error => error instanceof GilError && error.code === 'UNSUPPORTED_SYNTAX');
});

test('parser rejects unsupported source refs and ground target prime/call/temporal/literal/binary', () => {
  for (const target of ["C.Requirement'", 'C.Requirement()', 'always C.Requirement', 'eventually C.Requirement', 'true', 'C.Current == C.Previous']) {
    rejects(code.replace('-> C.Requirement;', `-> ${target};`), 'UNSUPPORTED_SYNTAX');
  }
  rejects(code.replace('sourceSpan(', 'source('));
  for (const offset of ['-1', '1.5', '9007199254740992', 'true']) rejects(code.replace(', 0, 4)', `, ${offset}, 4)`));
  rejects(`${code} ${code}`);
  rejects('interpretation I of "x" { open x: Text; use ontology "d@1" as D; }');
});

test('duplicate declarations, aliases and empty/duplicate candidates are diagnostics', () => {
  const value = parseInterpretation(code);
  value.imports.push({ ...value.imports[0] });
  value.items.push({ kind: 'open', name: 'evidence', type: 'Text' });
  ambiguity(value).candidates.push(['C', 'Current']);
  assert.ok(codes(value).includes('DUPLICATE_NAME'));
  assert.ok(codes(value).includes('DUPLICATE_ALIAS'));
  assert.ok(codes(value).includes('DUPLICATE_CANDIDATE'));
  const empty = parseInterpretation(code.replace('C.Current, C.Previous', ''));
  assert.ok(codes(empty).includes('EMPTY_CANDIDATES'));
});

test('references and types need explicit catalogs and qualified imported aliases', () => {
  const ctx = context(); ctx.references = []; ctx.types = [];
  assert.ok(codes(undefined, ctx).includes('UNRESOLVED_REFERENCE'));
  assert.ok(codes(undefined, ctx).includes('UNRESOLVED_TYPE'));
  const value = parseInterpretation(code); value.imports = [];
  value.items.push({ kind: 'open', name: 'requirement', type: 'C.Requirement' });
  assert.ok(codes(value).includes('UNRESOLVED_ALIAS'));
  // Local names can only ground when explicitly cataloged, never by inherited keys.
  ground(value).target = { kind: 'ref', path: ['local'] };
  ctx.references = ['local'];
  assert.ok(!validateInterpretation(value, ctx).some(d => d.message.includes('Reference local')));
});

test('imports require exact pinned versions, not latest or ranges', () => {
  for (const name of ['clinical/training', 'clinical/training@', 'clinical/training@latest', 'clinical/training@*', 'clinical/training@^1', 'clinical/training@~1', 'clinical/training@>=1']) {
    const value = parseInterpretation(code); value.imports[0].name = name;
    assert.ok(codes(value).includes('IMPORT_VERSION_REQUIRED'), name);
  }
  const value = parseInterpretation(code); value.imports[0].alias = '__proto__';
  assert.ok(codes(value).includes('INVALID_IMPORT'));
});

test('source hash binds id, version and text; detects swaps/tampering and duplicates', () => {
  const original = sourceArtifact('source-1', 'v1', text);
  assert.notEqual(original.hash, sourceArtifact('source-2', 'v1', text).hash);
  assert.notEqual(original.hash, sourceArtifact('source-1', 'v2', text).hash);
  assert.notEqual(original.hash, sourceArtifact('source-1', 'v1', text + '!').hash);
  for (const changed of [{ id: 'swapped' }, { version: 'v2' }, { text: 'tampered' }, { hash: 'sha256:bad' }]) {
    const ctx = context(); Object.assign(ctx.sources[0], changed);
    assert.ok(codes(undefined, ctx).includes('SOURCE_HASH_MISMATCH'));
  }
  const ctx = context(); ctx.sources.push(sourceArtifact('source-1', 'v2', text));
  assert.ok(codes(undefined, ctx).includes('DUPLICATE_SOURCE'));
  assert.throws(() => sourceArtifact('', 'v1', text), error => error instanceof GilError && error.code === 'INVALID_SOURCE');
});

test('interpretation sourceText must match each grounded source, not just any source', () => {
  const value = parseInterpretation(code); value.sourceText = 'different';
  assert.ok(codes(value).includes('SOURCE_TEXT_MISMATCH'));
  const ctx = context(); ctx.sources.push(sourceArtifact('other', 'v1', 'different'));
  assert.ok(codes(value, ctx).includes('SOURCE_TEXT_MISMATCH'));
  ground(value).source.artifactId = 'missing';
  assert.ok(codes(value, ctx).includes('UNRESOLVED_SOURCE'));
});

test('sourceSpan uses safe, zero-based, half-open UTF-16 offsets, rejecting surrogate splits', () => {
  // 培训=2 code units, 😀=2, 记录=2. Full emoji span is [2,4).
  const value = parseInterpretation(code);
  ground(value).source.start = 2; ground(value).source.end = 4;
  assert.deepEqual(codes(value), []);
  for (const [start, end] of [[0, 6], [0, 0], [6, 6]]) {
    Object.assign(ground(value).source, { start, end }); assert.deepEqual(codes(value), []);
  }
  for (const [start, end] of [[-1, 1], [1, 0], [0, 7], [0.5, 4], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    Object.assign(ground(value).source, { start, end });
    assert.ok(codes(value).some(code => code === 'INVALID_SOURCE_SPAN' || code === 'CANONICAL_ERROR'));
  }
  for (const [start, end] of [[3, 4], [2, 3], [3, 3]]) {
    Object.assign(ground(value).source, { start, end }); assert.ok(codes(value).includes('SURROGATE_SPLIT'));
  }
});

test('external ASTs cannot bypass target restrictions or smuggle extra execution fields', () => {
  const value = parseInterpretation(code);
  for (const target of [
    { kind: 'ref', path: ['C', 'Current'], next: true },
    { kind: 'call', path: ['C', 'Current'], args: [] },
    { kind: 'unary', op: 'always', arg: { kind: 'ref', path: ['C', 'Current'] } },
  ]) {
    ground(value).target = target as Expr;
    assert.ok(codes(value).includes('UNSUPPORTED_TARGET'));
  }
  const extra = parseInterpretation(code) as Interpretation & { authorization: boolean }; extra.authorization = true;
  assert.ok(codes(extra).includes('INVALID_INTERPRETATION'));
});

test('profile hash sorts ordinary JSON keys, preserves array order and binds revisions', () => {
  assert.equal(hashValue({ b: { y: 2, x: 1 }, a: [1, 2] }), hashValue({ a: [1, 2], b: { x: 1, y: 2 } }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  assert.match(hashValue(null), /^sha256:[0-9a-f]{64}$/);
  const expected = `sha256:${createHash('sha256').update('{"profile":"gil-exchange-interpretation-0.1","value":{"a":1}}').digest('hex')}`;
  assert.equal(hashValue({ a: 1 }), expected);
  const value = parseInterpretation(code), revised = structuredClone(value);
  ambiguity(revised).candidates.reverse();
  assert.notEqual(interpretationHash(value), interpretationHash(revised));
  revised.sourceText += '!'; assert.notEqual(interpretationHash(value), interpretationHash(revised));
  const shared = { x: 1 }; assert.equal(hashValue([shared, shared]), hashValue([{ x: 1 }, { x: 1 }]));
});

test('safe hash rejects non-JSON values, cycles, dangerous keys, sparse arrays and getters', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const symbolKey = { [Symbol('s')]: 'value' };
  const extraArray = [1] as number[] & { extra?: number }; extraArray.extra = 2;
  const nonEnumerable = Object.defineProperty({}, 'x', { value: 1 });
  let invoked = false;
  const getter = { get x() { invoked = true; return 1; } };
  const toJSON = { toJSON() { invoked = true; return {}; } };
  const proxy = new Proxy({}, { ownKeys() { invoked = true; return []; } });
  for (const value of [undefined, NaN, Infinity, BigInt(1), Symbol('s'), () => 1, new Date(), new Map(),
    cycle, symbolKey, extraArray, nonEnumerable, getter, toJSON, proxy, [undefined], Array(1),
    JSON.parse('{"__proto__":{}}'), { constructor: 1 }, { prototype: 1 }, Object.create({ x: 1 })]) {
    assert.throws(() => hashValue(value), error => error instanceof GilError && error.code === 'CANONICAL_ERROR');
  }
  assert.equal(invoked, false);
  const ctx = context();
  assert.equal(validateInterpretation(getter as unknown as Interpretation, ctx)[0].code, 'CANONICAL_ERROR');
  assert.equal(invoked, false);
  const safe = Object.create(null); safe.x = 1; assert.equal(hashValue(safe), hashValue({ x: 1 }));
});

test('legacy Core canonical profile and known digest remain unchanged', () => {
  const doc = parse('spec s version "1" {}');
  const expected = '{"document":{"actions":[],"constraints":[],"context":[],"goals":[],"imports":[],"input":[],"kind":"spec","name":"s","state":[],"version":"1"},"profile":"gil-core-clinical-0.1"}';
  assert.equal(canonical(doc), expected);
  assert.equal(contentHash(doc), `sha256:${createHash('sha256').update(expected).digest('hex')}`);
  assert.notEqual(contentHash(doc), hashValue(doc));
});
