import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// Preload around the actual index.ts, not an alternative server/factory. The
// operator supplies only synthetic work, isolated paths and one pinned account.
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER, '1');
const root = process.env.RC05_MAIN_ROOT;
assert.ok(path.isAbsolute(root ?? ''));
const initial = await new Promise(resolve => process.once('message', resolve));
assert.equal(initial.operation, 'initialize');
assert.equal(initial.root, root);
let controlledNow = initial.controlledNow;
if (controlledNow !== undefined) {
  assert.ok(Number.isSafeInteger(controlledNow) && controlledNow > 0);
  Date.now = () => controlledNow;
}
const { config } = await import('../../apps/server/src/config.ts');
config.dataDir = root;
config.sandboxDir = path.join(root, 'sandbox');
config.accounts.masterKey = initial.ephemeralMasterKey ?? randomBytes(32).toString('hex');
const { db } = await import('../../apps/server/src/db/database.ts');
// Config/DB isolation is already frozen. Exercise the production execution
// policy without the fixture-only queue/runner bypass from this point onward.
delete process.env.AGENT_GAND_ISOLATED_WORKER;
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER, undefined);
const { rememberSecret, redactSecrets } = await import('../../apps/server/src/accounts/secrets.ts');
const { writeCredential } = await import('../../apps/server/src/accounts/credentials.ts');
rememberSecret(initial.apiKey);
rememberSecret(config.accounts.masterKey);
if (!initial.restore) {
  for (const [table, row] of [['accounts', initial.account], ['account_versions', initial.version]]) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  writeCredential(initial.account.id, initial.account.credential_version, initial.apiKey);
  const stamp = new Date().toISOString();
  for (const member of initial.members) {
    const def = { id: member.agentId, name: member.agentId, enabled: true, version: 1,
      model: member.model, accountRef: member.accountId, requiresAccount: true, tools: initial.applicationTools ?? [], permissionMode: 'readonly',
      systemPrompt: 'Synthetic reliability acceptance. Follow the current user exact final answer. No tools, files, shell, web, background work or unnecessary reasoning. Only mention a member when specifically requested by the current user.' };
    db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'db',?,?)")
      .run(def.id, def.name, JSON.stringify(def), stamp, stamp);
  }
}
const ledger = initial.real ? new Database(initial.ledgerFile, { fileMustExist: true, timeout: 10000 }) : null;
const reserve = ledger?.transaction((id, amount) => {
  assert.ok(Number.isSafeInteger(amount) && amount > 0);
  const old = ledger.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
  if (old) { assert.equal(old.reserved, amount); return; }
  const used = ledger.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
  assert.ok(used + amount <= initial.tokenLimit, 'RC05_OPERATOR_TOKEN_LIMIT');
  ledger.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id, amount);
});
const destination = new URL(JSON.parse(initial.version.connection).baseUrl), nativeFetch = globalThis.fetch;
let armed = null, calls = 0, deniedEgress = 0;
let finishWaitResponse;
let releaseHeaders;
const effects = [], events = [];
function event(kind, extra = {}) {
  const e = { event: kind, pid: process.pid, ...extra }; events.push(e); process.send?.(e);
}
function stopAt(kind, extra) {
  event(kind, extra);
  // Freeze immediately at the observed boundary; the parent kills this exact PID.
  process.kill(process.pid, 'SIGSTOP');
}
function settleKnown() {
  if (!ledger) return;
  for (const row of db.prepare("SELECT authorization_id,input_tokens,output_tokens FROM threaded_backend_requests WHERE state='complete'").all()) {
    if (Number.isSafeInteger(row.input_tokens) && Number.isSafeInteger(row.output_tokens))
      ledger.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=? AND actual IS NULL")
        .run(row.input_tokens + row.output_tokens, row.authorization_id);
  }
}
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  if (target.origin !== destination.origin || target.protocol !== 'https:' || target.search || target.hash
    || ![destination.pathname.replace(/\/$/, '') + '/v1/messages', destination.pathname.replace(/\/$/, '') + '/v1/messages/count_tokens'].includes(target.pathname)
    || init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string' || init.body.includes(initial.apiKey)) {
    deniedEgress++; throw new Error('RC05_EGRESS_FORBIDDEN');
  }
  const row = db.prepare("SELECT * FROM threaded_backend_requests WHERE state='sending' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(row && !db.inTransaction, 'RC05_DURABLE_REQUEST_BARRIER_REQUIRED');
  const body = JSON.parse(init.body);
  reserve?.immediate(row.authorization_id, Buffer.byteLength(init.body) + Number(body.max_tokens ?? 1) + 8192);
  calls++;
  const fact = { sequence: calls, requestId: row.id, authorizationId: row.authorization_id,
    backend: row.backend, pathname: target.pathname, transport: initial.real ? 'configured supplier' : 'injected', headersReceived: false };
  effects.push(fact); event('provider-request', { ...fact });
  let response;
  if (initial.real) response = await nativeFetch(url, init);
  else {
    const content = armed?.answer ?? 'RC05_ACK';
    if (armed?.streaming) {
      const frames = [{type:'message_start',message:{id:`rc05-${calls}`,usage:{input_tokens:20}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:content}},
        {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:4}}, {type:'message_stop'}];
      let cancelled = false;
      response = new Response(new ReadableStream({async start(controller) {
        for(const frame of frames) {await new Promise(r=>setTimeout(r,1000));if(cancelled)return;controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));}
        controller.close();
      },cancel(){cancelled=true;}}), {status:200,headers:{'content-type':'text/event-stream'}});
    } else response = new Response(JSON.stringify({ id: `rc05-${calls}`, type: 'message', role: 'assistant',
      content: [{ type: 'text', text: content }], model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 4 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  }
  fact.headersReceived = true; fact.status = response.status;
  const generationRequest = target.pathname.endsWith('/v1/messages');
  if (generationRequest && armed?.boundary === 'headers-crash') stopAt('headers-boundary', { ...fact });
  if (generationRequest && armed?.boundary === 'headers-hold') {
    event('headers-held', { ...fact });
    await new Promise((resolve, reject) => {
      releaseHeaders = resolve;
      const abort = () => reject(new Error('RC05_HELD_REQUEST_ABORTED'));
      if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
    });
    releaseHeaders = undefined;
  }
  if (generationRequest && armed?.boundary === 'wait-register') {
    assert.equal(initial.real, false, 'RC05_WAIT_REGISTRATION_REQUIRES_INJECTED_TRANSPORT');
    event('wait-register-ready', { ...fact, bindingId: row.binding_id, attemptId: row.attempt_id });
    await new Promise(resolve => { finishWaitResponse = resolve; });
    finishWaitResponse = undefined;
  }
  return response;
};
const { threadedRuntime: runtime } = await import('../../apps/server/src/threaded/service.ts');
const originalCheckpoint = runtime.budget.checkpointAttempt.bind(runtime.budget);
runtime.budget.checkpointAttempt = (...args) => {
  const allowance = originalCheckpoint(...args);
  if (armed?.boundary === 'slow-preparation' && !armed.slowApplied) {
    armed.slowApplied = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1250);
  }
  return allowance;
};
const beforeRecovery = db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n;
const originalClaim = runtime.queue.claimNext.bind(runtime.queue);
runtime.queue.claimNext = (...args) => {
  const claim = originalClaim(...args);
  if (claim && armed?.boundary === 'prepared-crash') stopAt('prepared-boundary', { binding: claim.binding });
  return claim;
};
const originalOutcome = runtime.lifecycle.recordOutcome.bind(runtime.lifecycle);
runtime.lifecycle.recordOutcome = (...args) => {
  const result = originalOutcome(...args);
  settleKnown();
  if (armed?.boundary === 'terminal-crash' && result?.terminal) stopAt('terminal-boundary', { binding: args[0], result });
  return result;
};
function facts(messageId) {
  settleKnown();
  const q = messageId ? db.prepare('SELECT * FROM threaded_wake_queue WHERE source_message_id=? ORDER BY rowid LIMIT 1').get(messageId) : null;
  const invocation = q?.invocation_id ? db.prepare('SELECT * FROM threaded_invocations WHERE id=?').get(q.invocation_id) : null;
  const tables = ['threaded_messages', 'threaded_wakes', 'threaded_outbox', 'threaded_wake_queue', 'threaded_invocations',
    'threaded_attempts', 'threaded_backend_requests', 'threaded_invocation_terminals', 'threaded_budget_roots', 'runs'];
  return { pid: process.pid, entry: 'apps/server/src/index.ts', isolatedExecutionBypass: false, beforeRecovery, calls, deniedEgress, effects,
    diagnostics: runtime.diagnostics(), queue: q, invocation,
    attempts: invocation ? db.prepare('SELECT id,invocation_id,attempt_no,status,execution_stage,resource_release_state,execution_reason FROM threaded_attempts WHERE invocation_id=?').all(invocation.id) : [],
    requests: db.prepare('SELECT id,authorization_id,backend,binding_id,attempt_id,state,delivered,input_tokens,output_tokens FROM threaded_backend_requests ORDER BY rowid').all(),
    invocations: db.prepare('SELECT id,agent_id,causal_root_id,reserved_run_id,status FROM threaded_invocations ORDER BY rowid').all(),
    messages: db.prepare('SELECT id,body,origin,source_attempt_id,causal_root_id FROM threaded_messages ORDER BY seq').all(),
    wakes: db.prepare('SELECT * FROM threaded_wakes ORDER BY rowid').all(),
    terminals: db.prepare('SELECT * FROM threaded_invocation_terminals ORDER BY rowid').all(),
    runs: db.prepare('SELECT id,status FROM runs ORDER BY rowid').all(),
    processes: db.prepare('SELECT token,host,pid,state FROM threaded_backend_processes ORDER BY rowid').all(),
    claims: db.prepare('SELECT id,state FROM execution_resource_claims ORDER BY rowid').all(),
    approvals: db.prepare('SELECT id,status,invocation_id FROM threaded_approvals ORDER BY rowid').all(),
    counts: Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n])),
    budget: invocation ? runtime.budget.getUsage(invocation.causal_root_id) : null,
    rootPolicy: invocation ? runtime.budget.getRoot(invocation.causal_root_id)?.policy : null,
    slowApplied: armed?.slowApplied === true,
    foreignKeys: db.pragma('foreign_key_check') };
}
process.on('message', async message => {
  if (!message.id) return;
  if (initial.captureDiagnostics) event('operation-begin', {operation:message.operation});
  try {
    let result;
    if (message.operation === 'facts') result = facts(message.messageId);
    else if (message.operation === 'arm') { armed = message.plan; result = true; }
    else if (message.operation === 'releaseHeaders') {
      assert.ok(releaseHeaders, 'RC05_HEADERS_NOT_HELD'); releaseHeaders(); releaseHeaders = undefined; result = true;
    }
    else if (message.operation === 'clock') {
      assert.ok(controlledNow !== undefined && Number.isSafeInteger(message.now) && message.now >= controlledNow);
      controlledNow = message.now; result = { now: controlledNow };
    } else if (message.operation === 'registerTimer') {
      assert.ok(controlledNow !== undefined && initial.real === false && initial.applicationTools?.includes('hold_ball'));
      const binding = runtime.authority.capture(message.attemptId);
      const source = runtime.collaboration.cooperation.source(binding);
      result = JSON.parse(await runtime.collaboration.tools.execute(binding, 'hold_ball', {
        idempotencyKey: 'rc05-main-wait', jobKey: 'rc05-main-wait', seconds: 5,
        waitSourceRef: {kind:'thread_message', value:source.id, expectedSignal:'business_check_completed', slaUntilMs:controlledNow+10000},
      }, 'rc05-main-wait-tool-call', initial.applicationTools));
    } else if (message.operation === 'finishWaitResponse') {
      assert.ok(controlledNow !== undefined && initial.real === false && finishWaitResponse);
      finishWaitResponse(); result = true;
    } else if (message.operation === 'waitFacts') {
      assert.ok(controlledNow !== undefined && initial.real === false);
      result = {pid:process.pid, actualIndexEntry:true, isolatedExecutionBypass:false, now:controlledNow, calls, deniedEgress,
        waits:db.prepare('SELECT * FROM threaded_waits ORDER BY id').all(),
        callbacks:db.prepare('SELECT * FROM threaded_collaboration_callbacks ORDER BY id').all(),
        admissions:db.prepare('SELECT * FROM threaded_hold_admissions ORDER BY source_id').all(),
        backendRequests:db.prepare('SELECT id,authorization_id,state FROM threaded_backend_requests ORDER BY id').all(),
        budgetRequests:db.prepare('SELECT id,outcome_kind,outcome_hash FROM threaded_budget_requests ORDER BY id').all(),
        budgetRoots:db.prepare('SELECT id,current_version,state FROM threaded_budget_roots ORDER BY id').all(),
        messages:db.prepare('SELECT id,origin,causal_root_id FROM threaded_messages ORDER BY seq').all(),
        wakes:db.prepare('SELECT id,source_message_id,causal_root_id FROM threaded_wakes ORDER BY id').all(),
        invocations:db.prepare('SELECT id,agent_id,causal_root_id,status FROM threaded_invocations ORDER BY id').all(),
        terminals:db.prepare('SELECT invocation_id,status FROM threaded_invocation_terminals ORDER BY invocation_id').all(),
        foreignKeys:db.pragma('foreign_key_check')};
    }
    else if (message.operation === 'budget') {
      const b = runtime.budget.ensureRootForMessage(message.messageId);
      result = runtime.reviseRoot({ ownerId: b.ownerId, rootId: b.id, expectedVersion: b.version,
        requestId: `rc05:${message.messageId}`, reason: 'Authorized isolated RC05 real-fault acceptance; unknown cost remains reserved',
        patch: { unknownCost: 'reserve', unknownCostReserveMicrousd: 1000000, maxCostMicrousd: 10000000,
          ...(message.activityAllowanceMs ? { activityAllowanceMs: message.activityAllowanceMs } : {}) } });
    } else if (message.operation === 'recover') result = runtime.recover();
    else if (message.operation === 'queryOnly') { db.pragma(`query_only=${message.value ? 'ON' : 'OFF'}`); result = true; }
    else if (message.operation === 'revoke') {
      // Same lifecycle path as the account revocation subscriber; isolated row only.
      db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(initial.account.id);
      result = runtime.lifecycle.revokeAccount(initial.account.id);
    } else if (message.operation === 'approval') {
      const row = db.prepare('SELECT current_attempt_id FROM threaded_invocations WHERE id=?').get(message.invocationId);
      result = runtime.lifecycle.registerApproval(runtime.authority.capture(row.current_attempt_id), { requestKey: 'rc05-live-approval' });
    } else throw new Error('RC05_OPERATION_FORBIDDEN');
    process.send?.({ id: message.id, result });
    if (initial.captureDiagnostics) event('operation-complete', {operation:message.operation});
  } catch (error) {
    // Messages are codes only; native exceptions can contain URLs or headers.
    const raw = redactSecrets(error.code ?? error.message ?? '');
    const safe = /^(?:THREADED|RESOURCE|RC05|SQLITE)_[A-Z0-9_]+$/.test(raw) ? raw : 'RC05_OPERATION_FAILED';
    process.send?.({ id: message.id, error: safe });
  }
});
process.send?.({ event: 'preload-ready', pid: process.pid, actualIndexEntry: true, isolated: true });
