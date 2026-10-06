import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-o4-'));
const repository = path.join(root, 'repo'); await mkdir(repository); await writeFile(path.join(repository, 'README.md'), 'fixture baseline\n');
execFileSync('git', ['init', '-q', repository]); execFileSync('git', ['-C', repository, 'add', '.']);
execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
const native = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-o4.mjs', import.meta.url), native); await chmod(native, 0o755);
const log = path.join(root, 'native.jsonl'); await writeFile(log, '');
const codexHome = path.join(root, 'codex'); await mkdir(codexHome); await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'o4-fixture' } }));
Object.assign(process.env, { NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_PLANNER_MODEL: '', COORDINATION_RUNTIME_KERNEL: 'off', APPROVAL_TIMEOUT_MS: '0', EXTERNAL_WORKSPACE_MODE: 'isolated',
  EXTERNAL_AGENT_TIMEOUT_MS: '15000', EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: native, EXTERNAL_CODEX_COMMAND: native,
  EXTERNAL_CODEX_HOME: codexHome, EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'), ANTHROPIC_API_KEY: 'fixture-not-a-real-key',
  LLM_OPENAI_API_KEY: '', LLM_ANTHROPIC_API_KEY: '', FAKE_D_LOG: log, FAKE_O2_SERVER_ROOT: path.resolve('apps/server') });
const originalFetch = globalThis.fetch; let externalRequests = 0;
globalThis.fetch = (url, ...args) => { if (!String(url).startsWith('http://127.0.0.1:')) { externalRequests++; throw new Error('No real providers in O4'); } return originalFetch(url, ...args); };
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const coordination = await import('../apps/server/src/coordination/service.ts');
const { enqueueConversationRun } = await import('../apps/server/src/conversations/dispatcher.ts');
const { submitLegacyOrchestration } = await import('../apps/server/src/orchestration/service.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { budgetedChat } = await import('../apps/server/src/orchestration/executionBudget.ts');
const authority = await import('../apps/server/src/execution/authority.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { applyRunAction } = await import('../apps/server/src/orchestration/actions.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { getRunOrchestrationSnapshot } = await import('../apps/server/src/orchestration/store.ts');
const { listByRun } = await import('../apps/server/src/messaging/inbox.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');
const approvals = await import('../apps/server/src/hitl/approvals.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const app = Fastify(); await registerRoutes(app);
const workspace = 'ext:' + registerExternal({ path: repository, trusted: true }).id;
const role = (id, more = {}) => ({ id, name: id, description: 'O4 fixture', systemPrompt: 'Provide actual complete deliverables.',
  model: 'mock:' + id, capabilities: ['execute'], permissionMode: 'auto', tools: ['fs.read','fs.write'], disallowedTools: [], color: '#4477aa', avatar: '', ...more });
for (const id of ['aa','bb','summary']) await registry.createAgent(role(id));
await registry.createAgent(role('planner', { capabilities: ['coordinate','execute'] }));
await registry.createAgent(role('reviewer', { capabilities: ['review'], model: 'mock:reviewer' }));
for (const [id, driver, model] of [['sdk','claude-sdk','fixture-session'],['codex','codex-app-server','fixture-session'],['sdk-handoff','claude-sdk','o4-handoff'],['codex-complete','codex-app-server','o4-complete'],['sdk-write','claude-sdk','fixture-write'],['codex-review','codex-app-server','fixture-review-revision'],['sdk-wait','claude-sdk','fixture-wait']])
  await registry.createAgent(role(id, { model, permissionMode: id.includes('write') ? 'confirm' : 'readonly', tools: [], execution: { kind: 'external', driver, platformTools: [] }, capabilities: id.includes('review') ? ['review'] : ['execute'] }));
const calls = [], checks = []; let reviews = 0; let invalidPlan = false;
const respond = (content, tokensOut = 2, toolCalls = []) => ({ content, usage: { tokensIn: 1, tokensOut, costUsd: 0 }, toolCalls, stopReason: 'end_turn', truncated: false });
mockProvider.chat = async req => {
  const text = req.messages.map(m => m.content).join('\n');
  const call = { model: req.model, text, tools: req.tools ?? [], maxTokens: req.maxTokens, started: Date.now(), ended: null }; calls.push(call);
  if (text.includes('__AGENT_GAND_O4_DAG__')) {
    call.ended = Date.now();
    const workerA = text.includes('O4:native-dag') ? 'sdk' : 'aa', workerB = text.includes('O4:native-dag') ? 'codex' : 'bb';
    return respond(JSON.stringify({ tasks: invalidPlan ? [
      { title: 'bad', body: 'bad', assignee: 'aa', reviewRequired: false, acceptanceCriteria: ['bad'], blockedBy: ['bad'] }
    ] : [
      { title: 'A', body: '分析 A', assignee: workerA, reviewRequired: true, reviewer: 'reviewer', acceptanceCriteria: ['A evidence'], blockedBy: [] },
      { title: 'B', body: '分析 B', assignee: workerB, reviewRequired: false, acceptanceCriteria: ['B evidence'], blockedBy: [] },
      { title: 'C', body: '比较 A 和 B', assignee: workerA, reviewRequired: false, acceptanceCriteria: ['C evidence'], blockedBy: ['A','B'] }
    ] }));
  }
  if (text.includes('O4:deadline')) await new Promise(resolve => setTimeout(resolve, 180));
  else await new Promise(resolve => setTimeout(resolve, 60));
  call.ended = Date.now();
  if (req.model === 'mock:reviewer') { reviews++; return respond(JSON.stringify({ verdict: text.includes('O4:revision') && reviews === 1 ? 'FAIL' : 'PASS', summary: '已审查当前实现', issues: [] })); }
  if (text.includes('O4:budget')) return respond('完整分析交付。', req.maxTokens);
  if (text.includes('O4:failed') && req.model === 'mock:bb') throw new Error('required branch failed');
  if (text.includes('O4:handoff') && req.model === 'mock:aa') return respond('', 2, [{ id: 'handoff', name: 'agent.handoff', input: JSON.stringify({ target: 'bb', objective: '完成后续交付', reason: '需要接力' }) }]);
  if (req.tools?.some(t=>t.name==='agent.complete')) return respond('',2,[{id:'complete',name:'agent.complete',input:JSON.stringify({summary:'实际交付已完成，结果完整可验收。'})}]);
  return respond('完整交付结果，证据和判断已完成。');
};
const waitFor = async (read, label, timeout = 22000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }  throw new Error('Timeout: ' + label); };
const api = async (url, payload) => { const result = await app.inject({ method: payload ? 'POST' : 'GET', url, ...(payload ? { payload } : {}) }); return { status: result.statusCode, data: result.json() }; };
const preview = body => entry.previewExecutionOrchestration(body);
const submit = (body, p) => entry.submitExecutionOrchestration({ ...body, clientRequestId: 'o4-' + Math.random().toString(36).slice(2), ...(p ? { previewId: p.previewId, orchestrationFingerprint: p.fingerprint } : {}) });
const confirmed = async body => { const p = await preview(body); assert.deepEqual(p.decision.issues.filter(i => i.severity === 'error'), [], JSON.stringify(p.decision.issues)); return submit(body, p); };
const execute = async value => { enqueueConversationRun(value.run.id); return waitFor(() => { for (const row of db.all("SELECT id FROM approvals WHERE run_id=? AND status='pending'",value.run.id)) approvals.decide(row.id,{decision:'approve',by:'fixture'}); for (const hold of holds.claimReadyDurableHolds({claimOwner:'o4-fixture',runId:value.run.id})) holds.completeDurableHoldClaim({id:hold.id,claimToken:hold.claimToken}); const r = trace.getRun(value.run.id); return ['completed','failed','cancelled','waiting_for_user'].includes(r.status) ? r : null; }, value.run.goal); };
const states = value => store.listCoordinationStepStates(value.plan.id);
try {
  const before = calls.length;
  const p = await preview({ goal: '分析当前接口', agentIds: ['sdk','codex'] });
  assert.equal(p.comparisonOnly, false); assert.equal(p.decision.execution.engine, 'collaboration'); assert.equal(calls.length, before);
  assert.equal(db.get('SELECT COUNT(*) n FROM runs').n, 0); assert.equal(db.get('SELECT COUNT(*) n FROM collaboration_dispatches').n, 0);
  assert.equal((await preview({ goal: '分析接口', agentIds: ['codex'] })).decision.targetIds[0], 'codex');
  assert.ok((await preview({ goal: '分析接口', agentIds: ['sdk'], constraints: { maxTokens: 10 } })).decision.issues.some(i => i.code === 'HARD_TOKEN_LIMIT_UNSUPPORTED'));
  assert.deepEqual((await preview({goal:'分析接口',agentIds:['sdk','aa'],constraints:{maxTokens:10}})).decision.targetIds,['aa']);
  assert.ok((await preview({ goal: '修复代码', agentIds: ['aa','bb'], recipientIds: ['aa','bb'], strategy: 'parallel' })).decision.issues.some(i => i.code === 'PARALLEL_WRITE_CONFLICT'));
  assert.ok((await preview({ goal: '@bb 分析接口', agentIds: ['aa','bb'], recipientIds: ['aa'] })).decision.issues.some(i => i.code === 'TARGET_CONFLICT'));
  assert.ok((await preview({ goal: '执行任务', agentIds: ['aa','bb'], recipientIds: ['aa','bb'] })).decision.issues.some(i => i.code === 'TASK_INTENT_REQUIRED'));
  checks.push('规则预览零模型/零派发，自动选择 SDK/Codex，策略与目标冲突显式拒绝');

  let start = calls.length;
  const parallel = await confirmed({ goal: 'O4:parallel 分别分析接口', agentIds: ['aa','bb'], recipientIds: ['aa','bb'], constraints: { readonly: true } });
  assert.equal((await execute(parallel)).status, 'completed');
  const branchCalls = calls.slice(start); assert.equal(branchCalls.length, 2); assert.ok(branchCalls.every(c => c.tools.every(t => t.name !== 'fs.write')));
  assert.ok(branchCalls[0].ended >= branchCalls[1].started); assert.equal(parallel.plan.steps.filter(s => s.type === 'aggregate').length, 0);
  const serial = await confirmed({ goal: 'O4:serial 比较接口', agentIds: ['aa','bb'], recipientIds: ['bb','aa'], strategy: 'serial', constraints: { readonly: true } });
  start = calls.length; assert.equal((await execute(serial)).status, 'completed');
  assert.deepEqual(calls.slice(start).map(c => c.model), ['mock:bb','mock:aa']); assert.ok(calls[start+1].text.includes('完整交付结果'));
  const failed = await confirmed({ goal: 'O4:failed 分别分析接口', agentIds: ['aa','bb'], recipientIds: ['aa','bb'], strategy: 'parallel' });
  assert.equal((await execute(failed)).status, 'failed'); assert.equal(states(failed).find(s => s.stepId === 'complete').status, 'pending');
  checks.push('并行只读、无隐式汇总、明确顺序与前序产物；必需分支失败阻止终态完成');

  const analysis = await confirmed({ goal: 'O4:summary 分别分析接口并汇总', agentIds: ['aa','sdk','summary'], recipientIds: ['aa','sdk'], workflow: 'analysis_summary', aggregatorId: 'summary', workspace });
  assert.equal((await execute(analysis)).status, 'completed');
  assert.ok(states(analysis).find(s => s.stepId === 'analysis-summary').startedAt >= states(analysis).find(s => s.stepId === 'work-2').completedAt);
  const readonlyNative=await confirmed({goal:'只读分析当前接口',agentIds:['aa','sdk-write'],recipientIds:['aa','sdk-write'],strategy:'parallel',workspace,constraints:{readonly:true}});
  assert.equal((await execute(readonlyNative)).status,'failed');
  assert.equal(JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=?',readonlyNative.run.id).record).permissionMode,'readonly');
  checks.push('API + SDK 分析与显式汇总门禁；可写原生角色被本轮只读政策收窄，写入被拒绝');

  reviews = 0; const revision = await confirmed({ goal: 'O4:revision 实现修复并评审', agentIds: ['aa','reviewer'], recipientIds: ['aa'], workflow: 'development_review', defaultReviewerId: 'reviewer', workspace });
  assert.equal((await execute(revision)).status, 'completed'); assert.equal(states(revision).find(s => s.stepId === 'review-implement').attemptNo, 2); assert.equal(reviews, 2);
  const reviewBindings = db.all("SELECT record FROM execution_bindings WHERE run_id=? AND json_extract(record,'$.stepId')='review-independent'", revision.run.id).map(r => JSON.parse(r.record));
  assert.equal(reviewBindings.length, 2); assert.notEqual(reviewBindings[0].reviewTargets[0].attemptId, reviewBindings[1].reviewTargets[0].attemptId);
  const nativeReview = await confirmed({ goal: 'O4:native 实现并评审 D_CONTENT=O4 frozen implementation', agentIds: ['sdk-write','codex-review'], recipientIds: ['sdk-write'], workflow: 'development_review', defaultReviewerId: 'codex-review', workspace });
  assert.equal((await execute(nativeReview)).status, 'completed'); assert.equal(states(nativeReview).find(s => s.stepId === 'review-implement').attemptNo, 2);
  assert.equal(await readFile(path.join(repository, 'README.md'), 'utf8'), 'fixture baseline\n');
  assert.equal(execFileSync('git',['-C',repository,'status','--porcelain'],{encoding:'utf8'}),'');
  const nativeTurns = (await readFile(log,'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(r => r.kind === 'turn' && r.model.includes('review'));
  assert.ok(nativeTurns.every(r => r.cwd !== repository));
  checks.push('API 与 SDK→Codex 开发评审均经历 FAIL→返工→新快照→PASS，源仓库未被写入');

  const dagBody = { goal: 'O4:DAG 主管拆解分析接口', agentIds: ['planner','aa','bb','reviewer'], recipientIds: ['aa','bb'], workflow: 'supervisor_decomposition', supervisorId: 'planner', defaultReviewerId: 'reviewer', constraints: { readonly: true } };
  const ruleDag = await preview(dagBody); assert.equal(ruleDag.plan, null);
  assert.throws(() => submit(dagBody, ruleDag), /详细主管计划/);
  start = calls.length; const dagPreview = await preview({ ...dagBody, planning: 'detailed' });
  assert.deepEqual(dagPreview.decision.issues.filter(i=>i.severity==='error'), []); assert.equal(calls.length - start, 1); assert.equal(calls[start].tools.length, 0);
  const graph = dagPreview.plan.plan; assert.deepEqual(graph.steps.find(s => s.id === 'dag-task-3').dependsOn, ['dag-task-1-review','dag-task-2']);
  const dag = submit(dagBody, dagPreview); assert.equal((await execute(dag)).status, 'completed');
  assert.equal(calls.slice(start).filter(c => c.text.includes('__AGENT_GAND_O4_DAG__')).length, 1);
  assert.ok(states(dag).find(s => s.stepId === 'dag-task-3').startedAt >= states(dag).find(s=>s.stepId==='dag-task-1-review').completedAt);
  const another = submit(dagBody, dagPreview); assert.notEqual(another.plan.id, dag.plan.id);
  invalidPlan = true; const bad = await preview({ ...dagBody, planning: 'detailed' }); invalidPlan = false;
  assert.ok(bad.decision.issues.some(i => i.code === 'DETAILED_PLAN_INVALID')); assert.equal(bad.plan, null); assert.throws(() => submit(dagBody,bad), /阻断项/);
  const nativeDagBody = { ...dagBody, goal:'O4:native-dag 主管拆解分析接口', agentIds:['planner','sdk','codex','reviewer'], recipientIds:['sdk','codex'], workspace };
  const nativeDagPreview = await preview({...nativeDagBody,planning:'detailed'}); const nativeDag = submit(nativeDagBody,nativeDagPreview);
  assert.equal((await execute(nativeDag)).status,'completed'); assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions WHERE run_id=?',nativeDag.run.id).n,3);
  const serialDagPreview = await preview({...dagBody,strategy:'serial',planning:'detailed'});
  assert.deepEqual(serialDagPreview.plan.plan.steps.find(s=>s.id==='dag-task-2').dependsOn,['dag-task-1-review']);
  checks.push('显式一次无工具详细规划，API/SDK/Codex 真实三任务 DAG 与评审依赖门禁；无效图不伪造降级');

  const idemBody = { goal: 'O4:idempotent 分析接口', agentIds: ['aa'], clientRequestId: 'o4-idempotent-1' };
  const idem = entry.submitExecutionOrchestration(idemBody); const messages = listByRun(idem.run.id);
  const duplicate = entry.submitExecutionOrchestration(idemBody); assert.equal(duplicate.run.id, idem.run.id); assert.equal(duplicate.deduplicated,true); assert.deepEqual(listByRun(idem.run.id), messages);
  assert.throws(()=>entry.submitExecutionOrchestration({...idemBody,goal:'different'}),/不同任务/);
  const staleBody = { goal: '比较接口', agentIds: ['aa','bb'], recipientIds: ['aa','bb'], strategy: 'serial' }; const stale = await preview(staleBody);
  await registry.updateAgent('bb', role('bb', { description: 'updated role' }), registry.getAnyAgent('bb').version); assert.throws(()=>submit(staleBody,stale),/已变化/);
  assert.equal(getRunOrchestrationSnapshot(parallel.run.id).executionAuthority,'orchestration');
  checks.push('幂等重复无消息改写、预览计划可复用且 Run ID 独立、角色变化使确认失效');

  start=calls.length; const debate=await confirmed({goal:'O4:debate 辩论 2 轮',agentIds:['aa','bb'],recipientIds:['aa','bb'],workflow:'bounded_debate',constraints:{rounds:2}});
  assert.equal((await execute(debate)).status,'completed'); assert.equal(calls.length-start,4);
  assert.ok((await preview({goal:'辩论 3 轮',agentIds:['aa','bb'],workflow:'bounded_debate',constraints:{rounds:2}})).decision.issues.some(i=>i.code==='ROUND_CONFLICT'));
  const judge=await confirmed({goal:'辩论 1 轮',agentIds:['aa','bb','reviewer'],recipientIds:['aa','bb'],workflow:'bounded_debate',defaultReviewerId:'reviewer',constraints:{rounds:1}});
  assert.equal((await execute(judge)).status,'completed'); assert.ok(states(judge).find(s=>s.stepId==='debate-judge').startedAt>=states(judge).find(s=>s.stepId==='debate-r1-con').completedAt);
  checks.push('无裁判两人辩论严格 2×轮数；可选裁判等待全部发言、冲突轮次被拒绝');

  start=calls.length; const budget=await confirmed({goal:'O4:budget 分别分析接口',agentIds:['aa','bb'],recipientIds:['aa','bb'],strategy:'parallel',constraints:{maxTokens:5,readonly:true}});
  assert.equal((await execute(budget)).status,'failed'); assert.equal(calls.slice(start).reduce((n,c)=>n+c.maxTokens,0),5);
  assert.equal(db.get("SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?",budget.run.id).n,5);
  const deadline=await confirmed({goal:'O4:deadline 分别分析接口',agentIds:['aa','bb'],recipientIds:['aa','bb'],strategy:'parallel',constraints:{deadlineMs:80,readonly:true}});
  assert.equal((await execute(deadline)).status,'failed'); assert.equal(listByRun(deadline.run.id).filter(m=>m.kind==='agent').length,0);
  const nativeDeadline=await confirmed({goal:'O4:native-deadline 分析接口',agentIds:['sdk-wait'],strategy:'serial',recipientIds:['sdk-wait'],workspace,constraints:{deadlineMs:1000,readonly:true}});
  assert.equal((await execute(nativeDeadline)).status,'failed');
  const missingUsage=submit({goal:'分析接口',agentIds:['aa'],constraints:{maxTokens:5}});
  let upstream=0; const noUsage={chat:async req=>{upstream++;return respond('完整结果',0);}};
  await budgetedChat(missingUsage.run.id,noUsage,{model:'mock:aa',messages:[],maxTokens:5});
  await assert.rejects(()=>budgetedChat(missingUsage.run.id,noUsage,{model:'mock:aa',messages:[]}),/预算已耗尽/); assert.equal(upstream,1);
  const correction=submit({goal:'O4:correction 分析接口',agentIds:['aa'],constraints:{maxTokens:5}});
  const correctionProvider=mockProvider.chat; const limits=[];
  mockProvider.chat=async req=>{limits.push(req.maxTokens);return respond('实际完整交付',2);};
  const turn=await runAgentTurn({run:correction.run,agent:registry.getAnyAgent('aa'),parentSpanId:trace.startSpan(correction.run.id,{spanKind:'orchestrator',name:'budget fixture'}).id,messages:[{role:'user',content:'分析接口'}],reviewExit:(_,n)=>n<1?{status:'continue_same_turn',feedback:'补齐证据'}:{status:'allow'},maxOutputTokens:4});
  assert.equal(turn.exitCorrectionAttempts,1); assert.deepEqual(limits,[4,3]); mockProvider.chat=correctionProvider;
  const closeBudget=submit({goal:'分析接口',agentIds:['aa'],constraints:{maxTokens:5}}); const closingLimits=[];
  mockProvider.chat=async req=>{closingLimits.push(req.maxTokens);return closingLimits.length===1?respond('',2,[{id:'read',name:'fs.read',input:JSON.stringify({path:'nonexistent.txt'})}]):respond('基于已有结果完成交付',2);};
  await runAgentTurn({run:closeBudget.run,agent:registry.getAnyAgent('aa'),parentSpanId:trace.startSpan(closeBudget.run.id,{spanKind:'orchestrator',name:'closing budget fixture'}).id,messages:[{role:'user',content:'分析接口'}],maxToolRounds:0,maxOutputTokens:4});
  assert.deepEqual(closingLimits,[4,3]); mockProvider.chat=correctionProvider;
  checks.push('持久化全 Run 预算覆盖纠偏/收尾、缺失用量保守扣费；API/native 截止时间停止并拒绝迟到结果');

  const dynamic=submit({goal:'O4:handoff 检查接口',agentIds:['aa','bb'],recipientIds:['aa']}); assert.equal((await execute(dynamic)).status,'completed',JSON.stringify(listByRun(dynamic.run.id)));
  assert.deepEqual(db.all('SELECT kind FROM runtime_action_commands WHERE run_id=? ORDER BY rowid',dynamic.run.id).map(r=>r.kind),['handoff','complete']);
  const nativeDynamic=submit({goal:'O4:native-handoff 分析接口',agentIds:['sdk-handoff','codex-complete'],recipientIds:['sdk-handoff'],workspace});
  assert.equal((await execute(nativeDynamic)).status,'completed'); assert.deepEqual(db.all('SELECT kind FROM runtime_action_commands WHERE run_id=? ORDER BY rowid',nativeDynamic.run.id).map(r=>r.kind),['handoff','complete']);
  const oldPreview=await coordination.previewCoordination({goal:'O4:handoff 自由协作',agentIds:['aa','bb'],requestedProtocol:'dynamic_collaboration',deterministicOnly:true});
  assert.equal(oldPreview.plan.executionAdapter,'collaboration'); assert.equal(oldPreview.plan.steps.length,0); assert.deepEqual(oldPreview.draft.validationErrors,[]);
  const old=submitLegacyOrchestration('room_create',{goal:'O4:handoff 自由协作',agentIds:['aa','bb'],mode:'collaboration',coordinationDraftId:oldPreview.draft.id});
  assert.equal((await execute(old)).status,'completed'); assert.equal(store.getRunCoordinationPlan(old.run.id).status,'completed'); assert.equal(db.get('SELECT COUNT(*) n FROM coordination_step_attempts WHERE run_id=?',old.run.id).n,0);
  const earlyPreview=await coordination.previewCoordination({goal:'O4:handoff 自由协作',agentIds:['aa','bb'],requestedProtocol:'dynamic_collaboration',deterministicOnly:true});
  const early=submitLegacyOrchestration('room_create',{goal:'O4:handoff 自由协作',agentIds:['aa','bb'],mode:'collaboration',coordinationDraftId:earlyPreview.draft.id});
  await applyRunAction(early.run.id,'pause'); assert.equal(trace.getRun(early.run.id).status,'waiting_for_user');
  await applyRunAction(early.run.id,'resume'); await waitFor(()=>trace.getRun(early.run.id).status==='completed','early dynamic resume');
  assert.equal(store.getRunCoordinationPlan(early.run.id).status,'completed');
  checks.push('动态 API/SDK→Codex 接力；旧 dynamic 委托现有 scheduler，无假步骤，首次准入前暂停可恢复');

  const protocols=await api('/api/coordination/protocols'); assert.ok(protocols.data.every(p=>!['consensus','vote','supervisor_dag'].includes(p.id)));
  const oldDag=await coordination.previewCoordination({goal:'任务图',agentIds:['planner','aa'],requestedProtocol:'supervisor_dag',deterministicOnly:true}); assert.ok(oldDag.plan.validationIssues.some(i=>i.code==='EXPLICIT_DAG_PLANNING_REQUIRED'));
  assert.equal((await api('/api/orchestration/options')).data.templateVersion,'o4-workflows-v1');
  const roomId=dynamic.conversation.id;
  const httpBody={goal:'O4:http 分析接口',recipientIds:['bb'],clientRequestId:'o4-http-new-request'};
  const http=await api(`/api/conversations/${roomId}/requests`,httpBody); assert.equal(http.status,202); assert.equal(http.data.snapshot.executionAuthority,'orchestration');
  await waitFor(()=>trace.getRun(http.data.run.id).status==='completed','HTTP request');
  const httpAgain=await api(`/api/conversations/${roomId}/requests`,httpBody); assert.equal(httpAgain.status,200); assert.equal(httpAgain.data.run.id,http.data.run.id);
  assert.equal((await api(`/api/conversations/${roomId}/requests`,{...httpBody,conversationId:'foreign-room'})).status,400);
  checks.push('未实现协议与旧假 DAG 不公开执行，新聊天室任务 API 及重复提交完成');
  const reviseBody={goal:'O4:revision-graph 比较接口',agentIds:['aa','bb'],recipientIds:['aa','bb'],strategy:'serial',workflow:'routine',constraints:{readonly:true}};
  const toRevise=await confirmed(reviseBody); enqueueConversationRun(toRevise.run.id);
  await waitFor(()=>db.get("SELECT 1 FROM coordination_step_attempts WHERE run_id=? AND status='running'",toRevise.run.id),'revision step started');
  await applyRunAction(toRevise.run.id,'pause'); await waitFor(()=>trace.getRun(toRevise.run.id).status==='waiting_for_user','revision paused');
  const oldBinding=JSON.parse(db.get('SELECT record FROM execution_bindings WHERE run_id=?',toRevise.run.id).record);
  const revisionPreview=await preview({goal:'O4:revised 分别比较接口',conversationId:toRevise.conversation.id,recipientIds:['aa','bb'],strategy:'parallel',workflow:'routine',constraints:{readonly:true}});
  const revPayload={previewId:revisionPreview.previewId,orchestrationFingerprint:revisionPreview.fingerprint,instruction:'改为并行分析并重新验收全部结果'};
  const revised=entry.reviseExecutionOrchestration(toRevise.run.id,revPayload); assert.equal(revised.plan.revision,2); assert.equal(authority.bindingAuthorized(oldBinding),false);
  assert.equal(entry.reviseExecutionOrchestration(toRevise.run.id,revPayload).plan.revision,2);
  assert.equal(db.get('SELECT COUNT(*) n FROM coordination_plan_revisions WHERE plan_id=? AND revision>1',revised.plan.id).n,1);
  await applyRunAction(toRevise.run.id,'resume'); await waitFor(()=>trace.getRun(toRevise.run.id).status==='completed','revision completed');
  assert.equal(store.getRunCoordinationPlan(toRevise.run.id).revision,2);
  const writeBody={goal:'实现并评审',agentIds:['aa','reviewer'],recipientIds:['aa'],workflow:'development_review',defaultReviewerId:'reviewer',workspace};
  const writeToRevise=await confirmed(writeBody); enqueueConversationRun(writeToRevise.run.id);
  await waitFor(()=>db.get("SELECT 1 FROM coordination_step_attempts WHERE run_id=? AND status='running'",writeToRevise.run.id),'write started');
  await applyRunAction(writeToRevise.run.id,'pause'); await waitFor(()=>trace.getRun(writeToRevise.run.id).status==='waiting_for_user','write paused');
  const writePreview=await preview({...writeBody,conversationId:writeToRevise.conversation.id,goal:'修复并重新评审'});
  assert.throws(()=>entry.reviseExecutionOrchestration(writeToRevise.run.id,{previewId:writePreview.previewId,orchestrationFingerprint:writePreview.fingerprint,instruction:'重建写入图'}),/不能用重建图重放/);
  await applyRunAction(writeToRevise.run.id,'cancel');
  checks.push('只读图修订新版本/旧绑定失权/重复确认幂等/恢复新图；已开始的写任务拒绝重放');
  assert.equal(externalRequests,0);
  console.log(JSON.stringify({phase:'O4',passed:checks.length,checks,realProviderRequests:externalRequests},null,2));
} finally { await shutdownExternalAgents(); await app.close(); await new Promise(resolve=>setTimeout(resolve,250)); db.closeDatabase(); await rm(root,{recursive:true,force:true}); }
