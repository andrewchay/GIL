import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { OpenAICompatibleProvider, parseModelJson } from '../src/agent-model-openai.ts';
import { GilError } from '../src/ast.ts';

const error = (code: string) => (e: unknown) => e instanceof GilError && e.code === code;

interface Captured { path: string; authorization: string | undefined; body: unknown }
type Handler = (req: IncomingMessage, raw: string) => { status: number; body: unknown };

async function withFakeOpenAI(handler: Handler, run: (url: string, requests: Captured[]) => Promise<void>): Promise<void> {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const out = await handler(req, raw);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  try { await run(`http://127.0.0.1:${address.port}/v1`, requests); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

const completion = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }] } });

const draft = {
  domain: 'clinical', goal: 'Prepare an internal review report', action: 'prepareReport',
  purpose: 'internal-review', fields: ['summary'], recipient: null, destination: 'internal',
  claim: { kind: 'Descriptive', fact: 'recordAbsent', causalDesign: null, uncertainty: 'None',
    uncertaintyMethod: 'None', requiresIndependentSources: false },
  requiredReviews: ['publication-review'],
};
const config = (baseUrl: string) => ({
  baseUrl, apiKey: 'sk-test-secret', model: 'test-model', timeoutMs: 500,
  claimContracts: { 'clinical:prepareReport': draft.claim },
  actionReviews: { prepareReport: ['publication-review'] },
});

test('happy path: prompt carries instruction, actions and mandated claim; key stays in the header', async () => {
  await withFakeOpenAI(() => completion(JSON.stringify(draft)), async (url, requests) => {
    const provider = new OpenAICompatibleProvider(config(url));
    const result = await provider.propose({ instruction: '准备一份内部审阅报告', domain: 'clinical', actions: ['prepareReport'] });
    assert.deepEqual(result, draft);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, 'Bearer sk-test-secret');
    const body = requests[0].body as { model: string; messages: { role: string; content: string }[] };
    assert.equal(body.model, 'test-model');
    assert.equal(body.messages[0].role, 'system');
    const user = body.messages[1].content;
    assert.match(user, /准备一份内部审阅报告/);
    assert.match(user, /mandatedClaimContracts/);
    assert.match(user, /publication-review/);
    // 提示词与请求体都不得包含 apiKey 以外的秘密泄露面：模型输入中没有事实与身份。
    assert.ok(!user.includes('sk-test-secret'));
    assert.ok(!body.messages[0].content.includes('sk-test-secret'));
  });
});

test('markdown fences and surrounding prose are stripped before JSON parsing', async () => {
  await withFakeOpenAI(() => completion('```json\n' + JSON.stringify(draft) + '\n```'), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    assert.deepEqual(await provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }), draft);
  });
  await withFakeOpenAI(() => completion('Here is the contract: ' + JSON.stringify(draft)), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    assert.deepEqual(await provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }), draft);
  });
});

test('HTTP errors surface as MODEL_UNAVAILABLE without leaking the key', async () => {
  await withFakeOpenAI(() => ({ status: 401, body: { error: 'bad key' } }), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    try { await provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }); assert.fail('expected throw'); }
    catch (e) {
      assert.ok(error('MODEL_UNAVAILABLE')(e));
      assert.match(e.message, /401/);
      assert.ok(!e.message.includes('sk-test-secret'));
    }
  });
});

test('non-JSON completions are rejected as MODEL_RESPONSE_INVALID', async () => {
  await withFakeOpenAI(() => completion('I cannot answer that.'), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    await assert.rejects(provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }),
      error('MODEL_RESPONSE_INVALID'));
  });
  await withFakeOpenAI(() => ({ status: 200, body: { choices: [] } }), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    await assert.rejects(provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }),
      error('MODEL_RESPONSE_INVALID'));
  });
  await withFakeOpenAI(() => ({ status: 200, body: { not: 'json' } }), async url => {
    const provider = new OpenAICompatibleProvider(config(url));
    await assert.rejects(provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }),
      error('MODEL_RESPONSE_INVALID'));
  });
});

test('a hung endpoint is bounded by timeoutMs and reported as MODEL_UNAVAILABLE', async () => {
  const server: Server = createServer(() => { /* 永不应答 */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' ? address.port : 0}/v1`;
  try {
    const provider = new OpenAICompatibleProvider({ ...config(url), timeoutMs: 150 });
    await assert.rejects(provider.propose({ instruction: 'x', domain: 'clinical', actions: ['prepareReport'] }),
      error('MODEL_UNAVAILABLE'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('constructor enforces https off loopback and rejects empty credentials', () => {
  assert.throws(() => new OpenAICompatibleProvider({ ...config('http://api.example.com/v1') }), error('INVALID_MODEL_CONFIG'));
  assert.throws(() => new OpenAICompatibleProvider({ ...config('https://api.example.com/v1'), apiKey: ' ' }), error('INVALID_MODEL_CONFIG'));
  assert.throws(() => new OpenAICompatibleProvider({ ...config('not a url') }), error('INVALID_MODEL_CONFIG'));
  assert.throws(() => new OpenAICompatibleProvider({ ...config('https://api.example.com/v1'), timeoutMs: 10 }), error('INVALID_MODEL_CONFIG'));
  // loopback http 允许（测试与本地网关）。
  assert.doesNotThrow(() => new OpenAICompatibleProvider(config('http://localhost:1234/v1')));
});

test('propose validates its own input before any network call', async () => {
  await withFakeOpenAI(() => completion(JSON.stringify(draft)), async (url, requests) => {
    const provider = new OpenAICompatibleProvider(config(url));
    await assert.rejects(provider.propose({ instruction: '', domain: 'clinical', actions: ['prepareReport'] }),
      error('INVALID_MODEL_INPUT'));
    await assert.rejects(provider.propose({ instruction: 'x', domain: 'clinical', actions: [] }),
      error('INVALID_MODEL_INPUT'));
    const getterInput: Record<string, unknown> = { instruction: 'x', actions: ['prepareReport'] };
    Object.defineProperty(getterInput, 'domain', { get() { return 'clinical'; }, enumerable: true });
    // hashValue 在 async 函数内同步抛出,经 await 变成 rejected promise。
    await assert.rejects(provider.propose(getterInput as never), GilError);
    assert.equal(requests.length, 0, 'no request may leave the process for invalid input');
  });
});

test('parseModelJson is exported for reuse and fails with a stable code', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseModelJson('no object at all'), error('MODEL_RESPONSE_INVALID'));
});
