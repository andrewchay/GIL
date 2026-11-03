import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/agent-sdk.ts';
import { createAgentHTTP } from '../src/agent-http.ts';
import { demoHost, scenario } from '../src/agent-demo.ts';

async function start(){
  const service=new AgentService(demoHost());
  const server=createAgentHTTP({service,tokens:{'test-agent':'agent','test-owner':'owner','test-reviewer':'reviewer'},
    snapshots:{clinical:scenario('clinical').snapshot,growth:scenario('growth').snapshot}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();if(!address||typeof address==='string')throw Error('bad address');
  return {server,base:`http://127.0.0.1:${address.port}`};
}
async function request(base:string,path:string,token:string,data?:unknown,headers:Record<string,string>={}){
  const r=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,data:await r.json() as any};
}
test('HTTP runs both offline domains with token-bound human decisions',async()=>{
  const {server,base}=await start();try{
    for(const domain of ['clinical','growth'] as const){
      const f=scenario(domain);const p=await request(base,'/v1/proposals','test-agent',{instruction:'prepare internal report',domain,draft:f.draft,snapshotId:domain});
      assert.equal(p.status,201);let v=p.data.view;const path=`/v1/contracts/${v.id}`;
      v=(await request(base,path+'/answer','test-owner',{binding:v.binding,recipient:'internal-reviewers'})).data;
      v=(await request(base,path+'/accept','test-owner',{binding:v.binding})).data;
      v=(await request(base,path+'/approve','test-reviewer',{binding:v.binding,review:'publication-review'})).data;
      const out=await request(base,path+'/execute','test-agent',{binding:v.binding,idempotencyKey:domain});
      assert.equal(out.data.status,'Succeeded');assert.equal(out.data.verified,true);
      assert.equal((await request(base,path,'test-agent')).data.productionAuthorization,false);
    }
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('HTTP rejects missing token, actor spoofing, client snapshot and browser origin',async()=>{
  const {server,base}=await start();try{
    assert.equal((await request(base,'/v1/proposals','bad',{})).status,401);
    const f=scenario('clinical'),payload={instruction:'x',domain:'clinical',draft:f.draft,snapshotId:'clinical'};
    assert.equal((await request(base,'/v1/proposals','test-agent',{...payload,actor:'owner'})).data.code,'INVALID_REQUEST');
    assert.equal((await request(base,'/v1/proposals','test-agent',{...payload,snapshot:f.snapshot})).data.code,'INVALID_REQUEST');
    assert.equal((await request(base,'/v1/proposals','test-agent',payload,{origin:'https://evil.example'})).status,401);
    const v=(await request(base,'/v1/proposals','test-agent',payload)).data.view;
    assert.equal((await request(base,`/v1/contracts/${v.id}/answer`,'test-agent',{binding:v.binding,recipient:'internal-reviewers'})).data.code,'HUMAN_REQUIRED');
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('HTTP rejects oversized/malformed JSON and no public snapshot replacement endpoint',async()=>{
  const {server,base}=await start();try{
    const big=await request(base,'/v1/proposals','test-agent',{text:'x'.repeat(70000)});assert.equal(big.status,413);
    const invalid=await fetch(base+'/v1/proposals',{method:'POST',headers:{authorization:'Bearer test-agent','content-type':'application/json'},body:'{'});
    assert.equal((await invalid.json() as any).code,'INVALID_REQUEST');
    assert.equal((await request(base,'/v1/snapshots','test-agent',{})).status,404);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('live model route: configured provider is used, absent provider returns 501', async () => {
  const f = scenario('clinical');
  const base = { tokens: { 'test-agent': 'agent', 'test-owner': 'owner', 'test-reviewer': 'reviewer' },
    snapshots: { clinical: f.snapshot } };
  // 1) 未配置 → 501 MODEL_NOT_CONFIGURED
  const plain = createAgentHTTP({ service: new AgentService(demoHost()), ...base });
  await new Promise<void>(r => plain.listen(0, '127.0.0.1', r));
  const a = plain.address(); const base1 = `http://127.0.0.1:${typeof a === 'object' ? a.port : 0}`;
  try {
    const out = await request(base1, '/v1/proposals/live', 'test-agent',
      { instruction: 'x', domain: 'clinical', snapshotId: 'clinical' });
    assert.equal(out.status, 501);
    assert.equal(out.data.code, 'MODEL_NOT_CONFIGURED');
  } finally { await new Promise<void>(r => plain.close(() => r())); }
  // 2) 已配置（stub provider）→ 201，且模型收不到事实/身份
  let seen: unknown;
  const live = { async propose(input: unknown) { seen = input; return f.draft; } };
  const withLive = createAgentHTTP({ service: new AgentService(demoHost()), ...base, liveModel: live });
  await new Promise<void>(r => withLive.listen(0, '127.0.0.1', r));
  const b = withLive.address(); const base2 = `http://127.0.0.1:${typeof b === 'object' ? b.port : 0}`;
  try {
    const out = await request(base2, '/v1/proposals/live', 'test-agent',
      { instruction: 'prepare the internal review', domain: 'clinical', snapshotId: 'clinical' });
    assert.equal(out.status, 201);
    assert.equal(out.data.modelMode, 'live-openai-compatible');
    assert.deepEqual(Object.keys(seen as object), ['instruction', 'domain', 'actions']);
    assert.deepEqual((seen as { actions: string[] }).actions, ['prepareReport']);
    assert.equal(out.data.view.questions.length, 1, 'recipient null in draft raises clarification');
  } finally { await new Promise<void>(r => withLive.close(() => r())); }
});
