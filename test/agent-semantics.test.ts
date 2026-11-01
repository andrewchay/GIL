import test from 'node:test';
import assert from 'node:assert/strict';
import { GilError } from '../src/ast.ts';
import { validateSnapshot, validateClaim, evaluateSnapshot } from '../src/agent-semantics.ts';
import type { Snapshot, Claim, SnapshotObservation } from '../src/agent-semantics.ts';

const snapshot = (observation: Partial<SnapshotObservation> = {}, rest: Partial<Snapshot> = {}): Snapshot => ({
  facts: { ready: true, rejected: false, count: 3, label: 'synthetic' },
  conflicts: [],
  observation: {
    readability: 'Available', completeness: 'Complete', searched: true, matches: 1,
    mappingValid: true, applicable: true, windowMature: true, scopeCovered: true,
    watermarkCovered: true, closureBasis: 'synthetic complete registry', ...observation,
  },
  lineageRoots: ['root-a', 'root-b'], ...rest,
});
const claim = (rest: Partial<Claim> = {}): Claim => ({
  kind: 'Descriptive', fact: 'ready', causalDesign: null, uncertainty: 'None',
  uncertaintyMethod: 'None', requiresIndependentSources: false, ...rest,
});
const rejected = (fn: () => unknown, code: string): void => {
  assert.throws(fn, (error: unknown) => error instanceof GilError && error.code === code);
};

test('validators detach input and deeply freeze all output containers', () => {
  const input = snapshot(), inputClaim = claim();
  const valid = validateSnapshot(input), validClaim = validateClaim(inputClaim);
  assert.notEqual(valid, input);
  assert.notEqual(valid.facts, input.facts);
  for (const container of [valid, valid.facts, valid.observation, valid.conflicts, valid.lineageRoots, validClaim]) {
    assert.equal(Object.isFrozen(container), true);
  }
  assert.equal(Object.isFrozen(input), false);
  (input.facts as Record<string, boolean>).ready = false;
  assert.equal(valid.facts.ready, true);
  assert.notEqual(validClaim, inputClaim);
});

test('boolean facts produce True and False; missing facts stay Unknown', () => {
  assert.equal(evaluateSnapshot(snapshot(), claim()).truth, 'True');
  assert.equal(evaluateSnapshot(snapshot(), claim({ fact: 'rejected' })).truth, 'False');
  assert.equal(evaluateSnapshot(snapshot(), claim({ fact: 'missing' })).truth, 'Unknown');
  assert.equal(evaluateSnapshot(snapshot(), claim({ fact: 'toString' })).truth, 'Unknown');
});

test('numeric and text values never coerce to boolean truth', () => {
  for (const fact of ['count', 'label']) rejected(() => evaluateSnapshot(snapshot(), claim({ fact })), 'TYPE_ERROR');
  rejected(() => evaluateSnapshot(snapshot({}, { conflicts: ['count'] }), claim({ fact: 'count' })), 'TYPE_ERROR');
});

test('recordAbsent derives True only from closed zero-match observations', () => {
  const report = evaluateSnapshot(snapshot({ matches: 0 }, { facts: { recordAbsent: false } }), claim({ fact: 'recordAbsent' }));
  assert.deepEqual(report, { truth: 'True', observation: 'ConfirmedAbsent', issues: [], reviewRequired: false });
});

test('valid hits disprove recordAbsent and count as Observed', () => {
  assert.deepEqual(evaluateSnapshot(snapshot({}, { facts: { recordAbsent: true } }), claim({ fact: 'recordAbsent' })),
    { truth: 'False', observation: 'Observed', issues: [], reviewRequired: false });
  assert.equal(evaluateSnapshot(snapshot({ readability: 'Partial', completeness: 'Partial' }), claim()).observation, 'Observed');
});

test('every closure prerequisite is required for confirmed absence', () => {
  const openCases: Partial<SnapshotObservation>[] = [
    { readability: 'Partial' }, { completeness: 'Partial' }, { completeness: 'Unknown' },
    { windowMature: false }, { scopeCovered: false }, { watermarkCovered: false },
    { closureBasis: null }, { closureBasis: '' }, { closureBasis: '   ' },
  ];
  for (const delta of openCases) {
    const report = evaluateSnapshot(snapshot({ matches: 0, ...delta }), claim({ fact: 'recordAbsent' }));
    assert.equal(report.observation, 'NotObserved', JSON.stringify(delta));
    assert.equal(report.truth, 'Unknown');
  }
});

test('unreadable, unsearched, invalid mapping and inapplicable observations override hits', () => {
  for (const delta of [{ readability: 'Unavailable' as const }, { searched: false },
    { mappingValid: false }, { applicable: false }]) {
    const report = evaluateSnapshot(snapshot(delta), claim({ fact: 'recordAbsent' }));
    assert.equal(report.observation, 'UnableToDetermine');
    assert.equal(report.truth, 'Unknown');
  }
});

test('observation availability does not overwrite an explicit boolean fact', () => {
  const report = evaluateSnapshot(snapshot({ searched: false }), claim());
  assert.equal(report.truth, 'True');
  assert.equal(report.observation, 'UnableToDetermine');
});

test('current fact and recordAbsent conflicts suspend truth and observation and require review', () => {
  for (const conflicts of [['ready'], ['recordAbsent'], ['ready', 'recordAbsent']]) {
    assert.deepEqual(evaluateSnapshot(snapshot({}, { conflicts }), claim()),
      { truth: 'Unknown', observation: 'UnableToDetermine', issues: ['INPUT_CONFLICT'], reviewRequired: true });
  }
  assert.equal(evaluateSnapshot(snapshot({ matches: 0 }, { conflicts: ['recordAbsent'] }),
    claim({ fact: 'recordAbsent' })).truth, 'Unknown');
});

test('unrelated conflicts do not block truth, observations or review', () => {
  assert.deepEqual(evaluateSnapshot(snapshot({}, { conflicts: ['other'] }), claim()),
    { truth: 'True', observation: 'Observed', issues: [], reviewRequired: false });
  assert.equal(evaluateSnapshot(snapshot({ matches: 0 }, { conflicts: ['other'] }),
    claim({ fact: 'recordAbsent' })).observation, 'ConfirmedAbsent');
});

test('causal design is a structural requirement, not a proof', () => {
  for (const causalDesign of [null, '', ' ']) {
    const report = evaluateSnapshot(snapshot(), claim({ kind: 'Causal', causalDesign }));
    assert.deepEqual(report.issues, ['IDENTIFICATION_REQUIRED']);
    assert.equal(report.truth, 'True');
    assert.equal(report.reviewRequired, true);
  }
  assert.deepEqual(evaluateSnapshot(snapshot(), claim({ kind: 'Causal', causalDesign: 'unverified design' })).issues, []);
});

test('a scenario envelope cannot masquerade as a confidence interval', () => {
  assert.deepEqual(evaluateSnapshot(snapshot(), claim({ uncertainty: 'ConfidenceInterval', uncertaintyMethod: 'Envelope' })).issues,
    ['UNCERTAINTY_KIND_MISMATCH']);
  assert.deepEqual(evaluateSnapshot(snapshot(), claim({ uncertainty: 'ConfidenceInterval', uncertaintyMethod: 'Statistical' })).issues, []);
  assert.deepEqual(evaluateSnapshot(snapshot(), claim({ uncertainty: 'ScenarioEnvelope', uncertaintyMethod: 'Envelope' })).issues, []);
});

test('independence checks unique lineage roots rather than the number of copies', () => {
  for (const lineageRoots of [[], ['one'], ['one', 'one']]) {
    assert.deepEqual(evaluateSnapshot(snapshot({}, { lineageRoots }), claim({ requiresIndependentSources: true })).issues,
      ['SHARED_SOURCE_ROOT']);
  }
  assert.deepEqual(evaluateSnapshot(snapshot(), claim({ requiresIndependentSources: true })).issues, []);
  assert.deepEqual(evaluateSnapshot(snapshot({}, { lineageRoots: ['one'] }), claim()).issues, []);
});

test('issues accumulate independently and the report is deeply frozen', () => {
  const report = evaluateSnapshot(snapshot({}, { conflicts: ['ready'], lineageRoots: ['same', 'same'] }),
    claim({ kind: 'Causal', uncertainty: 'ConfidenceInterval', uncertaintyMethod: 'Envelope', requiresIndependentSources: true }));
  assert.deepEqual(report.issues, ['INPUT_CONFLICT', 'IDENTIFICATION_REQUIRED', 'UNCERTAINTY_KIND_MISMATCH', 'SHARED_SOURCE_ROOT']);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.issues), true);
});

test('strict shape rejects additional and missing fields', () => {
  rejected(() => validateSnapshot({ ...snapshot(), extra: true }), 'INVALID_SNAPSHOT');
  rejected(() => validateSnapshot(snapshot({ extra: true } as Partial<SnapshotObservation>)), 'INVALID_SNAPSHOT');
  rejected(() => validateSnapshot({ facts: {}, conflicts: [], observation: snapshot().observation }), 'INVALID_SNAPSHOT');
  rejected(() => validateClaim({ ...claim(), extra: true }), 'INVALID_CLAIM');
  const { causalDesign: _unused, ...missing } = claim();
  rejected(() => validateClaim(missing), 'INVALID_CLAIM');
});

test('invalid primitive, enum, list and record shapes are rejected', () => {
  for (const bad of [null, [], { ...snapshot(), facts: { ready: null } },
    { ...snapshot(), conflicts: [1] }, { ...snapshot(), lineageRoots: [false] },
    snapshot({ readability: 'unknown' } as unknown as Partial<SnapshotObservation>),
    snapshot({ searched: 'yes' } as unknown as Partial<SnapshotObservation>)]) {
    rejected(() => validateSnapshot(bad), 'INVALID_SNAPSHOT');
  }
  for (const bad of [null, [], { ...claim(), fact: '' }, { ...claim(), kind: 'Invalid' },
    { ...claim(), uncertainty: 'Invalid' }, { ...claim(), uncertaintyMethod: 'Invalid' },
    { ...claim(), requiresIndependentSources: 1 }, { ...claim(), causalDesign: false }]) {
    rejected(() => validateClaim(bad), 'INVALID_CLAIM');
  }
});

test('negative, fractional and unsafe matches are rejected', () => {
  for (const matches of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    rejected(() => validateSnapshot(snapshot({ matches })), 'INVALID_SNAPSHOT');
  }
});

test('non-finite numbers are rejected before shape validation', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    rejected(() => validateSnapshot(snapshot({}, { facts: { value } })), 'CANONICAL_ERROR');
    rejected(() => validateSnapshot(snapshot({ matches: value })), 'CANONICAL_ERROR');
  }
});

test('proxy inputs and nested proxies are rejected without invoking traps', () => {
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps++; throw new Error('trap executed'); },
    get() { traps++; throw new Error('trap executed'); }, getPrototypeOf() { traps++; throw new Error('trap executed'); } });
  rejected(() => validateSnapshot(proxy), 'CANONICAL_ERROR');
  rejected(() => validateSnapshot({ ...snapshot(), facts: proxy }), 'CANONICAL_ERROR');
  rejected(() => validateClaim(proxy), 'CANONICAL_ERROR');
  assert.equal(traps, 0);
});

test('getters and toJSON are rejected without executing user code', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'ready', { enumerable: true, get() { calls++; return true; } });
  rejected(() => validateSnapshot({ ...snapshot(), facts: getter }), 'CANONICAL_ERROR');
  const claimGetter = Object.defineProperty({ ...claim() }, 'fact', { enumerable: true, get() { calls++; return 'ready'; } });
  rejected(() => validateClaim(claimGetter), 'CANONICAL_ERROR');
  rejected(() => validateSnapshot({ ...snapshot(), toJSON() { calls++; return snapshot(); } }), 'CANONICAL_ERROR');
  assert.equal(calls, 0);
});

test('dangerous keys, symbols, hidden fields and non-plain objects are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const facts = JSON.parse(`{"${key}":true}`);
    rejected(() => validateSnapshot({ ...snapshot(), facts }), 'CANONICAL_ERROR');
  }
  rejected(() => validateClaim({ ...claim(), [Symbol('hidden')]: 1 }), 'CANONICAL_ERROR');
  rejected(() => validateClaim(Object.defineProperty({ ...claim() }, 'hidden', { value: 1 })), 'CANONICAL_ERROR');
  rejected(() => validateSnapshot({ ...snapshot(), facts: new Date() }), 'CANONICAL_ERROR');
});

test('sparse arrays, array properties, cycles and undefined cannot pass as JSON', () => {
  rejected(() => validateSnapshot({ ...snapshot(), conflicts: new Array(2) }), 'CANONICAL_ERROR');
  const roots = Object.assign(['root'], { extra: true });
  rejected(() => validateSnapshot({ ...snapshot(), lineageRoots: roots }), 'CANONICAL_ERROR');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  rejected(() => validateSnapshot({ ...snapshot(), facts: cyclic }), 'CANONICAL_ERROR');
  rejected(() => validateClaim({ ...claim(), causalDesign: undefined }), 'CANONICAL_ERROR');
});

test('all five claim kinds validate and synthetic JSON roundtrips retain evaluation', () => {
  for (const kind of ['Descriptive', 'Associational', 'Causal', 'Predictive', 'Normative'] as const) {
    assert.equal(validateClaim(claim({ kind })).kind, kind);
  }
  const original = snapshot({ matches: 0 });
  const absentClaim = claim({ fact: 'recordAbsent' });
  assert.deepEqual(evaluateSnapshot(JSON.parse(JSON.stringify(original)), JSON.parse(JSON.stringify(absentClaim))),
    evaluateSnapshot(original, absentClaim));
});
