import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/agent-sdk.ts';
import { demoHost, scenario } from '../src/agent-demo.ts';
import type { ActionAdapter } from '../src/agent-sdk.ts';
import { GilError } from '../src/ast.ts';
function ready(adapter:ActionAdapter){
 const h=demoHost(adapter);h.timeoutMs=10;
 const service=new AgentService(h),f=scenario('clinical');let v=service.create('agent',f.draft,f.snapshot);
 v=service.answer('owner',String(v.id),String(v.binding),'internal-reviewers');v=service.accept('owner',String(v.id),String(v.binding));
 v=service.approve('reviewer',String(v.id),String(v.binding),'publication-review');
 return {service,id:String(v.id),binding:String(v.binding)};
}
test('model cannot substitute easier fact or ambiguous domain/action keys',()=>{
 const s=new AgentService(demoHost()),f=scenario('clinical');
 assert.throws(()=>s.create('agent',{...f.draft,claim:{...f.draft.claim,fact:'analysisReady'}},f.snapshot));
 assert.throws(()=>s.create('agent',{...f.draft,domain:'clinical:prepareReport'},f.snapshot));
});
test('hanging verifier becomes Unknown, not permanently Pending',async()=>{
 const s=ready({async execute(r){return {requestHash:r.requestHash,status:'Succeeded',output:{}};},verify(){return new Promise(()=>{});}});
 const out=await s.service.execute('agent',s.id,s.binding,'a');assert.equal(out.status,'Unknown');
 assert.equal(s.service.get(s.id).busy,true);
});
test('reconciliation is single-flight and completed result does not regress',async()=>{
 const s=ready({execute(){return new Promise(()=>{});},async reconcile(r){await new Promise(r=>setTimeout(r,3));return {requestHash:r.requestHash,status:'Succeeded',output:{}};},verify(){return true;}});
 await s.service.execute('agent',s.id,s.binding,'a');
 const first=s.service.reconcile('agent',s.id,s.binding,'a');
 await assert.rejects(s.service.reconcile('agent',s.id,s.binding,'a'),(e:unknown)=>e instanceof GilError && e.code==='RECONCILIATION_PENDING');
 assert.equal((await first).status,'Succeeded');
 assert.equal((await s.service.reconcile('agent',s.id,s.binding,'a')).status,'Succeeded');
});
test('timed-out reconciliation keeps lock until underlying operation settles',async()=>{
 let resolve!: (value: unknown)=>void;
 const s=ready({execute(){return new Promise(()=>{});},reconcile(){return new Promise(r=>{resolve=r;});},verify(){return true;}});
 await s.service.execute('agent',s.id,s.binding,'a');
 assert.equal((await s.service.reconcile('agent',s.id,s.binding,'a')).status,'Unknown');
 await assert.rejects(s.service.reconcile('agent',s.id,s.binding,'a'),(e:unknown)=>e instanceof GilError && e.code==='RECONCILIATION_PENDING');
 resolve({requestHash:'late',status:'Succeeded',output:{}}); await new Promise(r=>setTimeout(r,0));
 assert.equal(s.service.get(s.id).busy,true); // Late response does not silently commit.
});
test('original grant cannot be silently replaced at final check',async()=>{
 let time=0,calls=0;const h=demoHost({async execute(r){calls++;return {requestHash:r.requestHash,status:'Succeeded',output:{}};},verify(){return true;}});
 h.now=()=>++time;h.grants[0].validUntil=2;h.grants.push({...h.grants[0],id:'alternate',validUntil:100});
 const service=new AgentService(h),f=scenario('clinical');let v=service.create('agent',f.draft,f.snapshot);
 v=service.answer('owner',String(v.id),String(v.binding),'internal-reviewers');v=service.accept('owner',String(v.id),String(v.binding));v=service.approve('reviewer',String(v.id),String(v.binding),'publication-review');
 await assert.rejects(service.execute('agent',String(v.id),String(v.binding),'a'));assert.equal(calls,0);
});
