import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-orchestration-o1-'));
await mkdir(path.join(root, 'roles'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent',
  ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', MCP_SERVER_CMD: '', COORDINATION_PLANNER_MODEL: '',
  LLM_OPENAI_API_KEY: '', LLM_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: '',
  EXTERNAL_CLAUDE_COMMAND: path.join(root, 'never-run-claude'), EXTERNAL_CODEX_COMMAND: path.join(root, 'never-run-codex') });
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const accounts = await import('../apps/server/src/accounts/store.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const service = await import('../apps/server/src/orchestration/service.ts');
const { getRunOrchestrationSnapshot } = await import('../apps/server/src/orchestration/store.ts');
const { normalizeOrchestrationRequest, semanticRequest } = await import('../apps/server/src/orchestration/normalize.ts');
const { createRun, getRun } = await import('../apps/server/src/runs/trace.ts');
const { previewCoordination } = await import('../apps/server/src/coordination/service.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const app = Fastify(); await app.register(registerRoutes);
const checks = [];
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('O1 verification must not call a provider'); };
const role = (id, extra = {}) => ({ id, name: id, description: 'O1 isolated fixture', systemPrompt: 'fixture-only-system-prompt',
  capabilities: ['execute'], model: 'mock:fixture', permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '🤖', ...extra });
const api = async (url, payload, method = 'POST') => { const reply = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) }); return { status: reply.statusCode, data: reply.json() }; };
const counts = () => Object.fromEntries(['conversations','runs','messages','orchestration_requests','collaboration_dispatches','coordination_step_attempts','external_agent_executions','approvals'].map(table => [table, db.get(`SELECT COUNT(*) count FROM ${table}`).count]));
const expectError = (fn, status, code) => assert.throws(fn, error => error.status === status && (!code || error.code === code));
function childSubmit(roomId, payload) {
  return new Promise((resolve, reject) => {
    const script = `const {submitLegacyOrchestration}=await import('./apps/server/src/orchestration/service.ts');const result=submitLegacyOrchestration('conversation_message',JSON.parse(process.argv[1]),process.argv[2]);console.log(JSON.stringify({id:result.run.id,deduplicated:result.deduplicated}));const {closeDatabase}=await import('./apps/server/src/db/database.ts');closeDatabase();`;
    const child = spawn(process.execPath, ['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',script,JSON.stringify(payload),roomId], { cwd: path.resolve(import.meta.dirname,'..'), env:process.env, stdio:['ignore','pipe','pipe'] });
    let output='', errors=''; const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('O1 subprocess timeout'));},10000);
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
    child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(errors||'subprocess failed'));else {try {resolve(JSON.parse(output.trim()))}catch(error){reject(error)}}});
  });
}
async function waitTerminal(id) { for(let i=0;i<100;i++){if(['completed','failed','cancelled'].includes(getRun(id)?.status))return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('mock legacy execution did not settle'); }

try {
  registry.createAgent(role('coder'));
  registry.createAgent(role('planner',{ capabilities:['coordinate','execute'] }));
  registry.createAgent(role('reviewer',{ capabilities:['review','execute'] }));
  const secret = 'fixture-o1-secret-not-for-real-use';
  const account = accounts.createAccount({ displayName:'O1 Messages fixture', provider:'custom', protocols:['anthropic-messages'], baseUrl:'http://127.0.0.1:1', models:['fixture-native'], defaultModel:'fixture-native', timeoutMs:1000, apiKey:secret });
  registry.createAgent(role('chicken',{ name:'鸡腿',model:'fixture-native',accountRef:account.id,requiresAccount:true,capabilities:['execute','review'], execution:{kind:'external',driver:'claude-sdk',platformTools:[],sessionPolicy:'conversation'} }));
  registry.createAgent(role('codex',{model:'default',capabilities:['execute','review'],execution:{kind:'external',driver:'codex-app-server',platformTools:[],sessionPolicy:'run'}}));
  registry.createAgent(role('cli',{model:'default',execution:{kind:'external',driver:'claude-cli'}}));

  const input = {goal:'  检查接口  ',agentIds:['coder','planner'],recipientIds:['coder']};
  const normalized = ['room_create','direct_run','conversation_message','coordination_preview','followup_preview','unified_preview'].map(source=>semanticRequest(normalizeOrchestrationRequest(input,source)));
  for (const request of normalized) assert.deepEqual(request,normalized[0]);
  checks.push('六类来源采用同一规范化契约，目标顺序保留');

  const before = counts();
  const preview = await api('/api/orchestration/preview',{goal:'@鸡腿 检查接口',agentIds:['coder','chicken','codex']});
  assert.equal(preview.status,200);assert.equal(preview.data.comparisonOnly,false);assert.equal(preview.data.testedModel,false);assert.equal(preview.data.dispatchCreated,false);
  assert.deepEqual(preview.data.decision.targetIds,['chicken']);assert.equal(preview.data.decision.targetSource,'mention');
  assert.deepEqual(counts(),before);assert.equal(networkCalls,0);
  const serialized = JSON.stringify(preview.data);
  for(const forbidden of [secret,'ciphertext','fixture-only-system-prompt',root])assert.ok(!serialized.includes(forbidden),forbidden);
  const keyPath=path.join(root,'private','account-master-key.json');await rename(keyPath,keyPath+'.held');
  try {const withoutKey=await api('/api/orchestration/preview',{goal:'@鸡腿 检查接口',agentIds:['chicken']});assert.equal(withoutKey.status,200);assert.equal(withoutKey.data.capabilities.agents[0].account.configuration,'configured');} finally {await rename(keyPath+'.held',keyPath);}
  checks.push('规则预览不创建执行对象/派发/模型调用，能力读取不解密凭证、不泄漏密钥或私有路径');

  const sdk=preview.data.capabilities.agents.find(agent=>agent.id==='chicken');assert.equal(sdk.supports.control,true);assert.equal(sdk.supports.resume,true);assert.equal(sdk.supports.coordinationSteps,true);
  const codex=preview.data.capabilities.agents.find(agent=>agent.id==='codex');assert.equal(codex.driver,'codex-app-server');assert.equal(codex.supports.control,true);
  assert.ok(!preview.data.decision.issues.some(issue=>issue.code==='EXTERNAL_STEP_BINDING_PENDING'));
  const hardLimit=await api('/api/orchestration/preview',{goal:'只读分析',agentIds:['chicken'],constraints:{maxTokens:100}});assert.ok(hardLimit.data.decision.issues.some(issue=>issue.code==='HARD_TOKEN_LIMIT_UNSUPPORTED'));
  const cli=await api('/api/orchestration/preview',{goal:'修复代码',agentIds:['cli'],recipientIds:['cli'],workflow:'development_review'});assert.ok(cli.data.decision.issues.some(issue=>issue.code==='READONLY_CLI_RESTRICTED'));
  checks.push('API/SDK/app-server/CLI 能力不同，O2 门禁与硬预算限制明确');

  const conflict=await api('/api/orchestration/preview',{goal:'@鸡腿 检查接口',agentIds:['coder','chicken'],recipientIds:['coder']});assert.ok(conflict.data.decision.issues.some(issue=>issue.code==='TARGET_CONFLICT'));
  const unknown=await api('/api/orchestration/preview',{goal:'@不在队内 分析接口',agentIds:['coder']});assert.ok(unknown.data.decision.issues.some(issue=>issue.code==='UNRESOLVED_MENTION'));
  assert.equal((await api('/api/orchestration/preview',{goal:'x',agentIds:['coder','coder']})).status,400);
  assert.equal((await api('/api/orchestration/preview',{goal:'x',agentIds:['coder'],constraints:{maxTokens:-1}})).status,400);
  assert.equal((await api('/api/orchestration/preview',{goal:'x',agentIds:['coder'],apiKey:secret})).status,400);
  const parallel=await api('/api/orchestration/preview',{goal:'比较接口',agentIds:['coder','planner'],recipientIds:['planner','coder'],constraints:{readonly:true}});assert.equal(parallel.data.decision.effectiveStrategy,'parallel');assert.deepEqual(parallel.data.decision.targetIds,['planner','coder']);
  checks.push('显式目标、@ 冲突、未知提及、重复成员与错误约束不会静默修正');

  const created=service.submitLegacyOrchestration('room_create',{goal:'开始分析',mode:'pipeline',agentIds:['coder'],clientRequestId:'create-o1-0001'});
  const snapshot=getRunOrchestrationSnapshot(created.run.id);assert.equal(snapshot.executionAuthority,'legacy');assert.equal(snapshot.comparisonOnly,true);assert.equal(created.run.mode,'pipeline');
  assert.equal(snapshot.legacyExecution.workspace,created.run.workspace);assert.equal(created.message.meta.orchestrationSource,'room_create');
  const repeated=service.submitLegacyOrchestration('room_create',{goal:'开始分析',mode:'pipeline',agentIds:['coder'],clientRequestId:'create-o1-0001'});assert.equal(repeated.run.id,created.run.id);assert.equal(repeated.deduplicated,true);
  expectError(()=>service.submitLegacyOrchestration('room_create',{goal:'改变内容',mode:'pipeline',agentIds:['coder'],clientRequestId:'create-o1-0001'}),409,'IDEMPOTENCY_CONFLICT');
  const direct=service.submitLegacyOrchestration('direct_run',{goal:'直接 Run',mode:'pipeline',agentIds:['coder'],clientRequestId:'direct-o1-0001'});assert.equal(service.submitLegacyOrchestration('direct_run',{goal:'直接 Run',mode:'pipeline',agentIds:['coder'],clientRequestId:'direct-o1-0001'}).run.id,direct.run.id);
  checks.push('建房与直接 Run 共用提交事务，重试复用原 Run，内容冲突返回 409');

  const roomId=created.conversation.id;
  const messagePreview=service.previewOrchestration({goal:'本轮检查',conversationId:roomId,recipientIds:['coder']});
  const payload={body:'本轮检查',recipientIds:['coder'],clientMessageId:'message-o1-0001',orchestrationFingerprint:messagePreview.fingerprint};
  const submitted=service.submitLegacyOrchestration('conversation_message',payload,roomId);assert.ok(submitted.message);assert.equal(getRunOrchestrationSnapshot(submitted.run.id).fingerprint,messagePreview.fingerprint);
  assert.equal(service.submitLegacyOrchestration('conversation_message',payload,roomId).run.id,submitted.run.id);
  expectError(()=>service.submitLegacyOrchestration('conversation_message',{...payload,body:'不同内容'},roomId),409,'IDEMPOTENCY_CONFLICT');
  rooms.updateConversationMembers(roomId,{agentIds:['coder','planner'],supervisorId:null,defaultReviewerId:null,expectedMembersVersion:1});
  assert.equal(service.submitLegacyOrchestration('conversation_message',payload,roomId).run.id,submitted.run.id,'exact retry survives roster changes');
  expectError(()=>service.submitLegacyOrchestration('conversation_message',{...payload,clientMessageId:'message-o1-0002'},roomId),409,'PREVIEW_STALE');
  checks.push('消息幂等不受后续配置变化影响，新提交拒绝过期成员预览');

  const managedPreview=service.previewOrchestration({goal:'@鸡腿 检查接口',agentIds:['chicken']});
  accounts.replaceCredential(account.id,{expectedVersion:account.version,apiKey:'fixture-o1-replacement-not-for-real-use'});
  assert.notEqual(service.previewOrchestration({goal:'@鸡腿 检查接口',agentIds:['chicken']}).fingerprint,managedPreview.fingerprint);
  expectError(()=>service.submitLegacyOrchestration('direct_run',{goal:'@鸡腿 检查接口',agentIds:['chicken'],orchestrationFingerprint:managedPreview.fingerprint}),409,'PREVIEW_STALE');
  checks.push('账户凭证版本变化使预览失效，历史比较快照不被改写');

  const rolePreview=service.previewOrchestration({goal:'角色版本检查',agentIds:['coder']});
  registry.setEnabled('coder',false);
  expectError(()=>service.submitLegacyOrchestration('direct_run',{goal:'角色版本检查',agentIds:['coder'],orchestrationFingerprint:rolePreview.fingerprint}),409,'PREVIEW_STALE');
  registry.setEnabled('coder',true);
  await mkdir(path.join(root,'workspace'));
  const workspaces=await import('../apps/server/src/workspaces/external.ts');
  const workspace=workspaces.registerExternal({path:path.join(root,'workspace'),label:'O1 workspace'});
  const workspaceName='ext:'+workspace.id;
  const workspacePreview=service.previewOrchestration({goal:'工作区检查',agentIds:['coder'],workspace:workspaceName});
  workspaces.setExternalTrusted(workspace.id,true);
  expectError(()=>service.submitLegacyOrchestration('direct_run',{goal:'工作区检查',agentIds:['coder'],workspace:workspaceName,orchestrationFingerprint:workspacePreview.fingerprint}),409,'PREVIEW_STALE');
  checks.push('角色停用/版本和工作区信任配置变化使预览失效');

  const restart=await childSubmit(roomId,payload);assert.equal(restart.id,submitted.run.id);assert.equal(restart.deduplicated,true);
  const concurrentPayload={body:'并发重复消息',recipientIds:['coder'],clientMessageId:'concurrent-o1-0001'};
  const concurrentBefore=counts();const children=await Promise.all([childSubmit(roomId,concurrentPayload),childSubmit(roomId,concurrentPayload)]);
  assert.equal(children[0].id,children[1].id);assert.equal(children.filter(result=>result.deduplicated).length,1);assert.equal(counts().runs,concurrentBefore.runs+1);assert.equal(counts().messages,concurrentBefore.messages+1);
  checks.push('跨进程重试与并发提交只产生一条 Run 和用户消息');

  const draft=await previewCoordination({goal:'原计划内容',agentIds:['coder'],requestedProtocol:'single_agent',deterministicOnly:true});
  const rollbackBefore=counts();const events=[];const unsubscribe=subscribe(event=>events.push(event));
  expectError(()=>service.submitLegacyOrchestration('room_create',{goal:'修改后的内容',mode:draft.draft.runtimeMode,agentIds:['coder'],coordinationDraftId:draft.draft.id}),409);
  unsubscribe();assert.deepEqual(counts(),rollbackBefore);assert.equal(events.filter(event=>['run.updated','conversation.updated','message'].includes(event.type)).length,0);
  checks.push('计划校验失败时 Run/房间/消息/比较记录与事件全部回滚');

  const legacyRoom=rooms.createConversation({title:'pre-O1',mode:'pipeline',agentIds:['coder'],supervisorId:null,workspace:null});
  const legacyRun=createRun('旧记录','pipeline',['coder'],null,null,legacyRoom.id);
  assert.equal(getRunOrchestrationSnapshot(legacyRun.id),null);
  const { post }=await import('../apps/server/src/messaging/inbox.ts');post({runId:legacyRun.id,from:'user',to:'coder',kind:'user',body:'旧消息',clientMessageId:'legacy-message-01'});
  assert.equal(service.submitLegacyOrchestration('conversation_message',{body:'旧消息',recipientIds:['coder'],clientMessageId:'legacy-message-01'},legacyRoom.id).run.id,legacyRun.id);
  expectError(()=>service.submitLegacyOrchestration('conversation_message',{body:'修改旧消息',recipientIds:['coder'],clientMessageId:'legacy-message-01'},legacyRoom.id),409,'IDEMPOTENCY_CONFLICT');
  const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');const legacyFrozen=JSON.stringify(getRun(legacyRun.id));db.db.exec(schema);db.db.exec(schema);assert.equal(JSON.stringify(getRun(legacyRun.id)),legacyFrozen);assert.equal(getRunOrchestrationSnapshot(legacyRun.id),null);
  checks.push('重复升级幂等，旧 Run 不回填当前能力；旧消息按可验证字段去重');

  const legacyPreview=await api('/api/coordination/preview',{goal:'普通检查',agentIds:['coder'],requestedProtocol:'single_agent'});assert.equal(legacyPreview.status,201);assert.ok(legacyPreview.data.draft&&legacyPreview.data.plan);
  const followup=await api(`/api/conversations/${roomId}/followup-preview`,{body:'简单追问',recipientIds:['coder']});assert.equal(followup.status,200);assert.ok('kind' in followup.data&&'roomMode' in followup.data);
  const nativePreview=await api('/api/coordination/preview',{goal:'检查',agentIds:['chicken'],requestedProtocol:'single_agent'});assert.equal(nativePreview.status,201,'O2 admits verified SDK steps');
  const smoke=await api('/api/runs',{goal:'O1 API compatibility smoke',mode:'pipeline',agentIds:['coder'],clientRequestId:'http-direct-0001'});assert.equal(smoke.status,201);assert.ok(smoke.data.run&&smoke.data.conversation);await waitTerminal(smoke.data.run.id);
  assert.equal((await api('/api/runs',{goal:'O1 API compatibility smoke',mode:'pipeline',agentIds:['coder'],clientRequestId:'http-direct-0001'})).status,200);
  const msg=await api(`/api/conversations/${smoke.data.conversation.id}/messages`,{body:'O1 followup smoke',recipientIds:['coder'],clientMessageId:'http-message-0001'});assert.equal(msg.status,202);assert.ok(msg.data.run&&msg.data.message);await waitTerminal(msg.data.run.id);
  const duplicate=await api(`/api/conversations/${smoke.data.conversation.id}/messages`,{body:'O1 followup smoke',recipientIds:['coder'],clientMessageId:'http-message-0001'});assert.equal(duplicate.status,200);assert.equal(duplicate.data.run.id,msg.data.run.id);
  const conflicting=await api(`/api/conversations/${smoke.data.conversation.id}/messages`,{body:'changed',recipientIds:['coder'],clientMessageId:'http-message-0001'});assert.equal(conflicting.status,409);assert.equal(conflicting.data.code,'IDEMPOTENCY_CONFLICT');
  const readSnapshot=await api(`/api/runs/${msg.data.run.id}/orchestration`,undefined,'GET');assert.equal(readSnapshot.status,200);assert.equal(readSnapshot.data.snapshot.executionAuthority,'legacy');
  const first=await api('/api/conversations',{goal:'first turn pipeline semantics',mode:'pipeline',agentIds:['coder','planner']});assert.equal(first.status,201);await waitTerminal(first.data.run.id);
  const agentSpans=db.all("SELECT name FROM run_events WHERE run_id=? AND span_kind='agent'",first.data.run.id);assert.equal(agentSpans.length,2,'persisting first message must not turn initial pipeline into a single-agent followup');
  assert.equal(db.get("SELECT COUNT(*) count FROM messages WHERE run_id=? AND kind='user'",first.data.run.id).count,1);
  const previewOnly=await api('/api/runs',{goal:'new execution entry requires an idempotency key',agentIds:['coder'],strategy:'parallel'});assert.equal(previewOnly.status,400);assert.equal(previewOnly.data.code,'INVALID_IDEMPOTENCY_KEY');
  checks.push('旧预览/Run/消息 HTTP 响应兼容，执行仍走原编排，比较快照可查询');
  assert.equal(networkCalls,0);
  console.log(JSON.stringify({status:'passed',checks,providerRequests:networkCalls},null,2));
} finally {
  globalThis.fetch=originalFetch;await app.close();db.closeDatabase();await rm(root,{recursive:true,force:true});
}
