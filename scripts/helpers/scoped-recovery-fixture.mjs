import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
// Caller supplies a freshly created temporary directory. Refuse business data even in child processes.
const root=process.env.G4_TEST_ROOT;
assert.ok(root?.startsWith('/private/tmp/gand-g4-')||root?.includes('/gand-g4-'));
for(const key of Object.keys(process.env))if(/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|ACCOUNT_|COLLAB_|COORDINATION_|ORCHESTRATION_|EXTERNAL_|MCP_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',AGENT_GAND_ISOLATED_WORKER:'1',LOG_LEVEL:'silent',DB_PATH:path.join(root,'test.sqlite'),AGENTS_DIR:path.join(root,'roles'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),EXTERNAL_CODEX_HOME:path.join(root,'codex'),EXTERNAL_CLAUDE_HOME:path.join(root,'claude'),EXTERNAL_WORKSPACE_DIR:path.join(root,'workspaces'),EXTERNAL_CODEX_COMMAND:path.join(root,'no-codex'),EXTERNAL_CLAUDE_COMMAND:path.join(root,'no-claude'),MCP_SERVER_CMD:''});
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {MockAgent,setGlobalDispatcher}=require('undici');export const network=new MockAgent();network.disableNetConnect();setGlobalDispatcher(network);
export let networkAttempts=0;globalThis.fetch=async()=>{networkAttempts++;throw new Error('G4 forbids network');};
const dispatch=network.dispatch.bind(network);network.dispatch=(...args)=>{networkAttempts++;return dispatch(...args);};
const {config}=await import('../../apps/server/src/config.ts');config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');
export const db=await import('../../apps/server/src/db/database.ts');
export const registry=await import('../../apps/server/src/agents/registry.ts');
export const rooms=await import('../../apps/server/src/conversations/service.ts');
export const trace=await import('../../apps/server/src/runs/trace.ts');
export const store=await import('../../apps/server/src/collaboration/store.ts');
export const delivery=await import('../../apps/server/src/collaboration/scopedDelivery.ts');
export const runner=await import('../../apps/server/src/collaboration/scopedRunner.ts');
export const scheduler=await import('../../apps/server/src/collaboration/scheduler.ts');
export const releases=await import('../../apps/server/src/collaboration/informationRelease.ts');
export const recovery=await import('../../apps/server/src/runs/recovery.ts');
export const holds=await import('../../apps/server/src/runtime/holds.ts');
export const terminal=await import('../../apps/server/src/runtime/terminal.ts');
export const {mockProvider}=await import('../../apps/server/src/llm/provider.ts');
export const response=req=>{
  const name=req.tools[0].name,text=req.messages.map(m=>m.content).join('\n');
  let args={summary:`PRIVATE_${req.model}: 已完成材料审阅，结论与证据完整。`};
  if(name==='agent.consult_batch'){const {version,type,...action}=JSON.parse(text.slice(text.lastIndexOf('{"items":')));args=action;}
  if(name==='agent.acknowledge')args={envelopeId:req.tools[0].parameters.properties.envelopeId.enum[0]};
  return {content:'',toolCalls:[{name,input:JSON.stringify(args)}],usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'tool_use',truncated:false};
};
mockProvider.chat=async req=>response(req);
export async function step(roomId){const c=store.claimNextDispatch(roomId,'g4:'+process.pid);assert.ok(c,'expected claim');await runner.executeScopedDispatch(c.dispatch,c.attempt.id,trace.listRunAgentSnapshots(c.dispatch.runId).find(a=>a.id===c.attempt.agentId));return c;}
export function stop(runId){terminal.commitRunTerminal({runId,status:'cancelled',disposition:'cancelled',source:'g4-test',userMessageStatus:'cancelled'});store.cancelCollaborationRun(runId);}
const {recoverCostReservations}=await import('../../apps/server/src/orchestration/costBudget.ts');
const {recoverMemberAdmissions}=await import('../../apps/server/src/execution/memberAdmission.ts');
export function expire(runId){recoverCostReservations();recoverMemberAdmissions();db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=? AND status='running'",runId);store.interruptExpiredAttempts({onlyExpired:true});}
