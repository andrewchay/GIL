import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService, FixtureModel } from '../src/agent-sdk.ts';
import type { ActionAdapter } from '../src/agent-sdk.ts';
import { scenario, demoHost, agentDemo } from '../src/agent-demo.ts';
import { GilError } from '../src/ast.ts';

const error = (code: string) => (e: unknown) => e instanceof GilError && e.code === code;
function setup(adapter?: ActionAdapter, domain: 'clinical'|'growth' = 'clinical') {
  const host = demoHost(adapter), service = new AgentService(host), fixture = scenario(domain);
  const view = service.create('agent', fixture.draft, fixture.snapshot);
  return { service, host, fixture, id:String(view.id), binding:String(view.binding) };
}
function ready(s: ReturnType<typeof setup>) {
  let v=s.service.answer('owner',s.id,s.binding,'internal-reviewers');
  v=s.service.accept('owner',s.id,String(v.binding));
  v=s.service.approve('reviewer',s.id,String(v.binding),'publication-review');
  return String(v.binding);
}
test('both domains run model, clarify, accept, review, execute and verify', async()=>{
  const out=await agentDemo(); assert.equal(out.ok,true);
  assert.equal(out.scenarios.length,2);
  assert.ok(out.scenarios.every(s=>s.execution.status==='Succeeded'));
});
test('model receives no facts, principals, grants or capabilities and cannot inject permissions',async()=>{
  const {service,fixture}=setup();
  let keys:string[]=[];
  await service.propose('agent','review only',fixture.snapshot,'clinical',{async propose(input){keys=Object.keys(input);return fixture.draft;}});
  assert.deepEqual(keys,['instruction','domain','actions']);
  await assert.rejects(service.propose('agent','x',fixture.snapshot,'clinical',new FixtureModel({...fixture.draft,approved:true})),error('INVALID_CONTRACT'));
});
test('model cannot remove mandatory reviews',()=>{
  const {service,fixture}=setup();
  assert.throws(()=>service.create('agent',{...fixture.draft,requiredReviews:[]},fixture.snapshot),error('MODEL_CONTRACT_REJECTED'));
});
test('agent cannot answer or accept, and unresolved recipient blocks human acceptance',()=>{
  const s=setup();
  assert.throws(()=>s.service.answer('agent',s.id,s.binding,'internal-reviewers'),error('HUMAN_REQUIRED'));
  assert.throws(()=>s.service.accept('agent',s.id,s.binding),error('HUMAN_REQUIRED'));
  assert.throws(()=>s.service.accept('owner',s.id,s.binding),error('UNRESOLVED'));
});
test('answer changes binding; stale acceptance rejected',()=>{
  const s=setup();const next=s.service.answer('owner',s.id,s.binding,'internal-reviewers');
  assert.notEqual(next.binding,s.binding);
  assert.throws(()=>s.service.accept('owner',s.id,s.binding),error('STALE_BINDING'));
});
test('execution needs exact acceptance and independent review',async()=>{
  const s=setup();
  await assert.rejects(s.service.execute('agent',s.id,s.binding,'a'),error('ACCEPTANCE_REQUIRED'));
  const v=s.service.answer('owner',s.id,s.binding,'internal-reviewers');s.service.accept('owner',s.id,String(v.binding));
  await assert.rejects(s.service.execute('agent',s.id,String(v.binding),'a'),error('REVIEW_REQUIRED'));
});
test('acceptor cannot review itself even if configured with review rights',()=>{
  const host=demoHost();host.principals[1].reviews=['publication-review'];
  const service=new AgentService(host),f=scenario('clinical');let v=service.create('agent',f.draft,f.snapshot);
  v=service.answer('owner',String(v.id),String(v.binding),'internal-reviewers');service.accept('owner',String(v.id),String(v.binding));
  assert.throws(()=>service.approve('owner',String(v.id),String(v.binding),'publication-review'),error('SELF_REVIEW'));
});
test('partial observation and conflict do not pass action gate',async()=>{
  for(const mutate of [(f:any)=>f.snapshot.observation.completeness='Partial',(f:any)=>f.snapshot.conflicts=['recordAbsent']]){
    const f=scenario('clinical');mutate(f);const service=new AgentService(demoHost());const v=service.create('agent',f.draft,f.snapshot);
    const s={service,fixture:f,host:demoHost(),id:String(v.id),binding:String(v.binding)};const binding=ready(s);
    await assert.rejects(service.execute('agent',s.id,binding,'a'),error('SEMANTIC_GATE_DENIED'));
  }
});
test('internal grant does not permit external recipient or fields',async()=>{
  const s=setup();s.service.answer('owner',s.id,s.binding,'external');let v=s.service.get(s.id);
  v=s.service.accept('owner',s.id,String(v.binding));v=s.service.approve('reviewer',s.id,String(v.binding),'publication-review');
  await assert.rejects(s.service.execute('agent',s.id,String(v.binding),'a'),error('EFFECT_NOT_GRANTED'));
});
test('snapshot replacement invalidates acceptance and review, preserving history',async()=>{
  const s=setup();const binding=ready(s);s.service.replaceSnapshot(s.id,{...s.fixture.snapshot,facts:{analysisReady:false}});
  const v=s.service.get(s.id);assert.equal(v.acceptance,null);assert.ok((v.events as unknown[]).length>=5);
  await assert.rejects(s.service.execute('agent',s.id,binding,'a'),error('STALE_BINDING'));
});
test('idempotency prevents repeat execution, including parallel duplicate',async()=>{
  let calls=0;
  const s=setup({async execute(r){calls++;await new Promise(r=>setTimeout(r,5));return {requestHash:r.requestHash,status:'Succeeded',output:{ok:true}};},verify(){return true;}});
  const b=ready(s);const [a,dup]=await Promise.all([s.service.execute('agent',s.id,b,'key'),s.service.execute('agent',s.id,b,'key')]);
  assert.equal(a.status,'Succeeded');assert.equal(dup.status,'Pending');
  assert.equal((await s.service.execute('agent',s.id,b,'key')).status,'Succeeded');assert.equal(calls,1);
});
test('idempotency key cannot be reused across contracts',async()=>{
  const s=setup();const b=ready(s);await s.service.execute('agent',s.id,b,'key');
  const v=s.service.create('agent',s.fixture.draft,s.fixture.snapshot);const t={...s,id:String(v.id),binding:String(v.binding)};
  await assert.rejects(s.service.execute('agent',t.id,ready(t),'key'),error('IDEMPOTENCY_CONFLICT'));
});
test('budget reservations are consumed, and revocation denies new actions',async()=>{
  const host=demoHost();host.grants[0].maxActions=1;const service=new AgentService(host),f=scenario('clinical');const v=service.create('agent',f.draft,f.snapshot);
  const s={service,host,fixture:f,id:String(v.id),binding:String(v.binding)};const b=ready(s);
  await service.execute('agent',s.id,b,'a');await assert.rejects(service.execute('agent',s.id,b,'b'),error('EFFECT_NOT_GRANTED'));
  const t=setup();const tb=ready(t);t.service.revoke('grant-clinical');await assert.rejects(t.service.execute('agent',t.id,tb,'a'),error('EFFECT_NOT_GRANTED'));
});
test('timeout remains Unknown; no new key retry until trusted reconciliation',async()=>{
  let calls=0;
  const adapter:ActionAdapter={execute(){calls++;return new Promise(()=>{});},async reconcile(r){return {requestHash:r.requestHash,status:'Succeeded',output:{ok:true}};},verify(){return true;}};
  const host=demoHost(adapter);host.timeoutMs=5;const service=new AgentService(host),f=scenario('clinical');const v=service.create('agent',f.draft,f.snapshot);
  const s={service,host,fixture:f,id:String(v.id),binding:String(v.binding)},b=ready(s);
  assert.equal((await service.execute('agent',s.id,b,'a')).status,'Unknown');
  await assert.rejects(service.execute('agent',s.id,b,'b'),error('EXECUTION_PENDING'));
  assert.throws(()=>service.replaceSnapshot(s.id,f.snapshot),error('EXECUTION_PENDING'));
  assert.equal((await service.reconcile('agent',s.id,b,'a')).status,'Succeeded');assert.equal(calls,1);
});
test('wrong receipt binding and unverified success never become success',async()=>{
  for(const bad of [true,false]){
    const s=setup({async execute(r){return {requestHash:bad?'wrong':r.requestHash,status:'Succeeded',output:{}};},verify(){return false;}});
    assert.equal((await s.service.execute('agent',s.id,ready(s),'a')).status,'Unknown');assert.equal(s.service.get(s.id).busy,true);
  }
});
test('unsafe model object is rejected without executing getter',()=>{
  const s=setup();let called=false;const d={...s.fixture.draft};Object.defineProperty(d,'goal',{get(){called=true;return 'x';},enumerable:true});
  assert.throws(()=>s.service.create('agent',d,s.fixture.snapshot));assert.equal(called,false);
});
