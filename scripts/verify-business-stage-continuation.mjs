import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-stage-continuation-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'),
  AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_RUNTIME_KERNEL: process.argv.includes('--kernel-off') ? 'off' : 'execute', HOST: '127.0.0.1', PORT: '43220', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:43220' });
globalThis.fetch = () => { throw new Error('No network allowed in stage checkpoint fixture'); };
const db = await import('../apps/server/src/db/database.ts');
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const registry = await import('../apps/server/src/agents/registry.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const coordination = await import('../apps/server/src/coordination/runtime.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const business = await import('../apps/server/src/orchestration/business.ts');
const checkpoints = await import('../apps/server/src/orchestration/businessCheckpointStore.ts');
const { assessRunRecovery } = await import('../apps/server/src/runtime/recovery.ts');
const { previewRunContinuation, submitRunContinuation } = await import('../apps/server/src/orchestration/continuation.ts');
const { getRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { resolveEvidence } = await import('../apps/server/src/runtime/evidence.ts');
const { workspaceRootDir } = await import('../apps/server/src/tools/builtin/index.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { post } = await import('../apps/server/src/messaging/inbox.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const app = Fastify(); await registerRoutes(app); await registerAccountRoutes(app);
for (const id of ['worker','peer']) registry.createAgent({ id, name: id, description: 'checkpoint fixture', systemPrompt: 'Provide substantive deliverables.', model: 'mock:' + id,
  capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '' });
const response = content => ({ content, usage: { tokensIn: 1, tokensOut: 2, costUsd: 0 }, toolCalls: [], truncated: false, stopReason: 'end_turn' });
const calls = []; let failedRun = null, fileFailure = false;
mockProvider.chat = async req => {
  const text = req.messages.map(m => m.content).join('\n'); calls.push({ model: req.model, text, maxTokens: req.maxTokens });
  if (failedRun && text.includes('PARTIAL_DONE')) db.run("UPDATE business_stage_executions SET started_at='2000-01-01T00:00:00.000Z' WHERE run_id=? AND stage_id='phase-1'", failedRun);
  if (fileFailure && text.includes('NEXT_STAGE')) throw new Error('Known read-only fixture failure');
  return response(`完整交付：${text.includes('PARTIAL_DONE') ? 'CONFIRMED_PARTIAL_ONCE' : text.includes('NEXT_STAGE') ? 'NEXT_STAGE_DELIVERY' : 'ACCEPTED_DELIVERY_ONCE'}，包含分析依据和可执行结论。`);
};
const action = (runId, command) => business.applyBusinessCommand(runId, { ...command, expectedVersion: business.getBusinessState(runId).version, clientRequestId: randomUUID() });
function report(runId, stageId, ref = business.listBusinessEvidence(runId).find(e => e.stageId === stageId).ref) {
  return action(runId, { action: 'report', stageId, kind: 'delivery', note: '核对实质交付', evidence: [{ deliverableId: 'result', ref }] });
}
function accept(runId, stageId) {
  return action(runId, { action: 'decide', stageId, reportId: business.getBusinessState(runId).stages.find(s => s.stage.id === stageId).report.id,
    verdict: 'accept', checkedCriteria: [0], reason: '确认通过' });
}
const code = (fn, expected) => assert.throws(fn, e => e.code === expected);
const confirmation = preview => ({ previewId: preview.preview.previewId, orchestrationFingerprint: preview.preview.fingerprint });
const contractFor = file => ({ version: 1, executionMode: 'stage_gated', stages: [
  { id: 'phase-0', title: '确认基础', criteria: ['交付有依据'], deliverables: [{ id: 'result', title: '基础交付', kind: file ? 'file' : 'text' }], execution: { assignments: [{ agentId: 'worker', objective: 'FIRST_STAGE 分析并交付基础' }] } },
  { id: 'phase-1', title: '后续分析', criteria: ['交付可执行'], deliverables: [{ id: 'result', title: '分析结果', kind: 'text' }], execution: { assignments: file ? [{ agentId: 'peer', objective: 'NEXT_STAGE 分析确认文件' }]
    : [{ agentId: 'worker', objective: 'PARTIAL_DONE 完成已确认部分' }, { agentId: 'peer', objective: 'NEXT_STAGE 综合已确认部分' }], timeoutMs: 30000 } },
  { id: 'phase-2', title: '最终建议', criteria: ['提供建议'], deliverables: [{ id: 'result', title: '最终建议', kind: 'text' }], execution: { assignments: [{ agentId: 'peer', objective: 'LAST_STAGE 给出后续建议' }] } },
] });
async function fixture(file = false, budget = false) {
  const contract = contractFor(file);
  if (budget) for (const stage of contract.stages) stage.execution.maxTokens = 10;
  const room = rooms.createConversation({ title: 'stage source', mode: 'collaboration', agentIds: ['worker','peer'], workspace: 'checkpoint-source' });
  const input = { conversationId: room.id, goal: '按阶段完成分析', agentIds: room.agentIds, strategy: 'serial', workflow: 'routine', workspace: room.workspace,
    constraints: { readonly: true, deadlineMs: 30000, ...(budget ? { maxTokens: 20 } : {}) }, businessContract: contract, clientRequestId: randomUUID() };
  const preview = await entry.previewExecutionOrchestration(input);
  assert.deepEqual(preview.decision.issues.filter(i => i.severity === 'error'), []);
  const f = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint }, room.id);
  await coordination.runCoordinationPlan(f.run, f.run.goal); return { ...f, input };
}
async function failedFixture(file = false, budget = false) {
  const f = await fixture(file, budget); let filePath;
  if (file) {
    filePath = path.join(workspaceRootDir({ runId: f.run.id, workspace: f.run.workspace, workspaceScope: f.plan.id.slice(0,8) }), 'reports/result.txt');
    await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(filePath, '已验收完整文件：有依据的分析结论和建议。\n');
    report(f.run.id, 'phase-0', business.businessFileEvidence(f.run.id, { stageId: 'phase-0', path: 'reports/result.txt' }).ref); fileFailure = true;
  } else { report(f.run.id, 'phase-0'); failedRun = f.run.id; }
  accept(f.run.id, 'phase-0');
  await assert.rejects(() => coordination.resumeCoordinationRun(f.run.id)); failedRun = null; fileFailure = false;
  assert.equal(trace.getRun(f.run.id).status, 'failed'); return { ...f, filePath };
}
function sourceRecords(id) {
  return { run: trace.getRun(id), terminal: getRunTerminal(id), ledger: business.businessHistory(id),
    attempts: db.all('SELECT * FROM coordination_step_attempts WHERE run_id=? ORDER BY created_at,id', id),
    plan: store.getRunCoordinationPlan(id), tokens: db.all('SELECT * FROM orchestration_token_reservations WHERE run_id=? ORDER BY id', id) };
}
async function waitFor(fn) { for (let n=0;n<500;n++) { if (fn()) return; await new Promise(r => setTimeout(r,10)); } throw new Error('Fixture wait timed out'); }
try {
  const f = await failedFixture(false, true); const original = sourceRecords(f.run.id); const beforeCalls = calls.length;
  assert.equal(assessRunRecovery(f.run.id).continuationAllowed, true);
  assert.equal(assessRunRecovery(f.run.id).continuationKind, 'business_stages');
  await assert.rejects(() => previewRunContinuation(f.run.id), e => e.code === 'OWNER_REQUIRED');
  const preview = await previewRunContinuation(f.run.id, true);
  assert.equal(calls.length, beforeCalls, 'preview is model free');
  assert.deepEqual(preview.checkpoint.business.acceptedStageIds, ['phase-0']);
  assert.equal(preview.checkpoint.business.carriedRunTokens, 4);
  assert.equal(preview.preview.request.workspace, null);
  assert.deepEqual(preview.preview.plan.plan.steps.filter(s => s.agentId).map(s => s.id), ['stage-2-work-2','stage-3-work-1']);
  const next = submitRunContinuation(f.run.id, confirmation(preview), true);
  assert.equal(next.run.workspace, null, 'fresh workspace instead of shared source');
  assert.equal(submitRunContinuation(f.run.id, confirmation(preview), true).run.id, next.run.id);
  code(() => submitRunContinuation(f.run.id, { ...confirmation(preview), previewId: randomUUID() }, true), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(sourceRecords(f.run.id), original, 'no source terminal, ledger, plan, attempts or budget mutation');
  code(() => action(f.run.id, { action: 'resolve', outcome: 'partial_accepted', reason: 'late change' }), 'SOURCE_CONTINUED');
  let state = business.getBusinessState(next.run.id);
  assert.equal(state.stages[0].status, 'accepted'); assert.equal(state.stages[0].execution.status, 'accepted');
  assert.equal(state.stages[0].report.id, business.getBusinessState(f.run.id).stages[0].report.id, 'provenance preserves the original report');
  assert.equal(state.checkpoint.completedWorkers, 2);
  const imported = business.listBusinessEvidence(next.run.id).find(e => e.stageId === 'phase-1');
  assert.match(imported.excerpt, /CONFIRMED_PARTIAL_ONCE/);
  assert.equal(resolveEvidence(next.run.id, { kind: 'attempt_output', id: 'unrelated-attempt' }).trusted, false);
  await coordination.runCoordinationPlan(trace.getRun(next.run.id), next.run.goal);
  assert.equal(calls.length, beforeCalls + 1, 'accepted and completed partial steps never replay');
  assert.match(calls.at(-1).text, /CONFIRMED_PARTIAL_ONCE/); assert.match(calls.at(-1).text, /ACCEPTED_DELIVERY_ONCE/);
  assert.equal(calls.at(-1).maxTokens, 8, 'stage output reservation retains the prior charge');
  state = business.getBusinessState(next.run.id); assert.ok(state.stages[1].execution.canAccept);
  assert.equal(state.stages[1].execution.chargedTokens, 4);
  report(next.run.id, 'phase-1', imported.ref); accept(next.run.id, 'phase-1'); await coordination.resumeCoordinationRun(next.run.id);
  report(next.run.id, 'phase-2'); accept(next.run.id, 'phase-2'); await coordination.resumeCoordinationRun(next.run.id);
  assert.equal(business.getBusinessState(next.run.id).outcome, 'achieved'); assert.equal(trace.getRun(next.run.id).status, 'completed');
  assert.deepEqual(sourceRecords(f.run.id), original);

  // Unknown usage, private context and rejected candidates are never silently imported.
  const unknown = await failedFixture();
  db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,1,'unknown',?)", randomUUID(), unknown.run.id, new Date().toISOString());
  assert.equal(assessRunRecovery(unknown.run.id).reasonCodes[0], 'RESULT_UNKNOWN');
  const privateRun = await failedFixture(); post({ runId: privateRun.run.id, from: 'worker', to: 'peer', kind: 'agent', body: 'PRIVATE_STATE', visibility: 'private' });
  assert.equal(assessRunRecovery(privateRun.run.id).reasonCodes[0], 'PRIVATE_CHECKPOINT_UNSUPPORTED');
  const rejected = await failedFixture();
  db.run("INSERT INTO business_acceptance_events(id,run_id,version,client_request_id,command_digest,payload,created_at) VALUES (?,?,3,?,?,?,?)", randomUUID(), rejected.run.id, randomUUID(), 'fixture', JSON.stringify({ action:'report',stageId:'phase-1',report:{id:'reject-report',stageId:'phase-1',kind:'delivery',note:'',evidence:[],createdAt:new Date().toISOString()} }), new Date().toISOString());
  action(rejected.run.id, { action:'decide',stageId:'phase-1',reportId:'reject-report',verdict:'reject',checkedCriteria:[],reason:'需要明确返工' });
  assert.equal(assessRunRecovery(rejected.run.id).reasonCodes[0], 'STAGE_REWORK_REQUIRED');

  // Content and ledger changes invalidate a preview; archived bytes survive original deletion.
  const fileRun = await failedFixture(true); const filePreview = await previewRunContinuation(fileRun.run.id, true);
  assert.equal(filePreview.checkpoint.business.files.length, 1);
  await writeFile(fileRun.filePath, 'changed');
  code(() => submitRunContinuation(fileRun.run.id, confirmation(filePreview), true), 'DELIVERY_CHANGED');
  await writeFile(fileRun.filePath, '已验收完整文件：有依据的分析结论和建议。\n');
  const fileNext = submitRunContinuation(fileRun.run.id, confirmation(filePreview), true);
  await rm(fileRun.filePath);
  checkpoints.materializeBusinessCheckpoint(fileNext.run.id);
  const targetPath = path.join(config.sandboxDir, 'runs', fileNext.run.id, 'reports/result.txt');
  assert.match(await readFile(targetPath,'utf8'), /已验收完整文件/); checkpoints.materializeBusinessCheckpoint(fileNext.run.id);
  await writeFile(targetPath, 'unexpected file drift');
  code(() => checkpoints.materializeBusinessCheckpoint(fileNext.run.id), 'CHECKPOINT_FILE_CHANGED');
  await rm(targetPath); await symlink(path.join(root, 'outside'), targetPath);
  code(() => checkpoints.materializeBusinessCheckpoint(fileNext.run.id), 'CHECKPOINT_FILE_CHANGED');
  await rm(targetPath);
  code(() => checkpoints.materializeBusinessCheckpoint(fileNext.run.id), 'CHECKPOINT_FILE_CHANGED');
  // R3 never silently repairs a drifted restore. Explicit owner reconciliation of this fixture restores the exact bytes.
  await writeFile(targetPath, '已验收完整文件：有依据的分析结论和建议。\n', {mode:0o600}); checkpoints.materializeBusinessCheckpoint(fileNext.run.id);
  await coordination.runCoordinationPlan(trace.getRun(fileNext.run.id), fileNext.run.goal);
  assert.ok(business.getBusinessState(fileNext.run.id).stages[1].execution.canAccept);
  const frozenOutput = checkpoints.readBusinessCheckpoint(fileNext.run.id).outputs[0];
  db.run("UPDATE coordination_step_attempts SET output='source drift' WHERE id=?", frozenOutput.attemptId);
  assert.equal(resolveEvidence(fileNext.run.id, { kind:'attempt_output',id:frozenOutput.attemptId }).contentSha256, frozenOutput.sha256, 'target resolves immutable archive');
  report(fileNext.run.id, 'phase-1'); accept(fileNext.run.id, 'phase-1'); fileFailure = true;
  await assert.rejects(() => coordination.resumeCoordinationRun(fileNext.run.id)); fileFailure = false;
  const chainPreview = await previewRunContinuation(fileNext.run.id, true);
  assert.deepEqual(chainPreview.checkpoint.business.acceptedStageIds, ['phase-0','phase-1']);
  const chain = submitRunContinuation(fileNext.run.id, confirmation(chainPreview), true);
  const chainCalls = calls.length; await coordination.runCoordinationPlan(trace.getRun(chain.run.id), chain.run.goal);
  assert.equal(calls.length, chainCalls + 1, 'a second continuation does not repeat either accepted stage');
  assert.match(await readFile(path.join(config.sandboxDir, 'runs', chain.run.id, 'reports/result.txt'), 'utf8'), /已验收完整文件/);
  report(chain.run.id, 'phase-2'); accept(chain.run.id, 'phase-2'); await coordination.resumeCoordinationRun(chain.run.id);
  assert.equal(business.getBusinessState(chain.run.id).outcome, 'achieved');

  const stale = await failedFixture(); const stalePreview = await previewRunContinuation(stale.run.id, true);
  action(stale.run.id, { action:'report',stageId:'phase-1',kind:'receipt',note:'new owner ledger event',evidence:[] });
  code(() => submitRunContinuation(stale.run.id, confirmation(stalePreview), true), 'PREVIEW_STALE');
  const exhausted = await failedFixture(false, true);
  db.run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,used,status,created_at) VALUES (?,?,'phase-1',10,10,'settled',?)", randomUUID(), exhausted.run.id, new Date().toISOString());
  assert.equal(assessRunRecovery(exhausted.run.id).reasonCodes[0], 'CHECKPOINT_BUDGET_EXHAUSTED');
  const corrupt = db.get('SELECT manifest FROM business_run_checkpoints WHERE run_id=?', fileNext.run.id).manifest;
  db.run("UPDATE business_run_checkpoints SET manifest='{}' WHERE run_id=?", fileNext.run.id);
  code(() => checkpoints.readBusinessCheckpoint(fileNext.run.id), 'CHECKPOINT_CORRUPT');
  db.run('UPDATE business_run_checkpoints SET manifest=? WHERE run_id=?', corrupt, fileNext.run.id);
  const archiveRow = db.get('SELECT * FROM business_run_checkpoints WHERE run_id=?', fileNext.run.id);
  db.run('DELETE FROM business_run_checkpoints WHERE run_id=?', fileNext.run.id);
  code(() => business.getBusinessState(fileNext.run.id), 'CHECKPOINT_CORRUPT');
  db.run('INSERT INTO business_run_checkpoints(run_id,source_run_id,manifest,digest,created_at) VALUES (?,?,?,?,?)', archiveRow.run_id, archiveRow.source_run_id, archiveRow.manifest, archiveRow.digest, archiveRow.created_at);
  const cold = execFileSync(process.execPath, ['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',
    "const {getBusinessState}=await import('./apps/server/src/orchestration/business.ts'); const {db}=await import('./apps/server/src/db/database.ts'); console.log(JSON.stringify(getBusinessState(process.env.CHECKPOINT_RUN))); db.close();"],
    { env:{...process.env,CHECKPOINT_RUN:next.run.id},encoding:'utf8' });
  assert.equal(JSON.parse(cold.trim()).checkpoint.completedWorkers,2); assert.equal(JSON.parse(cold.trim()).outcome,'achieved');

  // All stage progress is owner data: public legacy route cannot bypass the cookie/CSRF boundary.
  const http = await failedFixture(); const publicResponse = await app.inject({method:'POST',url:`/api/runs/${http.run.id}/continuation-preview`});
  assert.equal(publicResponse.statusCode,403);
  const endpoint = `/api/accounts/business/${http.run.id}/continuation-preview`, host={host:'127.0.0.1:43220'};
  assert.equal((await app.inject({method:'POST',url:endpoint,headers:host})).statusCode,401);
  const session=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...host,'x-gand-bootstrap':'1'}});
  const auth={...host,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
  assert.equal((await app.inject({method:'POST',url:endpoint,headers:{...auth,'x-gand-csrf':''}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:endpoint,headers:{...auth,origin:'https://untrusted.invalid'}})).statusCode,403);
  const hp=await app.inject({method:'POST',url:endpoint,headers:auth}); assert.equal(hp.statusCode,200,hp.body);
  code(() => entry.submitExecutionOrchestration({ ...http.input, clientRequestId:'continuation:'+http.run.id, entryVersion:1, ...confirmation(hp.json()) }, http.run.conversationId), 'PREVIEW_STALE');
  const submitUrl=`/api/accounts/business/${http.run.id}/continuations`;
  const admitted=await app.inject({method:'POST',url:submitUrl,headers:auth,payload:confirmation(hp.json())}); assert.equal(admitted.statusCode,202,admitted.body);
  const id=admitted.json().run.id; await waitFor(() => business.getBusinessState(id).stages[1].execution.canAccept);
  const again=await app.inject({method:'POST',url:submitUrl,headers:auth,payload:confirmation(hp.json())}); assert.equal(again.statusCode,200); assert.equal(again.json().run.id,id);
  assert.equal(db.get('SELECT COUNT(*) n FROM business_run_checkpoints WHERE source_run_id=?',http.run.id).n,1);
  console.log(`通过：Owner 预览/CSRF/来源校验、唯一关联 Run、已验收前缀与已完成成员不重放、归档证据及文件迁移、哈希漂移/路径链接/检查点损坏围栏、Token 结转、未知消耗/私密/拒绝返工阻断、原终态账本不可变、后续验收/冷进程读取（kernel=${process.env.COORDINATION_RUNTIME_KERNEL}）。仅临时数据库与模拟 API，无模型网络请求或监听端口。`);
} finally { await app.close(); db.db.close(); await rm(root,{recursive:true,force:true}); }
