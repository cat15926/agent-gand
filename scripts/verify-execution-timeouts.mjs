import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'gand-model-timeouts-'));
const workspace = path.join(root, 'workspace'); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), '# Timeout fixture');
const executable = path.join(root, 'fake claude');
await copyFile(new URL('./fixtures/external-agent-cli.mjs', import.meta.url), executable); await chmod(executable, 0o755);
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), NODE_ENV: 'test', MCP_SERVER_CMD: '', LOG_LEVEL: 'silent',
  EXTERNAL_CLAUDE_COMMAND: executable, EXTERNAL_AGENT_TIMEOUT_MS: '5000', FAKE_AGENT_LOG: path.join(root, 'calls.jsonl') });
// All imports follow isolated DB_PATH. No listeners or real provider calls.
const database = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const { budgetedChat } = await import('../apps/server/src/orchestration/executionBudget.ts');
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
config.llm.proxy = null;
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('../apps/server/node_modules/undici/index.js');
const originalDispatcher = getGlobalDispatcher(); const dispatcher = new MockAgent(); dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher);
const { getRunOrchestrationSnapshot } = await import('../apps/server/src/orchestration/store.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { runAgentTurn, chatOnce } = await import('../apps/server/src/orchestration/agentStep.ts');
const { runExternalAgentTurn, shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const { detectDriver } = await import('../apps/server/src/execution/drivers.ts');
const { enterMember } = await import('../apps/server/src/execution/memberAdmission.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const { mockProvider, AnthropicProvider, OpenAICompatibleProvider, LlmHttpError } = await import('../apps/server/src/llm/provider.ts');
const { executionFailureForRun } = await import('../apps/web/src/services/executionFailure.ts');
const { NativeEventParser } = await import('../apps/server/src/execution/parsers.ts');
const { normalizeOrchestrationRequest } = await import('../apps/server/src/orchestration/normalize.ts');
const { createEmptyRoom } = await import('../apps/server/src/conversations/entry.ts');
const { getConversation } = await import('../apps/server/src/conversations/service.ts');
const { isRoomPreferences } = await import('../packages/shared/src/roomPreferences.ts');
const { readRoomDraft, writeRoomDraft, emptyPreferences } = await import('../apps/web/src/services/roomDraft.ts');
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Real network is forbidden in timeout fixture'); };
const registered = registerExternal({ path: workspace });
const role = id => ({ id, name: id, description: 'timeout fixture', systemPrompt: 'Analyze only.', model: 'mock:fixture', tools: [], disallowedTools: [], permissionMode: 'readonly', capabilities: ['execute'], color: '#4477aa', avatar: '' });
registry.createAgent(role('worker'));
registry.createAgent({ ...role('cli'), model: 'default', execution: { kind: 'external', driver: 'claude-cli' } });
const events = []; const unsubscribe = subscribe(event => events.push(event));
const response = { content: 'fixture result', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 }, stopReason: 'stop', truncated: false };
const pendingProviders = [];
const pendingProvider = () => new Promise(resolve => pendingProviders.push(() => resolve(response)));
async function fixture(id, constraints, scenario = 'normal') {
  // Timeout fences remain held until the actual ignored-abort promise settles.
  // Each case checks its late callbacks first, then explicitly quiesces the fake
  // provider before reusing the same role for the next independent scenario.
  for (const settle of pendingProviders.splice(0)) settle();
  await new Promise(resolve => setImmediate(resolve));
  const input = { goal: `SCENARIO:${scenario}`, agentIds: [id], recipientIds: [id], strategy: 'serial', workflow: 'routine', workspace: `ext:${registered.id}`, constraints: { readonly: true, ...constraints } };
  const preview = await entry.previewExecutionOrchestration(input);
  assert.ok(!preview.decision.issues.some(issue => issue.severity === 'error'), JSON.stringify(preview.decision.issues));
  const admitted = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, clientRequestId: randomUUID(), previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint });
  trace.setRunStatus(admitted.run.id, 'running');
  return { ...admitted, input, preview };
}
function options(f, extra = {}) {
  return { run: trace.getRun(f.run.id), agent: registry.getAnyAgent(f.run.agentIds[0]), parentSpanId: trace.startSpan(f.run.id, { spanKind: 'agent', name: 'fixture' }).id,
    messages: [{ role: 'user', content: f.run.goal }], ...extra };
}
const timeout = kind => error => error.code === 'timeout' && error.details?.timeoutKind === kind;

try {
  const preferences = { ...emptyPreferences(), constraints: { firstResponseTimeoutMs: 1000, idleTimeoutMs: 200 } };
  assert.equal(isRoomPreferences(preferences), true);
  const room = createEmptyRoom({ title: 'Timeout preferences', agentIds: ['worker'], preferences });
  assert.deepEqual(getConversation(room.id).preferences, preferences); assert.equal(getConversation(room.id).preferencesIssue, null);
  const storage = new Map(); globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value), removeItem: key => storage.delete(key) };
  writeRoomDraft({ ...preferences, version: 2, goal: 'draft', selected: ['worker'], initialTargets: ['worker'], workspace: '', title: '' });
  assert.deepEqual(readRoomDraft().constraints, preferences.constraints);
  for (const key of ['firstResponseTimeoutMs', 'idleTimeoutMs']) {
    for (const value of [0, -1, 1.5, 86400001, '1000']) assert.throws(() => normalizeOrchestrationRequest({ goal: 'x', agentIds: ['worker'], constraints: { [key]: value } }, 'unified_preview'), error => error.code === 'INVALID_CONSTRAINT');
  }
  const freeze = await fixture('worker', { firstResponseTimeoutMs: 50, idleTimeoutMs: 30 });
  assert.equal(getRunOrchestrationSnapshot(freeze.run.id).request.constraints.firstResponseTimeoutMs, 50);
  assert.throws(() => entry.submitExecutionOrchestration({ ...freeze.input, constraints: { ...freeze.input.constraints, idleTimeoutMs: 100 }, entryVersion: 1,
    clientRequestId: randomUUID(), previewId: freeze.preview.previewId, orchestrationFingerprint: freeze.preview.fingerprint }), error => error.code === 'PREVIEW_STALE');
  let late, capturedSignal; const deltas = [];
  await assert.rejects(budgetedChat(freeze.run.id, { chat(req, delta) { capturedSignal = req.signal; late = delta; return pendingProvider(); } }, { model: 'mock:fixture', messages: [] }, text => deltas.push(text)), timeout('first_response'));
  assert.equal(capturedSignal.aborted, true); late('late_api_output'); assert.deepEqual(deltas, []);

  const stalled = await fixture('worker', { firstResponseTimeoutMs: 100, idleTimeoutMs: 30, maxTokens: 100 });
  await assert.rejects(budgetedChat(stalled.run.id, { chat(req) { req.onActivity('reasoning'); return pendingProvider(); } }, { model: 'mock:fixture', messages: [] }), timeout('idle'));
  assert.equal(database.get('SELECT status FROM orchestration_token_reservations WHERE run_id=?', stalled.run.id).status, 'unknown');
  let replayed = false;
  await assert.rejects(budgetedChat(stalled.run.id, { chat() { replayed = true; return response; } }, { model: 'mock:fixture', messages: [] }), /消耗未知/);
  assert.equal(replayed, false, 'timeout cannot replay a call with unknown usage');

  const deadline = await fixture('worker', { deadlineMs: 30 });
  await assert.rejects(budgetedChat(deadline.run.id, { chat() { return pendingProvider(); } }, { model: 'mock:fixture', messages: [] }), timeout('total'));
  mockProvider.chat = () => pendingProvider();
  const supervisor = await fixture('worker', { firstResponseTimeoutMs: 30 });
  await assert.rejects(chatOnce(registry.getAnyAgent('worker'), supervisor.run.id, trace.startSpan(supervisor.run.id, { spanKind: 'agent', name: 'supervisor fixture' }).id, 'analyze'), timeout('first_response'));
  assert.equal(database.get("SELECT json_extract(attributes,'$.\"execution.timeout_kind\"') kind FROM run_events WHERE run_id=? AND span_kind='llm'", supervisor.run.id).kind, 'first_response');
  assert.equal(database.get("SELECT json_extract(attributes,'$.\"execution.limit_ms\"') limit_ms FROM run_events WHERE run_id=? AND span_kind='llm'", supervisor.run.id).limit_ms, 30);
  mockProvider.chat = req => { req.onActivity('reasoning'); return pendingProvider(); };
  const builtinIdle = await fixture('worker', { idleTimeoutMs: 30 });
  await assert.rejects(chatOnce(registry.getAnyAgent('worker'), builtinIdle.run.id, trace.startSpan(builtinIdle.run.id, { spanKind: 'agent', name: 'idle fixture' }).id, 'analyze'), timeout('idle'));
  const idleAttrs = trace.listEvents(builtinIdle.run.id).find(event => event.spanKind === 'llm').attributes;
  assert.equal(idleAttrs['execution.failure_phase'], 'after_activity'); assert.ok(idleAttrs['execution.last_activity_at']);
  assert.equal(idleAttrs['execution.first_response_at'], idleAttrs['execution.last_activity_at']);
  mockProvider.chat = () => { throw new LlmHttpError('HTTP 403', 403, 'req_fixture_error'); };
  const httpFailure = await fixture('worker');
  await assert.rejects(chatOnce(registry.getAnyAgent('worker'), httpFailure.run.id, trace.startSpan(httpFailure.run.id, { spanKind: 'agent', name: 'http fixture' }).id, 'analyze'), error => error instanceof LlmHttpError);
  const httpAttrs = trace.listEvents(httpFailure.run.id).find(event => event.spanKind === 'llm').attributes;
  assert.equal(httpAttrs['llm.http_status'], 403); assert.equal(httpAttrs['llm.request_id'], 'req_fixture_error');

  // Exercise both real stream parsers using an in-memory HTTP response, including discarded reasoning.
  const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
  for (const protocol of ['anthropic', 'openai']) {
    const route = protocol === 'anthropic' ? '/v1/messages' : '/chat/completions';
    for (const requestId of ['req_fixture_403', 'Bearer fixture_secret_token_12345678']) {
      dispatcher.get('https://fixture.invalid').intercept({ path: route, method: 'POST' }).reply(403, '{"error":"Authorization: Bearer fixture_secret_token_12345678"}', { headers: { 'x-request-id': requestId } });
      const failedProvider = protocol === 'anthropic' ? new AnthropicProvider('fixture-never-used', 'https://fixture.invalid', 1000) : new OpenAICompatibleProvider('fixture-never-used', 'https://fixture.invalid', 1000);
      await assert.rejects(failedProvider.chat({ model: `${protocol}:fixture`, messages: [] }), error => {
        assert.equal(error.status, 403); assert.equal(error.requestId, requestId.startsWith('req_') ? requestId : undefined);
        assert.doesNotMatch(error.message, /fixture_secret_token/); return true;
      });
    }
    const activity = [], visible = [];
    const frames = protocol === 'anthropic' ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden_fixture_reasoning' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'fs.read' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'visible' } },
    ] : [{ choices: [{ delta: { reasoning_content: 'hidden_fixture_reasoning' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'fs.read', arguments: '{"path":"README.md"}' } }] } }] },
      { choices: [{ delta: { content: 'visible' }, finish_reason: 'stop' }] }];
    dispatcher.get('https://fixture.invalid').intercept({ path: protocol === 'anthropic' ? '/v1/messages' : '/chat/completions', method: 'POST' }).reply(200, sse(frames), { headers: { 'content-type': 'text/event-stream' } });
    const provider = protocol === 'anthropic' ? new AnthropicProvider('fixture-never-used', 'https://fixture.invalid', 1000) : new OpenAICompatibleProvider('fixture-never-used', 'https://fixture.invalid', 1000);
    const result = await provider.chat({ model: `${protocol}:fixture`, messages: [], onActivity: kind => activity.push(kind) }, text => visible.push(text));
    assert.equal(result.content, 'visible'); assert.deepEqual(visible, ['visible']); assert.ok(activity.includes('reasoning')); assert.ok(activity.includes('tool_input')); assert.ok(activity.includes('text'));
  }
  globalThis.fetch = () => { throw new Error('Real network is forbidden in timeout fixture'); };

  for (const [scenario, kind] of [['first-timeout', 'first_response'], ['idle-timeout', 'idle']]) {
    const f = await fixture('cli', { firstResponseTimeoutMs: 1000, idleTimeoutMs: 200 }, scenario);
    await assert.rejects(runAgentTurn(options(f)), timeout(kind));
    const record = executions.listExecutions(f.run.id)[0];
    assert.equal(record.status, 'failed'); assert.equal(record.failureDetails.timeoutKind, kind); assert.equal(record.timeoutPolicy.firstResponseTimeoutMs, 1000);
    assert.ok(record.progress.nativeInvokedAt); assert.ok(record.progress.sessionBoundAt);
    assert.equal(Boolean(record.progress.firstResponseAt), kind === 'idle');
    assert.ok(!events.some(event => event.runId === f.run.id && event.type === 'llm.snapshot' && event.text.includes('late_native_output')));
    assert.equal(database.get("SELECT COUNT(*) count FROM external_native_processes WHERE execution_id=? AND status='running'", record.id).count, 0);
  }
  for (const scenario of ['tool-wait', 'reasoning']) {
    const f = await fixture('cli', { firstResponseTimeoutMs: 1000, idleTimeoutMs: 200 }, scenario);
    const result = await runAgentTurn(options(f)); assert.match(result.content, /Timeout fixture/);
    const record = executions.listExecutions(f.run.id)[0]; assert.equal(record.status, 'completed'); assert.ok(record.progress.firstResponseAt);
    assert.ok(!JSON.stringify(record).includes('hidden_fixture_reasoning'));
    assert.ok(!JSON.stringify(events.filter(event => event.runId === f.run.id)).includes('hidden_fixture_reasoning'));
  }
  for (const driver of ['claude-sdk', 'codex-exec']) {
    const activity = []; const parser = new NativeEventParser(driver, event => activity.push(event));
    if (driver === 'claude-sdk') parser.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden_fixture_reasoning' } } });
    else parser.accept({ type: 'item.updated', item: { id: 'thought', type: 'reasoning', text: 'hidden_fixture_reasoning' } });
    assert.deepEqual(activity, [{ type: 'response.activity', kind: 'reasoning' }]); assert.equal(parser.content, '');
  }

  const missingRoot = await fixture('cli', {});
  await assert.rejects(runExternalAgentTurn(options(missingRoot, { nativeWorkspaceRoot: path.join(root, 'missing') })));
  let record = executions.listExecutions(missingRoot.run.id)[0]; assert.equal(record.failureDetails.initializationStep, 'workspace'); assert.equal(record.status, 'failed'); assert.equal(record.progress.nativeInvokedAt, undefined);
  const missingAccount = await fixture('cli', {});
  await assert.rejects(runExternalAgentTurn(options(missingAccount, { agent: { ...registry.getAnyAgent('cli'), requiresAccount: true } })), /尚未选择账户/);
  record = executions.listExecutions(missingAccount.run.id)[0]; assert.equal(record.failureDetails.initializationStep, 'account'); assert.equal(record.status, 'failed');
  const firstRecord = structuredClone(record); await assert.rejects(runExternalAgentTurn(options(missingAccount)));
  assert.deepEqual(executions.listExecutions(missingAccount.run.id), [firstRecord], 'failed initialization scope cannot be replayed or rewritten');
  const cold = execFileSync(process.execPath, ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url)), '--input-type=module', '-e',
    `const { getExecution } = await import(${JSON.stringify(new URL('../apps/server/src/execution/store.ts', import.meta.url).href)}); console.log(JSON.stringify(getExecution(${JSON.stringify(record.id)})));`], { env: process.env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(cold.trim()), firstRecord, 'initialization failure is inspectable in a cold process');
  await rename(executable, executable + '.hidden'); await detectDriver('claude-cli', true);
  const missingClient = await fixture('cli', {}); await assert.rejects(runAgentTurn(options(missingClient)), error => error.code === 'missing_binary');
  record = executions.listExecutions(missingClient.run.id)[0]; assert.equal(record.failureDetails.initializationStep, 'client'); assert.equal(record.failureDetails.phase, 'initialization');
  await rename(executable + '.hidden', executable); await detectDriver('claude-cli', true);

  const holder = await fixture('cli', {});
  const release = await enterMember({ runId: holder.run.id, agentId: 'cli', scope: 'hold', signal: new AbortController().signal, authorized: () => true });
  const oldTimeout = config.externalAgents.timeoutMs; config.externalAgents.timeoutMs = 50;
  try {
    const queued = await fixture('cli', { firstResponseTimeoutMs: 1 }); await assert.rejects(runAgentTurn(options(queued)), error => error.details.phase === 'queue');
    record = executions.listExecutions(queued.run.id)[0]; assert.ok(record.progress.queuedAt); assert.equal(record.progress.nativeInvokedAt, undefined);
  } finally { config.externalAgents.timeoutMs = oldTimeout; release(); }
  const derived = { ...record, id: randomUUID(), status: 'cancelled', errorCode: 'cancelled', error: 'cancelled sibling' };
  assert.equal(executionFailureForRun([record, derived], record.runId).id, record.id, 'cancelled sibling must not hide primary execution error');
  assert.equal(executionFailureForRun([derived], record.runId).id, derived.id);
  const cancelled = await fixture('cli', { firstResponseTimeoutMs: 1000 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgentTurn(options(cancelled, { executionSignal: controller.signal })), error => error.code === 'cancelled');
  record = executions.listExecutions(cancelled.run.id)[0]; assert.equal(record.status, 'cancelled'); assert.equal(record.progress.nativeInvokedAt, undefined, 'upstream cancellation cannot launch a native process');
  // AbortSignal.timeout uses a DOMException, unlike the platform's typed errors.
  // Reproduce the native real-acceptance path after the client binds its session.
  const upstreamDeadline = await fixture('cli', {}, 'first-timeout');
  const upstream = new AbortController();
  let deadlineArmed = false;
  const unsubscribeDeadline = subscribe(event => {
    if (event.type !== 'execution.updated' || event.execution.runId !== upstreamDeadline.run.id || !event.execution.progress?.sessionBoundAt || deadlineArmed) return;
    deadlineArmed = true;
    const deadline = AbortSignal.timeout(20);
    deadline.addEventListener('abort', () => upstream.abort(deadline.reason), { once: true });
  });
  try {
    await assert.rejects(runAgentTurn(options(upstreamDeadline, { executionSignal: upstream.signal })), timeout('total'));
    record = executions.listExecutions(upstreamDeadline.run.id)[0];
    assert.equal(deadlineArmed, true); assert.equal(record.status, 'failed'); assert.equal(record.errorCode, 'timeout');
    assert.equal(record.failureDetails.phase, 'deadline'); assert.equal(record.failureDetails.limitMs, undefined, 'do not invent an upstream timer duration');
    assert.ok(record.progress.sessionBoundAt); assert.equal(record.tokensOut, null);
    assert.equal(database.get("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id=? AND status='running'", record.id).n, 0);
    await assert.rejects(runExternalAgentTurn(options(upstreamDeadline)), error => error.code === 'timeout');
    assert.equal(executions.listExecutions(upstreamDeadline.run.id).length, 1, 'upstream deadline cannot replay the uncertain request');
  } finally { unsubscribeDeadline(); }
  console.log('Model timeouts verified: frozen limits, preview drift, provider streams, late-output fencing, unknown-budget retention, native process cleanup, slow tools/reasoning, durable pre-launch failures, queue isolation and primary error selection.');
} finally {
  setGlobalDispatcher(originalDispatcher); await dispatcher.close();
  globalThis.fetch = originalFetch; unsubscribe(); await shutdownExternalAgents(); database.closeDatabase(); await rm(root, { recursive: true, force: true });
}
