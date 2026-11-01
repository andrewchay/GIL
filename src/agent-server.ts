import { AgentService } from './agent-sdk.ts';
import { createAgentHTTP } from './agent-http.ts';
import { demoHost, scenario } from './agent-demo.ts';
const agent=process.env.GIL_AGENT_TOKEN, owner=process.env.GIL_OWNER_TOKEN, reviewer=process.env.GIL_REVIEWER_TOKEN;
if (!agent || !owner || !reviewer || new Set([agent,owner,reviewer]).size!==3 || [agent,owner,reviewer].some(t=>t.length<16)) {
  throw new Error('Supply three distinct tokens of at least 16 characters: GIL_AGENT_TOKEN, GIL_OWNER_TOKEN, GIL_REVIEWER_TOKEN');
}
const port=Number(process.env.PORT??8787);
if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const service=new AgentService(demoHost());
const server=createAgentHTTP({service,tokens:{[agent]:'agent',[owner]:'owner',[reviewer]:'reviewer'},
  snapshots:{clinical:scenario('clinical').snapshot,growth:scenario('growth').snapshot}});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,mode:'synthetic-local-server',productionAuthorization:false})));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close());
