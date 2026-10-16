// Installed Codex app-server: ephemeral thread persistence probe. No account/model turn.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'gand-g5-codex-protocol-')));
for(const key of Object.keys(process.env))if(/^(ACCOUNT_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|EXTERNAL_)/.test(key))delete process.env[key];
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',DB_PATH:path.join(root,'test.sqlite'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),LOG_LEVEL:'silent'});
const {withRpcProcess}=await import('../apps/server/src/execution/rpc.ts');
const {codexProjectPolicy}=await import('../apps/server/src/execution/drivers.ts');
const {CODEX_SKILL_POLICY,CODEX_SCOPED_POLICY}=await import('../apps/server/src/execution/codexHome.ts');
const {closeDatabase}=await import('../apps/server/src/db/database.ts');
const home=path.join(root,'home'),cwd=path.join(root,'workspace');await mkdir(home);await mkdir(cwd);
const probe=action=>withRpcProcess({command:'codex',args:['app-server','--listen','stdio://',...codexProjectPolicy(cwd),...CODEX_SKILL_POLICY,...CODEX_SCOPED_POLICY,...['shell_tool','multi_agent','hooks','plugins','apps','shell_snapshot'].flatMap(name=>['-c',`features.${name}=false`])],cwd,env:{HOME:home,CODEX_HOME:home},signal:new AbortController().signal,timeoutMs:20000},async peer=>{
 await peer.request('initialize',{clientInfo:{name:'gand_g5_ephemeral_probe',version:'0.1.0'},capabilities:{experimentalApi:false}});peer.send({method:'initialized',params:{}});return action(peer);
});
try{
 const id=await probe(async peer=>{const config=(await peer.request('config/read',{includeLayers:false})).config;assert.equal(config.project_doc_max_bytes,0);assert.equal(config.memories.use_memories,false);assert.equal(config.memories.generate_memories,false);const r=await peer.request('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',developerInstructions:'G5_EPHEMERAL_MARKER'});assert.equal(r.cwd,cwd);assert.equal(r.sandbox.type,'readOnly');assert.equal(r.sandbox.networkAccess,false);return r.thread.id;});
 assert.ok(id);
 await probe(async peer=>{await assert.rejects(()=>peer.request('thread/read',{threadId:id,includeTurns:true}),/not found|no rollout|not persisted|not loaded|could not find|unable to find/i);});
 console.log(JSON.stringify({passed:true,installedCodexProcesses:2,ephemeralThreadNotRecoverable:true,accountUsed:false,modelTurns:0}));
}finally{closeDatabase();await rm(root,{recursive:true,force:true});}
