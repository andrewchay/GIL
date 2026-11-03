import { AgentService } from './agent-sdk.ts';
import { OpenAICompatibleProvider } from './agent-model-openai.ts';
import { createAgentHTTP } from './agent-http.ts';
import { demoHost, scenario } from './agent-demo.ts';
const agent=process.env.GIL_AGENT_TOKEN, owner=process.env.GIL_OWNER_TOKEN, reviewer=process.env.GIL_REVIEWER_TOKEN;
if (!agent || !owner || !reviewer || new Set([agent,owner,reviewer]).size!==3 || [agent,owner,reviewer].some(t=>t.length<16)) {
  throw new Error('Supply three distinct tokens of at least 16 characters: GIL_AGENT_TOKEN, GIL_OWNER_TOKEN, GIL_REVIEWER_TOKEN');
}
const port=Number(process.env.PORT??8787);
if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const host=demoHost();
// 配齐三个 GIL_MODEL_* 变量即启用真实模型；缺省仍走离线夹具。
const live=process.env.GIL_MODEL_BASE_URL && process.env.GIL_MODEL_API_KEY && process.env.GIL_MODEL_ID;
const liveModel=live ? new OpenAICompatibleProvider({
  baseUrl:process.env.GIL_MODEL_BASE_URL!, apiKey:process.env.GIL_MODEL_API_KEY!, model:process.env.GIL_MODEL_ID!,
  claimContracts:host.actionClaims, actionReviews:host.actionReviews,
  ...(process.env.GIL_MODEL_TIMEOUT_MS ? {timeoutMs:Number(process.env.GIL_MODEL_TIMEOUT_MS)} : {}),
}) : undefined;
const service=new AgentService(host);
const server=createAgentHTTP({service,tokens:{[agent]:'agent',[owner]:'owner',[reviewer]:'reviewer'},
  snapshots:{clinical:scenario('clinical').snapshot,growth:scenario('growth').snapshot},liveModel});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,
  mode:live?'synthetic-local-server+live-model':'synthetic-local-server',
  model:live?process.env.GIL_MODEL_ID:'offline-fixture',productionAuthorization:false})));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close());
