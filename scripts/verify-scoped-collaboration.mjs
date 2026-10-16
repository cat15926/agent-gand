// G1 storage/boundary fixtures only: scoped worker admission deliberately remains closed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-scoped-g1-'));
for (const key of Object.keys(process.env)) if (/^(LLM_|ACCOUNT_|ANTHROPIC_|OPENAI_|EXTERNAL_|MCP_)/.test(key)) delete process.env[key];
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), AGENT_GAND_PRIVATE_DIR: path.join(root, 'private') });
globalThis.fetch = () => { throw new Error('G1 forbids network'); };
const { config } = await import('../apps/server/src/config.ts');
config.dataDir = root; config.sandboxDir = path.join(root, 'sandbox');
// Upgrade an already-recorded v12 and a pre-fingerprint command table without rewriting history.
const { default: Database } = await import('../apps/server/node_modules/better-sqlite3/lib/index.js');
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`CREATE TABLE orchestration_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);
  INSERT INTO orchestration_schema_migrations VALUES(12,'scoped-collaboration-foundation-v1','41db07fd6801da02da567691dc328cf771bd8728cdc643f2147ba1b4961d2207','2026-10-13');
  CREATE TABLE runtime_action_commands(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,command_key TEXT NOT NULL UNIQUE,
    attempt_id TEXT,dispatch_id TEXT,result TEXT NOT NULL,created_at TEXT NOT NULL,committed_at TEXT NOT NULL);
  INSERT INTO runtime_action_commands VALUES('historical','historical','hold','historical',NULL,NULL,'{}','2026-10-13','2026-10-13');`);
legacy.close();
const db = await import('../apps/server/src/db/database.ts');
const scopes = await import('../apps/server/src/runtime/scopedCollaboration.ts');
const policy = await import('../apps/server/src/runtime/runPolicy.ts');
const { freezeRuntimeContract, normalizeRuntimeControlAction, runtimeControlActionVersion } = await import('../apps/server/src/runtime/controlAction.ts');
const { collaborationControlTools, parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');
const { assembleCollaborationContext } = await import('../apps/server/src/runtime/context.ts');
const { commitHoldActionCommand } = await import('../apps/server/src/runtime/actionCommands.ts');
const { scopedCollaborationCapabilities } = await import('../apps/server/src/runtime/scopedCapabilities.ts');
const { prepareNativeSession } = await import('../apps/server/src/execution/sessions.ts');
const { assertOrchestrationSchemaCompatible } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { post } = await import('../apps/server/src/messaging/inbox.ts');
const { createManagedArtifact } = await import('../apps/server/src/artifacts/store.ts');
const now = new Date().toISOString(), privateAccess = { visibility: 'private', audience: ['a', 'user'] };
const code = expected => error => error.code === expected;
const deny = (fn, expected) => assert.throws(fn, code(expected));
function fixture(privateRoot = false) {
  const runId = randomUUID(), roomId = randomUUID(), subjectId = randomUUID(), dispatchId = randomUUID();
  db.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)', roomId, 'G1 fixture', 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,?,?,?,?,?,?)', runId, 'ROOT_MUST_NOT_BE_INJECTED', 'collaboration', roomId, 'running', '["a","b"]', now);
  const rootMessage = post({ runId, from: 'user', to: 'a', kind: 'user', body: 'ROOT_MUST_NOT_BE_INJECTED', ...(privateRoot ? privateAccess : {}) });
  const contract = { version: 1, runId, objective: 'ROOT_MUST_NOT_BE_INJECTED', participantIds: ['a', 'b'], requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
    executionPolicy: policy.executionPolicyForProfile('execute', { toolApiVersion: 3, implicitAnswerPolicy: 'explicit_only' }),
    features: { completionEngine: true, controlActionVersion: 3, messageVisibilityVersion: 1,
      completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1, contextContributorVersion: 1,
      durableHoldVersion: 2, exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
      scopedCollaboration: { boundaryVersion: 2, manifestVersion: 1, provenanceVersion: 1, policyRevision: 1, capabilityPackage: 'scoped-control-v1' } } };
  freezeRuntimeContract(contract);
  db.run('INSERT INTO runtime_subjects VALUES(?,?,?,?,?,?,?,?,?)', subjectId, runId, 'root:a', 'root', null, 'active', 'review', now, now);
  db.run('INSERT INTO runtime_custody VALUES(?,?,?,?,?,?,?)', subjectId, 'owned', 'a', null, 1, 1, now);
  db.run('INSERT INTO collaboration_dispatches(id,run_id,conversation_id,source_message_id,kind,from_actor,target_agent_id,status,depth,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', dispatchId, runId, roomId, rootMessage.id, 'initial', 'user', 'a', 'running', 0, dispatchId, now);
  db.run('INSERT INTO runtime_dispatch_subjects VALUES(?,?,?)', dispatchId, subjectId, 1);
  let attemptNo = 0;
  const attempt = () => {
    const id = randomUUID();
    db.run('INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_owner,lease_expires_at,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, dispatchId, runId, roomId, 'a', ++attemptNo, 'running', 'g1-fixture', new Date(Date.now() + 60000).toISOString(), now, now);
    return id;
  };
  const message = (body, acl = privateAccess) => scopes.compileScopedSource(runId, 'message', post({ runId, from: 'user', to: acl.visibility === 'private' && !acl.audience.includes('a') ? 'b' : 'a', kind: 'agent', body, ...acl }).id);
  const create = (objective, more = {}) => scopes.createExecutionScope({ runId, subjectId, agentId: 'a', kind: 'content', recoveryGeneration: 1, defaultOutputAccess: privateAccess, objective, inputs: [], ...more });
  const binding = scope => ({ runId, scopeId: scope.id, attemptId: attempt(), agentId: 'a' });
  return { runId, roomId, subjectId, dispatchId, contract, message, create, binding };
}
try {
  assert.equal(db.get('SELECT MAX(version) v FROM orchestration_schema_migrations').v, 16);
  assert.equal(db.get('SELECT boundary_fingerprint FROM runtime_action_commands WHERE id=?', 'historical').boundary_fingerprint, null);
  assert.equal(db.get('SELECT checksum FROM orchestration_schema_migrations WHERE version=12').checksum, '41db07fd6801da02da567691dc328cf771bd8728cdc643f2147ba1b4961d2207');
  const f = fixture(), a = f.message('ONLY_TASK_A'), b = f.message('ONLY_TASK_B'), extra = f.message('APPROVED_SUPPLEMENT');
  f.message('UNLISTED_SAME_AUDIENCE_HISTORY');
  const sa = f.create(a, { dynamicInputs: [extra], allowedTools: ['fs.read', 'fixture.tool'] }), sb = f.create(b);
  assert.notEqual(sa.contextManifestId, sb.contextManifestId);
  assert.notEqual(sa.sessionBoundaryId, sb.sessionBoundaryId);
  const ba = f.binding(sa), bb = f.binding(sb);
  assert.equal(scopes.assembleScopedContext(ba), 'ONLY_TASK_A');
  assert.equal(scopes.assembleScopedContext(bb), 'ONLY_TASK_B');
  assert.equal(scopes.inputLedgerRevision(ba.attemptId), 1);
  assert.equal(scopes.assembleScopedContext(ba), 'ONLY_TASK_A');
  assert.equal(scopes.inputLedgerRevision(ba.attemptId), 1, 'reassembly is idempotent');
  deny(() => scopes.assembleScopedContext({ ...ba, scopeId: sb.id }), 'SCOPE_BINDING_INVALID');
  deny(() => scopes.assembleScopedContext({ ...ba, agentId: 'b' }), 'SCOPE_BINDING_INVALID');
  deny(() => scopes.assembleScopedContext({ ...ba, runId: randomUUID() }), 'SCOPE_BINDING_INVALID');
  deny(() => scopes.exposeScopedInput(ba, b, 'supplement'), 'SCOPE_NOT_READABLE');
  deny(() => scopes.exposeScopedInput(ba, extra, 'tool_result', 'unapproved'), 'SCOPE_NOT_READABLE');
  const initialHash = db.get('SELECT context_sha256 FROM runtime_context_assemblies WHERE attempt_id=?', ba.attemptId).context_sha256;
  assert.equal(scopes.exposeScopedInput(ba, extra, 'tool_result', 'fixture.tool').toString(), 'APPROVED_SUPPLEMENT');
  assert.equal(scopes.inputLedgerRevision(ba.attemptId), 2);
  assert.equal(db.get('SELECT context_sha256 FROM runtime_context_assemblies WHERE attempt_id=?', ba.attemptId).context_sha256, initialHash);
  const output = { ...ba, ledgerRevision: 2, outputAccess: privateAccess };
  deny(() => scopes.commitScopedOutput({ ...output, ledgerRevision: 1 }, () => assert.fail('stale action executed')), 'INPUT_LEDGER_STALE');
  deny(() => scopes.commitScopedOutput({ ...output, outputAccess: { visibility: 'public', audience: [] } }, () => assert.fail('public output executed')), 'PRIVATE_OUTPUT_REQUIRES_RELEASE');
  const command = { runId: f.runId, dispatchId: f.dispatchId, attemptId: ba.attemptId, commandKey: 'g1-output', scope: output,
    execute: () => ({ ok: true }) };
  assert.equal(commitHoldActionCommand(command).committed, true);
  assert.equal(commitHoldActionCommand(command).committed, false);
  assert.throws(() => commitHoldActionCommand({ ...command, scope: { ...output, scopeId: sb.id } }), /幂等键冲突/);
  deny(() => commitHoldActionCommand({ ...command, commandKey: 'missing-binding', scope: undefined }), 'SCOPE_BINDING_INVALID');
  deny(() => scopes.commitScopedOutput(output, () => {
    scopes.exposeScopedInput(ba, extra, 'supplement');
    db.run("UPDATE runs SET title='must-rollback' WHERE id=?", f.runId);
  }), 'INPUT_LEDGER_STALE');
  assert.equal(scopes.inputLedgerRevision(ba.attemptId), 2, 'new input and action roll back together');
  db.db.exec("CREATE TEMP TRIGGER g1_deny_ledger BEFORE INSERT ON runtime_input_provenance BEGIN SELECT RAISE(ABORT, 'fixture ledger failure'); END");
  assert.throws(() => scopes.exposeScopedInput(ba, extra, 'supplement'), /fixture ledger failure/);
  assert.equal(scopes.inputLedgerRevision(ba.attemptId), 2, 'failed registration must not return input bytes');
  db.db.exec('DROP TRIGGER g1_deny_ledger');
  assert.notEqual(db.get('SELECT title FROM runs WHERE id=?', f.runId).title, 'must-rollback');
  assert.equal(scopes.scopedSessionBoundary(ba).resumeAllowed, false);
  assert.notDeepEqual(scopes.scopedSessionBoundary(ba), scopes.scopedSessionBoundary(bb));
  await assert.rejects(prepareNativeSession({ run: { id: f.runId } }, {}, new AbortController().signal), /BACKEND_SCOPE_UNSUPPORTED/);
  assert.throws(() => assembleCollaborationContext({ run: { id: f.runId }, dispatch: {}, agent: {}, attemptId: ba.attemptId }), /SCOPE_BINDING_INVALID/);

  const artifact = createManagedArtifact({ runId: f.runId, path: 'material.txt', content: Buffer.from('FILE_MATERIAL'), access: privateAccess, createdBy: 'user' });
  const fileRef = scopes.compileScopedSource(f.runId, 'artifact', artifact.id);
  const sf = f.create(a, { dynamicInputs: [fileRef], allowedTools: ['fs.read'] }), bf = f.binding(sf);
  scopes.assembleScopedContext(bf);
  assert.equal(scopes.exposeScopedInput(bf, fileRef, 'file_read', 'fs.read').toString(), 'FILE_MATERIAL');
  // A result created AFTER the manifest is compiled is admitted only by its trusted same-Attempt tool binding.
  const st = f.create(a, { allowedTools: ['fixture.tool'] }), bt = f.binding(st), toolId = randomUUID();
  scopes.assembleScopedContext(bt);
  db.run('INSERT INTO tool_executions(id,run_id,agent_id,attempt_id,tool_name,idempotency_key,input,replay_policy,status,output,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    toolId, f.runId, 'a', bt.attemptId, 'fixture.tool', toolId, '{}', 'safe', 'completed', 'DYNAMIC_TOOL_RESULT', now, now);
  const toolRef = scopes.compileScopedSource(f.runId, 'tool_execution', toolId);
  assert.equal(scopes.exposeScopedInput(bt, toolRef, 'mcp_result', 'fixture.tool').toString(), 'DYNAMIC_TOOL_RESULT');
  assert.equal(scopes.inputLedgerRevision(bt.attemptId), 2);
  deny(() => scopes.exposeScopedInput(ba, toolRef, 'tool_result', 'fixture.tool'), 'SCOPE_NOT_READABLE');
  const narrow = f.message('B_ONLY', { visibility: 'private', audience: ['b', 'user'] });
  deny(() => f.create(narrow), 'SCOPE_NOT_READABLE');
  const secretRoot = fixture(true), publicMaterial = secretRoot.message('PUBLIC', { visibility: 'public', audience: [] });
  deny(() => secretRoot.create(publicMaterial, { defaultOutputAccess: { visibility: 'public', audience: [] } }), 'SCOPE_NOT_READABLE');
  deny(() => f.create(secretRoot.message('CROSS_RUN')), 'SCOPE_NOT_READABLE');
  db.run('UPDATE messages SET body=? WHERE id=?', 'MUTATED_BYTES', extra.id);
  deny(() => scopes.exposeScopedInput(ba, extra, 'supplement'), 'SOURCE_VERSION_CHANGED');
  deny(() => scopes.assertScopedOutput(output), 'SOURCE_VERSION_CHANGED');
  for (const table of ['runtime_execution_scopes', 'runtime_context_manifests', 'runtime_scope_attempts', 'runtime_input_provenance']) {
    assert.throws(() => db.run(`DELETE FROM ${table}`), /immutable/);
  }
  assert.throws(() => db.run("UPDATE runtime_context_manifests SET record='{}'"), /immutable/);
  db.run("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01' WHERE id=?", bb.attemptId);
  deny(() => scopes.assembleScopedContext(bb), 'SCOPE_BINDING_INVALID');
  db.run("UPDATE collaboration_attempts SET lease_expires_at='not-a-date' WHERE id=?", bb.attemptId);
  deny(() => scopes.assembleScopedContext(bb), 'SCOPE_BINDING_INVALID');
  const finish = fixture(), finishScope = finish.create(finish.message('COMPLETE_RESULT')), finishBinding = finish.binding(finishScope);
  scopes.assembleScopedContext(finishBinding);
  scopes.commitScopedOutput({ ...finishBinding, ledgerRevision: 1, outputAccess: privateAccess }, () => {
    db.run("UPDATE runtime_subjects SET status='completed' WHERE id=?", finish.subjectId);
  });
  assert.equal(db.get('SELECT status FROM runtime_subjects WHERE id=?', finish.subjectId).status, 'completed');

  assert.equal(policy.resolveRunPolicy(f.runId).toolApiVersion, 3);
  deny(() => policy.assertExecutableCollaborationPolicy(f.runId), 'RUNTIME_CAPABILITY_UNAVAILABLE');
  assert.throws(() => runtimeControlActionVersion(f.runId), /RUNTIME_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => collaborationControlTools(3), /RUNTIME_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => parseControlCall({ name: 'agent.complete', input: '{"summary":"done"}' }, ['a'], 'a', 3), /Unsupported/);
  assert.equal(normalizeRuntimeControlAction({ version: 99, type: 'finish' }).ok, false);
  assert.equal(normalizeRuntimeControlAction({ version: 3, type: 'acknowledge', envelopeId: 'x' }).ok, false, 'ACK must never turn into complete');
  for (const mutate of [c => c.features.controlActionVersion = 99, c => c.executionPolicy.toolApiVersion = 99,
    c => c.features.scopedCollaboration.boundaryVersion = 99, c => delete c.executionPolicy,
    c => c.features.scopedCollaboration.capabilityPackage = 'unknown',
    c => c.features.scopedCollaboration.recoveryVersion = 2,
    c => c.features.scopedCollaboration.recoveryVersion = 1, // deliveryVersion is absent on this G1 fixture
    c => c.features.scopedCollaboration.releaseVersion = 2,
    c => c.features.scopedCollaboration.releaseVersion = 1]) {
    const bad = structuredClone(f.contract); bad.runId = randomUUID(); mutate(bad);
    assert.throws(() => freezeRuntimeContract(bad));
    assert.equal(db.get('SELECT 1 FROM runtime_contracts WHERE run_id=?', bad.runId), undefined, 'invalid freeze rolls back');
  }
  for (const backend of ['builtin-llm', 'claude-sdk', 'codex-app-server', 'claude-cli', 'codex-exec']) {
    for (const cap of scopedCollaborationCapabilities(backend)) {
      const g2 = backend === 'builtin-llm';
      assert.equal(cap.implementationSupported, g2); assert.equal(cap.configuredAvailable, g2);
      assert.equal(cap.connectionVerified, false); assert.equal(cap.verifiedAt, null);
    }
  }
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
  const app = Fastify();
  try {
    await registerRoutes(app);
    const response = await app.inject({ method: 'GET', url: `/api/runs/${f.runId}/collaboration-capabilities` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.toolApiVersion, 3);
    assert.equal(body.backends.length, 5);
    assert.deepEqual(body.allowedRecovery, []);
    assert.ok(body.backends.every(b => b.capabilities.every(c => c.configuredAvailable === (b.backend === 'builtin-llm') && !c.connectionVerified)));
    assert.doesNotMatch(response.body, /ONLY_TASK|APPROVED_SUPPLEMENT|ROOT_MUST_NOT|UNLISTED/);
  } finally { await app.close(); }
  db.run("INSERT INTO orchestration_schema_migrations VALUES(17,'future','unknown',?)", now);
  assert.throws(() => assertOrchestrationSchemaCompatible(db.db), /17/);
  console.log('G1 verified: immutable manifests, separate same-audience scopes, whitelist context, dynamic provenance, atomic output guards, stale/cross-run/lease rejection, cold sessions, closed v3 admission and unknown-version rejection.');
} finally { db.closeDatabase(); await rm(root, { recursive: true, force: true }); }
