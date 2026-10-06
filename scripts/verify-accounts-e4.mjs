import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root = await mkdtemp(path.join(tmpdir(), 'gand-accounts-e4-'));
const database = path.join(root, 'test.sqlite'); const roles = path.join(root, 'roles'); await mkdir(roles);
const calls = []; let child;
const upstream = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); const key = req.headers.authorization?.replace('Bearer ', ''); calls.push({ key, path: req.url, body });
  const planner = body.messages?.some((m) => m.content?.includes?.('__AGENT_GAND_COORDINATION_PLANNER__'));
  const closing = body.tools?.length && body.messages?.some((m) => m.content?.includes?.('E4_CLOSING'));
  const content = planner ? JSON.stringify({ taskType: 'fixture', protocols: [{ protocol: 'single_agent', version: 1 }], reasonCodes: ['E4_FIXTURE'], evidence: [], alternatives: [], missingInformation: [], confidence: 0.9, clarificationQuestion: null }) : 'E4_OK';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(closing ? { tool_calls: [{ id: 'closing-test', type: 'function', function: { name: 'fs_read', arguments: '{"path":"unused"}' } }] } : {}) }, finish_reason: closing ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${upstream.address().port}/v1`;
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', DB_PATH: database, AGENTS_DIR: roles, LOG_LEVEL: 'silent', MCP_SERVER_CMD: '', HOST: '127.0.0.1', PORT: '0', ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', LLM_OPENAI_API_KEY: 'fixture-legacy-key', LLM_OPENAI_BASE_URL: url, LLM_ANTHROPIC_API_KEY: '', COORDINATION_PLANNER_MODEL: '', COORDINATION_PLANNER_ACCOUNT_REF: '', EXTERNAL_CLAUDE_COMMAND: path.join(root, 'missing'), EXTERNAL_CODEX_COMMAND: path.join(root, 'missing'), EXTERNAL_WORKSPACE_DIR: path.join(root, 'workspaces') });
const role = (id, extra = {}) => ({ id, name: id, systemPrompt: 'Return the requested answer', description: 'E4 fixture', model: 'openai:fixture-model', tools: [], disallowedTools: [], capabilities: ['execute', 'coordinate'], permissionMode: 'readonly', color: '#3366aa', avatar: '', source: 'db', enabled: true, version: 1, syncError: null, ...extra });
// Seed the A–D tables without any E1–E4 account tables before importing application initialization.
const old = new Database(database);
const preAccountSchema = (await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8')).replace(/-- Account metadata[\s\S]*?(?=CREATE TABLE IF NOT EXISTS external_agent_executions)/u, '');
old.exec(preAccountSchema);
const legacy = role('legacy-role'); const original = ' ' + JSON.stringify(legacy, null, 2) + '\n';
const created = '2020-01-02T00:00:00.000Z';
for (const agent of [legacy, role('partial-role'), role('explicit-legacy-role', { accountRef: 'legacy-llm-openai', requiresAccount: true }), role('ambiguous-role', { accountRef: 'missing-managed', version: 2 })]) {
  old.prepare("INSERT INTO agents (id,name,definition,source,enabled,version,created_at,updated_at) VALUES (?,?,?,'db',1,?,?,?)").run(agent.id, agent.name, JSON.stringify(agent), agent.version, '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z');
  if (agent.id !== 'ambiguous-role') old.prepare('INSERT INTO agent_versions (agent_id,version,definition,created_at) VALUES (?,1,?,?)').run(agent.id, JSON.stringify(agent), '2020-01-01T00:00:00.000Z');
}
old.prepare('UPDATE agents SET definition=?,version=2 WHERE id=?').run(JSON.stringify(role('legacy-role', { accountRef: 'missing-managed', version: 2 })), legacy.id);
old.prepare('INSERT INTO agent_versions (agent_id,version,definition,created_at) VALUES (?,2,?,?)').run(legacy.id, JSON.stringify(role(legacy.id, { accountRef: 'missing-managed', version: 2 })), '2021-01-01T00:00:00.000Z');
for (const [id, ids] of [['old-preserved', [legacy.id]], ['old-partial', [legacy.id, 'partial-role', 'explicit-legacy-role']], ['old-ambiguous', ['ambiguous-role']]]) old.prepare("INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES (?,?,'pipeline','completed',?,?)").run(id, id, JSON.stringify(ids), created);
for (const id of ['old-preserved', 'old-partial']) old.prepare('INSERT INTO run_agent_snapshots (run_id,agent_id,version,definition,created_at) VALUES (?,?,1,?,?)').run(id, legacy.id, original, created);
old.close();
const { auditAccounts, backupAccounts, verifyBackup } = await import('./accounts-maintenance.mjs');
const beforeBytes = await readFile(database); const before = await auditAccounts(); assert.ok(before.issues.some((i) => i.code === 'MIGRATION_PENDING')); assert.deepEqual(await readFile(database), beforeBytes, 'audit must not migrate or write old database');
const db = await import('../apps/server/src/db/database.ts'); const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts'); const resolver = await import('../apps/server/src/accounts/resolver.ts'); const store = await import('../apps/server/src/accounts/store.ts');
const { config } = await import('../apps/server/src/config.ts'); const { implicitAccount } = await import('../apps/server/src/accounts/legacy.ts');
const { providerForAgent } = await import('../apps/server/src/llm/router.ts'); const { chatOnce, runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { previewCoordination, compileCoordinationPlan, reviseCoordinationPlan } = await import('../apps/server/src/coordination/service.ts'); const { claimRuntimeHost, releaseRuntimeHost } = await import('../apps/server/src/execution/host.ts');
const { createConversation } = await import('../apps/server/src/conversations/service.ts');
const secrets = ['fixture-e4-original-A123', 'fixture-e4-rotated-B456', 'fixture-e4-rebound-C789'];
const accountInput = (displayName, apiKey) => ({ displayName, apiKey, provider: 'custom', protocols: ['openai-chat-completions'], baseUrl: url, models: ['fixture-model'], defaultModel: 'fixture-model', timeoutMs: 5000 });
async function waitFor(check, label) { const end = Date.now() + 15000; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise((r) => setTimeout(r, 40)); } throw new Error('Timeout: ' + label); }
async function stopChild() { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
try {
  trace.backfillRunAgentSnapshots(); trace.backfillRunAgentSnapshots();
  for (const id of ['old-preserved', 'old-partial']) assert.equal(db.get('SELECT definition FROM run_agent_snapshots WHERE run_id=? AND agent_id=?', id, legacy.id).definition, original);
  assert.equal(trace.listRunAgentSnapshots('old-partial').length, 3); assert.equal(trace.listRunAgentSnapshots('old-partial')[0].accountRef, undefined);
  assert.equal(trace.listRunAgentSnapshots('old-partial').find((a) => a.id === 'explicit-legacy-role').accountRef, 'legacy-llm-openai');
  assert.equal(trace.listRunAgentSnapshots('old-ambiguous').length, 0); assert.equal(db.get('SELECT COUNT(*) n FROM run_account_bindings').n, 0);
  assert.equal(implicitAccount(role('draft-role', { requiresAccount: true })), null);
  const { resumePipelineRun } = await import('../apps/server/src/orchestration/pipeline.ts');
  const { resumeSupervisorRun } = await import('../apps/server/src/orchestration/supervisor.ts');
  const noCalls = calls.length;
  for (const [mode, resume] of [['pipeline', resumePipelineRun], ['supervisor', resumeSupervisorRun]]) {
    db.run("UPDATE runs SET status='queued',mode=? WHERE id='old-ambiguous'", mode);
    await resume('old-ambiguous'); assert.equal(trace.getRun('old-ambiguous').status, 'failed'); assert.equal(calls.length, noCalls);
  }
  const { saveCheckpoint } = await import('../apps/server/src/runs/checkpoints.ts');
  const { resumeFastPathRun } = await import('../apps/server/src/conversations/dispatcher.ts');
  db.run("UPDATE runs SET status='queued' WHERE id='old-ambiguous'");
  saveCheckpoint({ runId: 'old-ambiguous', kind: 'fastpath', phase: 'running', state: { agentIds: ['ambiguous-role'] } });
  await resumeFastPathRun('old-ambiguous'); assert.equal(trace.getRun('old-ambiguous').status, 'failed'); assert.equal(calls.length, noCalls);
  await providerForAgent(legacy, 'old-preserved').chat({ model: legacy.model, messages: [{ role: 'user', content: 'legacy' }] }); assert.equal(calls.at(-1).key, 'fixture-legacy-key');
  // Repair fixture current definitions; migration must not do this for the operator.
  db.run('UPDATE agents SET definition=? WHERE id=?', JSON.stringify(legacy), legacy.id);
  const a = store.createAccount(accountInput('Original', secrets[0])); const b = store.createAccount(accountInput('Rebound', secrets[2]));
  const agent = registry.createAgent(role('managed-role', { accountRef: a.id, requiresAccount: true }));
  const teamRoom = createConversation({ title: 'Team planner', mode: 'pipeline', agentIds: [agent.id], supervisorId: null, workspace: null });
  const teamRun = trace.createRun('team planner', 'pipeline', [agent.id], undefined, undefined, teamRoom.id); const frozen = trace.listRunAgentSnapshots(teamRun.id)[0];
  const explicit = config.coordinationPlanner; explicit.model = 'openai:fixture-model'; explicit.accountRef = a.id;
  const plannerRun = trace.createRun('configured planner', 'pipeline', [agent.id]);
  assert.ok(resolver.listRunAccountBindings(plannerRun.id).some((r) => r.agentId === 'system:coordination-planner'));
  const room = createConversation({ title: 'Restart acceptance', mode: 'pipeline', agentIds: [agent.id], supervisorId: null, workspace: null });
  const queued = trace.createRun('E4 queued recovery', 'pipeline', [agent.id], undefined, undefined, room.id);
  // Rotate, edit endpoint and role, disable the old account before process restart.
  let updated = store.replaceCredential(a.id, { apiKey: secrets[1], expectedVersion: a.version });
  updated = store.updateAccount(a.id, { expectedVersion: updated.version, baseUrl: url.replace('/v1', '/changed') });
  registry.updateAgent(agent.id, { ...agent, accountRef: b.id }, agent.version);
  explicit.accountRef = b.id;
  updated = store.updateAccount(a.id, { expectedVersion: updated.version, enabled: false });
  const rootSpan = trace.startSpan(teamRun.id, { spanKind: 'run', name: 'E4 routes' });
  for (const kind of ['message', 'review_protocol']) assert.equal(await chatOnce(frozen, teamRun.id, rootSpan.id, 'E4 single call', kind), 'E4_OK');
  const normal = await runAgentTurn({ run: teamRun, agent: frozen, parentSpanId: rootSpan.id, messages: [{ role: 'user', content: 'E4 normal' }] }); assert.equal(normal.content, 'E4_OK');
  const closing = await runAgentTurn({ run: teamRun, agent: { ...frozen, tools: ['fs.read'] }, parentSpanId: rootSpan.id, executionScopeId: 'e4:closing', messages: [{ role: 'user', content: 'E4_CLOSING' }], maxToolRounds: 0 }); assert.equal(closing.content, 'E4_OK');
  assert.ok(db.all('SELECT attributes FROM run_events WHERE run_id=?', teamRun.id).some((r) => jsonPhase(r.attributes) === 'agent.closing'));
  async function planner(run) { const result = await previewCoordination({ goal: '给出一个简短说明', agentIds: [agent.id] }, run.id); assert.ok(['model', 'model_repaired'].includes(result.draft.planning.source)); assert.equal(calls.at(-1).key, secrets[0]); assert.equal(calls.at(-1).path, '/v1/chat/completions'); return result; }
  const teamPlan = await planner(teamRun); await planner(plannerRun);
  const { setCoordinationPlanStatus } = await import('../apps/server/src/coordination/store.ts');
  const compiled = compileCoordinationPlan(teamPlan.draft.id, teamRun.id, '给出一个简短说明', [frozen]); setCoordinationPlanStatus(compiled.id, 'paused');
  const revised = await reviseCoordinationPlan(teamRun.id, { instruction: '缩短说明，继续使用当前成员' });
  assert.equal(revised.plan.revision, 2); assert.equal(calls.at(-1).key, secrets[0]); assert.equal(calls.at(-1).path, '/v1/chat/completions');
  assert.throws(() => providerForAgent({ ...frozen, accountRef: undefined, requiresAccount: false }, teamRun.id), /禁止回退/);
  assert.throws(() => providerForAgent({ ...frozen, accountRef: b.id }, teamRun.id), /禁止回退/);
  const saved = db.get('SELECT definition FROM run_agent_snapshots WHERE run_id=? AND agent_id=?', teamRun.id, agent.id).definition;
  db.run('UPDATE run_agent_snapshots SET definition=? WHERE run_id=? AND agent_id=?', JSON.stringify({ ...frozen, accountRef: undefined, requiresAccount: false }), teamRun.id, agent.id);
  assert.ok((await auditAccounts()).issues.some((i) => i.runId === teamRun.id && i.code === 'RUN_BINDING_SNAPSHOT_MISMATCH'));
  db.run('UPDATE run_agent_snapshots SET definition=? WHERE run_id=? AND agent_id=?', saved, teamRun.id, agent.id);
  const newRun = trace.createRun('current role', 'pipeline', [agent.id]); assert.equal(resolver.resolveAccount(registry.getAgent(agent.id), newRun.id).apiKey, secrets[2]);
  // A configured planner failure at admission remains a failure after its account is repaired.
  explicit.accountRef = a.id;
  const unavailable = trace.createRun('optional unavailable planner', 'pipeline', [agent.id]); assert.equal(resolver.listRunAccountBindings(unavailable.id).some((r) => r.agentId === 'system:coordination-planner'), false);
  assert.ok(store.references(a.id).activeRuns.some((r) => r.id === unavailable.id), 'optional configured planner remains a protected reference');
  store.updateAccount(a.id, { expectedVersion: updated.version, enabled: true });
  const count = calls.length; const fallback = await previewCoordination({ goal: '给出说明', agentIds: [agent.id] }, unavailable.id); assert.equal(fallback.draft.planning.source, 'deterministic_fallback'); assert.equal(calls.length, count);
  explicit.model = null; explicit.accountRef = null;
  for (const run of [teamRun, plannerRun, newRun, unavailable]) trace.finishRun(run.id, 'completed');
  const beforeRecovery = calls.length; let childOutput = '';
  child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, COORDINATION_PLANNER_ACCOUNT_REF: b.id, COORDINATION_PLANNER_MODEL: 'openai:fixture-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => { childOutput += c; }); child.stderr.on('data', (c) => { childOutput += c; });
  await waitFor(() => trace.getRun(queued.id)?.status === 'completed' || child.exitCode !== null, 'queued recovery');
  assert.equal(trace.getRun(queued.id).status, 'completed'); assert.equal(calls.length, beforeRecovery + 1); assert.equal(calls.at(-1).key, secrets[0]); assert.equal(calls.at(-1).path, '/v1/chat/completions');
  await stopChild(); for (const secret of secrets) assert.ok(!childOutput.includes(secret));
  // Read-only diagnostics distinguish incomplete historical provenance from usable active credentials.
  const audit = await auditAccounts(); assert.ok(audit.issues.some((i) => i.runId === 'old-ambiguous' && i.code === 'RUN_SNAPSHOT_MISSING')); assert.equal(audit.issues.some((i) => i.code === 'CREDENTIAL_LOCKED'), false); for (const secret of secrets) assert.ok(!JSON.stringify(audit).includes(secret));
  // Offline bundle contains matching encrypted DB, master key, private native directories and file roles.
  const nativeDir = path.join(config.accounts.privateDir, 'identities', 'fixture', '1'); await mkdir(nativeDir, { recursive: true, mode: 0o700 }); await writeFile(path.join(nativeDir, 'auth.json'), '{"fixture":"native-auth"}'); await writeFile(path.join(roles, 'fixture.md'), 'Fixture file role');
  const bundle = path.join(root, 'backup'); claimRuntimeHost(); await assert.rejects(backupAccounts(bundle), /服务仍在运行/); releaseRuntimeHost();
  db.run("INSERT INTO external_native_processes (token,execution_id,host,pid,status,created_at) VALUES ('fixture-fence','fixture','localhost',1,'active',?)", new Date().toISOString());
  await assert.rejects(backupAccounts(bundle), /未清理的原生进程/); db.run("DELETE FROM external_native_processes WHERE token='fixture-fence'");
  await symlink(path.join(root, 'test.sqlite'), path.join(roles, 'unsafe-link'));
  await assert.rejects(backupAccounts(bundle), /符号链接/); await rm(path.join(roles, 'unsafe-link')); await assert.rejects(stat(bundle), /ENOENT/);
  const backed = await backupAccounts(bundle); assert.equal(backed.ok, true); assert.equal((await stat(bundle)).mode & 0o077, 0);
  assert.equal((await verifyBackup(bundle)).ok, true);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8')); assert.equal(manifest.externalMasterKeyRequired, false);
  for (const entry of manifest.files) {
    const file = path.join(bundle, entry.path); assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), entry.sha256);
  }
  const backupDb = new Database(path.join(bundle, 'database.sqlite'), { readonly: true }); assert.equal(backupDb.prepare('SELECT COUNT(*) n FROM runs').get().n, db.get('SELECT COUNT(*) n FROM runs').n); backupDb.close();
  await assert.rejects(backupAccounts(bundle), /EEXIST/); assert.ok(await stat(bundle));
  const publicBytes = await readFile(path.join(bundle, 'database.sqlite')); for (const secret of secrets) assert.ok(!publicBytes.includes(Buffer.from(secret)));
  // Actual restore rehearsal in the isolated original path; never touch the operator database.
  db.closeDatabase(); await rm(database); await cp(path.join(bundle, 'database.sqlite'), database); await rm(config.accounts.privateDir, { recursive: true }); await cp(path.join(bundle, 'private'), config.accounts.privateDir, { recursive: true, preserveTimestamps: true });
  const restoredAudit = await auditAccounts(); assert.equal(restoredAudit.issues.some((i) => ['MASTER_KEY_UNAVAILABLE', 'CREDENTIAL_LOCKED'].includes(i.code)), false); assert.equal(await readFile(path.join(nativeDir, 'auth.json'), 'utf8'), '{"fixture":"native-auth"}');
  await writeFile(path.join(bundle, 'roles', 'fixture.md'), 'tampered'); await assert.rejects(verifyBackup(bundle), /不匹配/);
  await rm(path.join(config.accounts.privateDir, 'account-master-key.json'));
  const missing = await auditAccounts(); assert.ok(missing.issues.some((i) => i.code === 'MASTER_KEY_UNAVAILABLE')); await assert.rejects(backupAccounts(path.join(root, 'incomplete-backup')), /认证材料/);
  console.log('E4 验收通过：旧库只读检查/幂等迁移/原快照逐字保留/部分回填/不猜测历史账户/主管与审查单次调用/普通调用与收尾/团队与独立规划器冻结/禁止凭证回退/轮换改址换绑后进程重启恢复/停机备份/原路径恢复/缺主密钥阻断；真实供应商调用 0');
} finally { await stopChild(); db.closeDatabase(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); }
function jsonPhase(value) { return JSON.parse(value)['orchestration.phase']; }
