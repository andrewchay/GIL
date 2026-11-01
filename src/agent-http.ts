import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AgentService, FixtureModel } from './agent-sdk.ts';
import { hashValue } from './interpretation.ts';
import { GilError } from './ast.ts';

export interface HTTPOptions {
  service: AgentService;
  /** Tokens are supplied by the host, never body actor IDs. Demo only, not an IdP. */
  tokens: Record<string, string>;
  /** Host-ingested snapshots; clients/models cannot self-report execution facts. */
  snapshots: Record<string, unknown>;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new GilError('INVALID_REQUEST', 'JSON content type required');
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of req) {
    size += part.length;
    if (size > 65536) throw new GilError('BODY_TOO_LARGE', 'Maximum body is 64KiB');
    chunks.push(part);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GilError('INVALID_REQUEST', 'Invalid JSON'); }
  hashValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GilError('INVALID_REQUEST', 'Object body required');
  return value as Record<string, unknown>;
}
function exact(r: Record<string, unknown>, keys: string[]) {
  if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(r,k))) throw new GilError('INVALID_REQUEST','Exact request fields required');
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new GilError('INVALID_REQUEST','Nonempty string required'); return value;
}
export function createAgentHTTP(options: HTTPOptions) {
  hashValue(options.tokens); hashValue(options.snapshots);
  const snapshots = structuredClone(options.snapshots);
  const credentials = Object.entries(options.tokens);
  if (!credentials.length || credentials.some(([t,p]) => !t || !p)) throw new GilError('INVALID_HOST','Explicit token map required');
  const server = createServer(async (req,res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200,{ ok:true, mode:'process-local-simulation', productionAuthorization:false });
      // Deny browser cross-origin writes even if localhost token is leaked into a web page.
      if (req.headers.origin) throw new GilError('AUTH_REQUIRED','Browser origins are not accepted');
      const token = req.headers.authorization?.replace(/^Bearer /,'') ?? '';
      const actor = credentials.find(([expected]) => {
        const a=Buffer.from(expected), b=Buffer.from(token); return a.length===b.length && timingSafeEqual(a,b);
      })?.[1];
      if (!actor) throw new GilError('AUTH_REQUIRED','Host-configured bearer token required');
      const match = /^\/v1\/contracts\/([^/]+)(?:\/(answer|accept|approve|execute|reconcile))?$/.exec(req.url ?? '');
      if (req.method==='GET' && match && !match[2]) return send(200,options.service.get(match[1]));
      if (req.method!=='POST') return send(404,{ok:false,code:'NOT_FOUND'});
      const r = await body(req);
      if (req.url==='/v1/proposals') {
        exact(r,['instruction','domain','draft','snapshotId']);
        const snapshotId = string(r.snapshotId);
        if (!Object.hasOwn(snapshots, snapshotId)) throw new GilError('INVALID_REQUEST','Unknown host snapshot');
        // Fixture is labeled; this endpoint does not pretend to call a live LLM.
        const view = await options.service.propose(actor,string(r.instruction),snapshots[snapshotId],string(r.domain),new FixtureModel(r.draft));
        return send(201,{ modelMode:'offline-fixture', view });
      }
      if (!match || !match[2]) return send(404,{ok:false,code:'NOT_FOUND'});
      const [,id,op] = match;
      let result: unknown;
      if (op==='answer') { exact(r,['binding','recipient']); result=options.service.answer(actor,id,string(r.binding),r.recipient); }
      else if (op==='accept') { exact(r,['binding']); result=options.service.accept(actor,id,string(r.binding)); }
      else if (op==='approve') { exact(r,['binding','review']); result=options.service.approve(actor,id,string(r.binding),string(r.review)); }
      else { exact(r,['binding','idempotencyKey']); result=op==='execute'
        ? await options.service.execute(actor,id,string(r.binding),string(r.idempotencyKey))
        : await options.service.reconcile(actor,id,string(r.binding),string(r.idempotencyKey)); }
      send(200,result);
    } catch(error) {
      const code=error instanceof GilError ? error.code : 'INTERNAL_ERROR';
      const status=code==='AUTH_REQUIRED'?401:code==='NOT_FOUND'?404:code==='BODY_TOO_LARGE'?413:400;
      send(status,{ok:false,code,message:error instanceof GilError?error.message:'Unexpected internal error'});
    }
  });
  server.requestTimeout=5000; server.headersTimeout=5000;
  return server;
}
