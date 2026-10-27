import test from 'node:test';
import assert from 'node:assert/strict';
import { GilError } from '../src/ast.ts';
import { hashValue } from '../src/interpretation.ts';
import { createAssurance, issue, evaluate, revoke, challenge, attestationHash, inspect } from '../src/assurance.ts';
import type { Challenge } from '../src/assurance-ast.ts';

// 全部为合成摘要与合成身份；测试不对应任何真实认证或监管结论。
const H = (label: string): string => hashValue({ synthetic: label });
const evidence = H('evidence-v1'), target = H('target-v1'), requirement = H('requirement-v1');
const context = H('context-v1'), spec = H('spec-v1');

const isError = (code: string) => (error: unknown): boolean => error instanceof GilError && error.code === code;

function fixture(overrides: Record<string, unknown> = {}) {
  let time = 1000;
  const config = { now: () => time, verifierId: 'cra-1', verifierRole: 'CRA', submitterId: 'coord-1',
    specHash: spec, method: 'HumanReview', methodVersion: '1.0', ...overrides };
  const registry = createAssurance(config as never);
  return { registry, at: (value: number) => { time = value; } };
}
function baseInput(overrides: Record<string, unknown> = {}) {
  return { evidenceHash: evidence, targetHash: target, requirementHash: requirement, contextHash: context,
    coverage: ['REQ-1', 'REQ-2'], assumptions: ['synthetic only'], validUntil: 2000, result: 'Pass', ...overrides };
}
function bindings(overrides: Record<string, unknown> = {}) {
  return { targetHash: target, contextHash: context, specHash: spec, evidenceHash: evidence, ...overrides };
}
function issued(overrides: Record<string, unknown> = {}) {
  const f = fixture();
  const attestation = issue(f.registry, baseInput(overrides) as never);
  return { ...f, attestation, hash: attestationHash(attestation) };
}

test('人员隔离：提交者不能同时作为 CRA 签发者，其他角色不得签发', () => {
  assert.throws(() => fixture({ submitterId: 'cra-1' }), isError('PERSON_SEPARATION'));
  assert.throws(() => fixture({ verifierRole: 'Coordinator' }), isError('ISSUER_NOT_CRA'));
  assert.throws(() => fixture({ verifierId: '' }), isError('INVALID_CONFIG'));
  assert.throws(() => fixture({ method: 'SelfAttest' }), isError('INVALID_METHOD'));
  assert.throws(() => fixture({ extra: 'x' }), isError('INVALID_CONFIG'));
  // 配置只读，无法在运行期把签发者改成上传者。
  const f = fixture();
  assert.equal(Object.isFrozen(f.registry), true);
});

test('签发校验：有效期、覆盖范围与结果取值', () => {
  const f = fixture();
  assert.throws(() => issue(f.registry, baseInput({ validUntil: 1000 }) as never), isError('INVALID_VALIDITY'));
  assert.throws(() => issue(f.registry, baseInput({ validUntil: Number.NaN }) as never), isError('INVALID_VALIDITY'));
  assert.throws(() => issue(f.registry, baseInput({ coverage: [] }) as never), isError('INVALID_COVERAGE'));
  assert.throws(() => issue(f.registry, baseInput({ coverage: ['REQ-1', 'REQ-1'] }) as never), isError('DUPLICATE_COVERAGE'));
  assert.throws(() => issue(f.registry, baseInput({ coverage: ['REQ-1', ''] }) as never), isError('INVALID_COVERAGE'));
  assert.throws(() => issue(f.registry, baseInput({ result: 'Maybe' }) as never), isError('INVALID_RESULT'));
  assert.throws(() => issue(f.registry, baseInput({ evidenceHash: '' }) as never), isError('INVALID_ATTESTATION'));
  const attestation = issue(f.registry, baseInput() as never);
  assert.equal(Object.isFrozen(attestation), true);
  assert.equal(Object.isFrozen(attestation.coverage), true);
  assert.equal(attestation.verifierId, 'cra-1');
  assert.equal(attestation.specHash, spec);
  assert.equal(Object.isFrozen(inspect(f.registry, attestationHash(attestation)).attestation), true);
});

test('省略 targetHash 时绑定证据摘要，不留未绑定凭证', () => {
  const f = fixture();
  const attestation = issue(f.registry, baseInput({ targetHash: undefined }) as never);
  assert.equal(attestation.targetHash, evidence);
  assert.equal(evaluate(f.registry, attestationHash(attestation), bindings({ targetHash: evidence }) as never).result, 'Pass');
});

test('Pass 在证据哈希变化后降级为 Unknown，原始结论仍可审计', () => {
  const { registry, hash } = issued();
  assert.deepEqual(evaluate(registry, hash, bindings() as never), { result: 'Pass', active: true, reasons: [] });
  assert.deepEqual(evaluate(registry, hash, bindings({ evidenceHash: H('evidence-v2') }) as never),
    { result: 'Unknown', active: false, reasons: ['EVIDENCE_CHANGED'] });
  assert.equal(inspect(registry, hash).attestation.result, 'Pass');
});

test('到期边界 now >= validUntil 即失效', () => {
  const { registry, hash, at } = issued();
  at(1999);
  assert.equal(evaluate(registry, hash, bindings() as never).active, true);
  at(2000);
  assert.deepEqual(evaluate(registry, hash, bindings() as never), { result: 'Unknown', active: false, reasons: ['EXPIRED'] });
});

test('spec、target、context 变化分别给出原因，且可叠加', () => {
  const { registry, hash } = issued();
  assert.deepEqual(evaluate(registry, hash, bindings({ specHash: H('spec-v2') }) as never).reasons, ['SPEC_CHANGED']);
  assert.deepEqual(evaluate(registry, hash, bindings({ targetHash: H('target-v2') }) as never).reasons, ['TARGET_MISMATCH']);
  assert.deepEqual(evaluate(registry, hash, bindings({ contextHash: H('context-v2') }) as never).reasons, ['CONTEXT_MISMATCH']);
  const all = evaluate(registry, hash, bindings({ specHash: H('spec-v2'), targetHash: H('target-v2'),
    contextHash: H('context-v2'), evidenceHash: H('evidence-v2') }) as never);
  assert.deepEqual(all, { result: 'Unknown', active: false,
    reasons: ['SPEC_CHANGED', 'TARGET_MISMATCH', 'CONTEXT_MISMATCH', 'EVIDENCE_CHANGED'] });
});

test('Fail 与 Unknown 不算通过，即使绑定全部有效', () => {
  const failed = issued({ result: 'Fail' });
  assert.deepEqual(evaluate(failed.registry, failed.hash, bindings() as never), { result: 'Fail', active: true, reasons: [] });
  const unknown = issued({ result: 'Unknown' });
  assert.deepEqual(evaluate(unknown.registry, unknown.hash, bindings() as never), { result: 'Unknown', active: true, reasons: [] });
  for (const hash of [failed.hash, unknown.hash]) {
    const actual = hash === failed.hash ? evaluate(failed.registry, hash, bindings() as never) : evaluate(unknown.registry, hash, bindings() as never);
    assert.notEqual(actual.result, 'Pass');
  }
});

test('撤销幂等，且只允许配置的 CRA 执行', () => {
  const { registry, attestation, hash } = issued();
  assert.throws(() => revoke(registry, attestation.id, 'agent-1'), isError('REVOKE_FORBIDDEN'));
  assert.throws(() => revoke(registry, attestation.id, 'coord-1'), isError('REVOKE_FORBIDDEN'));
  assert.throws(() => revoke(registry, attestation.id, ''), isError('REVOKE_FORBIDDEN'));
  assert.throws(() => revoke(registry, 'att-unknown', 'cra-1'), isError('UNKNOWN_ATTESTATION'));
  assert.deepEqual(revoke(registry, attestation.id, 'cra-1'), { attestationId: attestation.id, revoked: true, alreadyRevoked: false });
  assert.deepEqual(revoke(registry, attestation.id, 'cra-1'), { attestationId: attestation.id, revoked: true, alreadyRevoked: true });
  assert.deepEqual(evaluate(registry, hash, bindings() as never), { result: 'Unknown', active: false, reasons: ['REVOKED'] });
  const view = inspect(registry, hash);
  assert.equal(view.revoked, true);
  assert.equal(view.revokedBy, 'cra-1');
  assert.equal(view.attestation.result, 'Pass');
});

test('有效挑战使凭证永久失效，历史全部保留', () => {
  const { registry, attestation, hash } = issued();
  const raise = (patch: Record<string, unknown> = {}): Challenge => ({ kind: 'challenge', id: 'ch-1', version: '1',
    targetAttestationId: attestation.id, targetHash: target, reason: 'synthetic conflict', raisedBy: 'ctm-1', at: 1200, ...patch }) as Challenge;
  assert.throws(() => challenge(registry, raise({ targetHash: H('other') })), isError('CHALLENGE_MISMATCH'));
  assert.throws(() => challenge(registry, raise({ targetAttestationId: 'att-unknown' })), isError('UNKNOWN_ATTESTATION'));
  assert.throws(() => challenge(registry, raise({ raisedBy: 'cra-1' })), isError('CHALLENGE_SEPARATION'));
  assert.throws(() => challenge(registry, raise({ at: 999 })), isError('INVALID_CHALLENGE'));
  assert.throws(() => challenge(registry, raise({ kind: 'objection' })), isError('INVALID_CHALLENGE'));
  assert.throws(() => challenge(registry, raise({ extra: true })), isError('INVALID_CHALLENGE'));
  assert.deepEqual(challenge(registry, raise()), { id: 'ch-1', targetAttestationId: attestation.id, alreadyRaised: false });
  assert.deepEqual(challenge(registry, raise()), { id: 'ch-1', targetAttestationId: attestation.id, alreadyRaised: true });
  challenge(registry, raise({ id: 'ch-2', at: 1300 }));
  assert.deepEqual(evaluate(registry, hash, bindings() as never), { result: 'Unknown', active: false, reasons: ['CHALLENGED'] });
  const view = inspect(registry, hash);
  assert.equal(view.challenges.length, 2);
  assert.equal(view.attestation.result, 'Pass');
  assert.equal(view.revoked, false);
});

test('历史不可篡改：evaluate 只读，记录与摘要保持稳定', () => {
  const { registry, hash } = issued();
  const before = inspect(registry, hash);
  const first = evaluate(registry, hash, bindings() as never);
  const second = evaluate(registry, hash, bindings() as never);
  assert.deepEqual(first, second);
  const after = inspect(registry, hash);
  assert.equal(after.hash, before.hash);
  assert.deepEqual(after.attestation, before.attestation);
  assert.throws(() => { (before.attestation.coverage as string[]).push('REQ-3'); }, TypeError);
  assert.throws(() => { (before.challenges as Challenge[]).push({} as Challenge); }, TypeError);
  assert.throws(() => { (before as { revoked: boolean }).revoked = true; }, TypeError);
});

test('JSON 伪造的 attestation 不被 evaluate 接受', () => {
  const { registry, attestation, hash } = issued();
  const forged = JSON.parse(JSON.stringify(attestation));
  forged.result = 'Fail';
  assert.notEqual(attestationHash(forged), hash);
  assert.throws(() => evaluate(registry, attestationHash(forged), bindings() as never), isError('UNKNOWN_ATTESTATION'));
  const extended = { ...JSON.parse(JSON.stringify(attestation)), validUntil: 9000 };
  assert.throws(() => evaluate(registry, attestationHash(extended), bindings() as never), isError('UNKNOWN_ATTESTATION'));
  const reassigned = { ...JSON.parse(JSON.stringify(attestation)), verifierId: 'agent-1' };
  assert.throws(() => evaluate(registry, attestationHash(reassigned), bindings() as never), isError('UNKNOWN_ATTESTATION'));
  assert.throws(() => evaluate(registry, H('made-up'), bindings() as never), isError('UNKNOWN_ATTESTATION'));
  assert.throws(() => evaluate({ kind: 'assurance-registry' } as never, hash, bindings() as never), isError('UNTRUSTED_REGISTRY'));
  assert.throws(() => attestationHash({ ...JSON.parse(JSON.stringify(attestation)), extra: true }), isError('INVALID_ATTESTATION'));
});

test('拒绝 Proxy、getter、危险键与非法绑定输入', () => {
  const withGetter = { now: () => 1000, verifierId: 'cra-1', verifierRole: 'CRA', submitterId: 'coord-1',
    get specHash(): string { throw new Error('getter must not run'); }, method: 'HumanReview', methodVersion: '1.0' };
  assert.throws(() => createAssurance(withGetter as never), isError('INVALID_CONFIG'));
  assert.throws(() => createAssurance(new Proxy({ now: () => 1000, verifierId: 'cra-1' },
    { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } }) as never), isError('INVALID_CONFIG'));
  assert.throws(() => fixture({ now: new Proxy(() => 1000, {}) }), isError('INVALID_CLOCK'));
  const f = fixture();
  assert.throws(() => issue(f.registry, baseInput({ coverage: new Proxy(['REQ-1'], {}) }) as never), isError('INVALID_COVERAGE'));
  const attestation = issue(f.registry, baseInput() as never);
  const hash = attestationHash(attestation);
  assert.throws(() => evaluate(f.registry, hash, new Proxy(bindings(), { get() { throw new Error('trap'); } }) as never), isError('INVALID_CONTEXT'));
  assert.throws(() => evaluate(f.registry, hash, { ...bindings(), extra: 'x' } as never), isError('INVALID_CONTEXT'));
  assert.throws(() => evaluate(f.registry, hash, bindings({ specHash: 1 }) as never), isError('INVALID_CONTEXT'));
  assert.throws(() => evaluate(f.registry, '' as never, bindings() as never), isError('INVALID_HASH'));
  const dangerous = JSON.parse('{"evidenceHash":"e","requirementHash":"r","contextHash":"c","coverage":["x"],'
    + '"assumptions":[],"validUntil":3000,"result":"Pass","__proto__":{"polluted":true}}');
  assert.throws(() => issue(f.registry, dangerous as never), isError('INVALID_ATTESTATION'));
});

test('时钟必须单调，回退被拒绝', () => {
  const { registry, hash, at } = issued();
  at(500);
  assert.throws(() => evaluate(registry, hash, bindings() as never), isError('INVALID_CLOCK'));
});

test('ReviewInput 视图只暴露审计所需哈希，不携带签发权威', () => {
  const { registry, hash, attestation } = issued();
  const view = inspect(registry, hash);
  assert.deepEqual(view.review, { evidenceHash: evidence, attestationId: attestation.id,
    requirementHash: requirement, specHash: spec });
  assert.equal(hash, view.hash);
  assert.throws(() => inspect(registry, H('made-up')), isError('UNKNOWN_ATTESTATION'));
});
