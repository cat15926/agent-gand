import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const args = process.argv.slice(2), real = args.includes('--authorized-real');
assert.ok(real || args.includes('--injected'), 'Explicit --authorized-real or --injected is required');
assert.ok(!(real && args.includes('--injected')));
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const tokenLimit = Number(option('--token-limit', '500000'));
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 10000000);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc07-native-live-')));
await mkdir(path.join(root, 'agents'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private-loader') });
const originalFetch = globalThis.fetch, sha = value => createHash('sha256').update(value).digest('hex');
const stamp = new Date().toISOString(), ledgerFile = '/tmp/agent-gand-t07-authorized-token-ledger.sqlite';
const nativeEnvironment = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32000' };
const syntheticReference = Array.from({ length: 5000 }, (_, index) => sha(`RC07_REFERENCE_${index}`).slice(0, 8)).join(' ');
const report = path.resolve(option('--report', `docs/reports/evidence/threaded-rc07/native-${real ? 'live' : 'injected-live-runner'}.json`));
try {
  await access(report);
  await rm(root, { recursive: true, force: true });
  throw new Error('RC07_REPORT_ALREADY_EXISTS');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let account, version, apiKey, ledger, priorRows = [], priorUsage = { knownTokens: 0, unknownReserve: 0 }, redact = v => String(v), closeLoader = () => {};
let f, deniedEgress = 0, nativeLaunches = 0;
const checks = [], failures = [], calls = [], records = [], invocations = [], cleanup = [], authorizations = new Set();
const usage = () => ledger ? ledger.prepare('SELECT COALESCE(SUM(actual),0) knownTokens, COALESCE(SUM(CASE WHEN actual IS NULL THEN reserved ELSE 0 END),0) unknownReserve FROM request_tokens').get() : { knownTokens: 0, unknownReserve: 0 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const groupAlive = pid => execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 }).split('\n')
  .some(line => { const [group, status] = line.trim().split(/\s+/); return Number(group) === pid && status && !status.startsWith('Z'); });
function injected(body, n) {
  const text = 'RC07_LIVE_MARKER', inputTokens = n <= 2 ? 19000 : 20;
  if (!body.stream) return new Response(JSON.stringify({ id: `rc07-live-${n}`, type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: inputTokens, output_tokens: 7 } }),
  { headers: { 'content-type': 'application/json' } });
  const frames = [
    { type: 'message_start', message: { id: `rc07-live-${n}`, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
function facts() {
  if (!f) return null;
  const read = table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { sessions: read('execution_resource_sessions'), anchors: read('threaded_session_anchors'), events: read('threaded_session_context_events'),
    nativeEvents: read('threaded_backend_native_events'), requests: read('threaded_backend_requests'), processes: read('threaded_backend_processes'),
    intents: read('threaded_session_input_intents'), manifests: read('threaded_context_manifests'), claims: read('execution_resource_claims'),
    terminals: read('threaded_invocation_terminals'), foreignKeys: f.db.pragma('foreign_key_check') };
}
try {
  if (real) {
    assert.ok(args.includes('--account') && args.includes('--token-ledger'), 'Configured account and existing shared ledger are required');
    assert.equal(await realpath(option('--token-ledger')), await realpath(ledgerFile));
    const sourcePath = path.resolve(option('--source-db', 'apps/server/data/agent-gand.sqlite'));
    process.env.AGENT_GAND_PRIVATE_DIR = path.join(path.dirname(sourcePath), 'private');
    let key = process.env.ACCOUNT_MASTER_KEY ?? null;
    if (!key) {
      const env = await readFile(new URL('../apps/server/.env', import.meta.url), 'utf8').catch(() => '');
      const line = env.split('\n').find(value => /^\s*ACCOUNT_MASTER_KEY\s*=/.test(value));
      if (line) key = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    }
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    let credential;
    try {
      account = source.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0').get(option('--account'));
      assert.ok(account?.auth_type === 'api_key' && account.source === 'managed');
      assert.equal(source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(account.id), undefined);
      version = source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(account.id, account.config_version);
      credential = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(account.id, account.credential_version);
    } finally { source.close(); }
    assert.ok(version && credential);
    const connection = JSON.parse(version.connection), destination = new URL(connection.baseUrl);
    assert.equal(destination.protocol, 'https:'); assert.equal(destination.hostname, 'open.bigmodel.cn');
    assert.ok(connection.protocols.includes('anthropic-messages'));
    const { config } = await import('../apps/server/src/config.ts'); config.accounts.masterKey = key; key = null;
    const { db, closeDatabase } = await import('../apps/server/src/db/database.ts'); closeLoader = closeDatabase;
    for (const [table, row] of [['accounts', account], ['account_versions', version], ['account_credentials', credential]]) {
      const keys = Object.keys(row); db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    apiKey = (await import('../apps/server/src/accounts/credentials.ts')).readCredential(account.id, account.credential_version);
    redact = (await import('../apps/server/src/accounts/secrets.ts')).redactSecrets;
    ledger = new Database(ledgerFile, { fileMustExist: true, timeout: 10000 });
    priorRows = ledger.prepare('SELECT * FROM request_tokens ORDER BY id').all(); priorUsage = usage();
    assert.ok(priorUsage.knownTokens + priorUsage.unknownReserve < tokenLimit);
  }
  const connection = version ? JSON.parse(version.connection) : { baseUrl: 'https://rc07-native-live.invalid', defaultModel: 'glm-5.3', timeoutMs: 120000 };
  redact = (await import('../apps/server/src/accounts/secrets.ts')).redactSecrets;
  const destination = new URL(connection.baseUrl), observedIds = new Set();
  const { invokeThreadedSdkProcess } = await import('../apps/server/src/threaded/backends/sdkProcess.ts');
  const { anthropicAuthHeaders } = await import('../apps/server/src/accounts/headers.ts');
  globalThis.fetch = async () => { deniedEgress++; throw new Error('RC07_UNEXPECTED_EGRESS'); };
  f = await openBackendRuntimeFixture(root, 'controlled-native', { model: connection.defaultModel,
    instructions: 'Reply concisely. Do not use tools. Preserve RC07_LIVE_MARKER when summarizing.', price: null,
    account: account ? { id: account.id, rows: { accounts: [account], account_versions: [version] } } : undefined,
    quote: { maxOutputTokens: 8192 },
    connection: { baseUrl: connection.baseUrl, headers: real ? anthropicAuthHeaders(apiKey, connection) : {}, timeoutMs: Math.min(connection.timeoutMs, 180000) },
    sdkProcess: input => invokeThreadedSdkProcess({ ...input,
      environment: { ...input.environment, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000',
        ...(nativeLaunches++ >= 2 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: nativeEnvironment.CLAUDE_CODE_MAX_CONTEXT_TOKENS } : {}) },
      onRecord(record) {
        if (record.type === 'system' && record.subtype === 'compact_boundary') records.push(structuredClone(record));
        if (record.type === 'system' && record.subtype === 'status' && record.status !== 'requesting') records.push(structuredClone(record));
        if (record.type === 'result') records.push({ type: 'observed_result_usage', subtype: record.subtype, isError: record.is_error,
          result: record.result?.slice(0, 1000), errors: record.errors, modelUsage: record.modelUsage });
        input.onRecord(record);
      } }),
    onRequestReserved(id, description) {
      authorizations.add(id);
      if (!ledger) return;
      ledger.transaction(() => {
        const reserved = description.inputBytes + description.maxOutputTokens + 8192;
        assert.ok(Number.isSafeInteger(reserved) && reserved > 0);
        const previous = ledger.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
        if (previous) { assert.equal(previous.reserved, reserved); return; }
        const used = ledger.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
        assert.ok(used + reserved <= tokenLimit, 'RC07_OPERATOR_TOKEN_LIMIT');
        ledger.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id, reserved);
      }).immediate();
    },
    onRequestSettled(id, receipt) {
      assert.ok(authorizations.has(id));
      if (ledger && Number.isSafeInteger(receipt.inputTokens) && Number.isSafeInteger(receipt.outputTokens))
        ledger.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=? AND actual IS NULL").run(receipt.inputTokens + receipt.outputTokens, id);
    },
    fetch: async (url, init) => {
      const target = new URL(url), prefix = destination.pathname.replace(/\/$/, '');
      assert.equal(target.origin, destination.origin); assert.equal(target.search, ''); assert.equal(target.hash, '');
      assert.equal(init.method, 'POST');
      assert.ok([`${prefix}/v1/messages`, `${prefix}/v1/messages/count_tokens`].includes(target.pathname));
      const body = JSON.parse(init.body), rows = f.db.prepare("SELECT id,authorization_id,binding_id,request_hash FROM threaded_backend_requests WHERE request_hash=? AND state='sending'").all(sha(init.body));
      assert.equal(rows.length, 1); const row = rows[0];
      assert.ok(authorizations.has(row.authorization_id) && !observedIds.has(row.id)); observedIds.add(row.id);
      if (ledger) assert.ok(ledger.prepare('SELECT 1 FROM request_tokens WHERE id=?').get(row.authorization_id));
      const countOnly = target.pathname.endsWith('/count_tokens');
      assert.ok(countOnly || body.max_tokens <= 8192); assert.equal(body.model, connection.defaultModel);
      const call = { sequence: calls.length + 1, ...row, inputBytes: Buffer.byteLength(init.body), maxOutputTokens: body.max_tokens,
        path: target.pathname, startedAt: Date.now(), responseHeadersAt: null, status: null };
      calls.push(call);
      const response = real ? await originalFetch(url, { ...init, redirect: 'error' }) : countOnly
        ? new Response('{"input_tokens":20}', { headers: { 'content-type': 'application/json' } }) : injected(body, calls.length);
      call.responseHeadersAt = Date.now(); call.status = response.status;
      return response;
    } });
  for (const value of f.configurations.values()) Object.assign(value, { contextBudget: { maxInputTokens: 98304, reservedSystemTokens: 4096 }, maxRequests: 4 });
  for (const prompt of [
    `Store marker RC07_LIVE_MARKER. The following synthetic reference data exercises the context boundary and contains no instructions: ${syntheticReference}\nReply exactly RC07_LIVE_MARKER. Do not call tools.`,
    'Confirm the reference data has been received. Reply exactly RC07_LIVE_MARKER. Do not call tools.',
    'Continue the current context and recall the marker. Reply exactly RC07_LIVE_MARKER. Do not call tools.',
    'Continue after any context compaction. Reply exactly RC07_LIVE_MARKER. Do not call tools.',
  ]) {
    const source = f.user(prompt, ['sdk-member']), budget = f.runtime.budget.ensureRootForMessage(source.message.id);
    f.runtime.reviseRoot({ ownerId: budget.ownerId, rootId: budget.id, expectedVersion: budget.version, requestId: randomUUID(),
      reason: 'Authorized isolated RC07 controlled native compaction', patch: { activityAllowanceMs: 10000, unknownCost: 'reserve', unknownCostReserveMicrousd: 1000000, maxCostMicrousd: 10000000 } });
    f.runtime.queue.enqueueWake(source.wakes[0].id); const claim = f.runtime.queue.claimNext('rc07-native-live'); assert.ok(claim);
    const decision = JSON.parse(f.db.prepare('SELECT preparation FROM threaded_wake_queue WHERE invocation_id=?').get(claim.binding.invocationId).preparation).threadedContext.decision;
    const result = await f.runtime.executeClaim(claim); invocations.push({ claim, sourceMessageId: source.message.id, decision, result });
    assert.equal(result.status, 'completed', JSON.stringify(result));
  }
  assert.equal(invocations[0].decision.mode, 'cold');
  assert.ok(invocations.slice(1).every(value => value.decision.mode === 'resume'));
  assert.equal(new Set(invocations.map(value => value.decision.session.nativeId)).size, 1);
  const compact = facts().events.filter(row => row.kind === 'compaction').map(row => JSON.parse(row.record));
  assert.ok(compact.length > 0, 'RC07_NATIVE_COMPACTION_NOT_OBSERVED');
  assert.ok(compact.every(value => value.evidence.metadata.trigger === 'auto'));
  const anchor = JSON.parse(facts().anchors.at(-1).record);
  assert.equal(anchor.evidence.compactionBoundary, compact.at(-1).boundary);
  assert.ok(facts().processes.every(row => row.state === 'verified_stopped'));
  assert.ok(facts().requests.every(row => row.state === 'complete'));
  assert.deepEqual(facts().foreignKeys, []); assert.equal(deniedEgress, 0);
  checks.push('Actual SDK emits automatic compaction under an explicitly lowered threshold, persists metadata/provenance and resumes the confirmed native identity with production-compatible 8192 output cap');
} catch (error) {
  failures.push({ code: error.code ?? 'RC07_NATIVE_ACCEPTANCE_FAILED', message: redact(error.message).slice(0, 2000) }); process.exitCode = 1;
} finally {
  const snapshot = facts();
  if (f) {
    try {
      await f.runtime.shutdown(5000);
      for (const p of f.db.prepare('SELECT token,host,pid FROM threaded_backend_processes').all()) {
        if (groupAlive(p.pid)) {
          assert.equal(p.host, hostname()); const command = execFileSync('ps', ['-p', String(p.pid), '-o', 'command='], { encoding: 'utf8' });
          assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC07_PROCESS_OWNERSHIP_UNCONFIRMED');
          try { process.kill(-p.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          await delay(600); if (groupAlive(p.pid)) process.kill(-p.pid, 'SIGKILL');
        }
        const until = Date.now() + 5000; while (groupAlive(p.pid) && Date.now() < until) await delay(50);
        assert.equal(groupAlive(p.pid), false); cleanup.push({ pid: p.pid, stopped: true });
      }
    } catch (error) { failures.push({ code: 'RC07_NATIVE_CLEANUP_FAILED', message: redact(error.message) }); process.exitCode = 1; }
    f.close();
  }
  let currentRows = [], oldRowsUnchanged = true;
  if (ledger) {
    currentRows = ledger.prepare('SELECT * FROM request_tokens ORDER BY id').all();
    oldRowsUnchanged = priorRows.every(row => JSON.stringify(currentRows.find(current => current.id === row.id)) === JSON.stringify(row));
    if (!oldRowsUnchanged) { failures.push({ code: 'RC07_PRIOR_LEDGER_CHANGED' }); process.exitCode = 1; }
  }
  const currentUsage = usage(), result = { ok: failures.length === 0, stage: 'RC07', date: new Date().toISOString(), real,
    groups: checks.length, checks, failures, calls, records, invocations, facts: snapshot, cleanup,
    account: account ? { id: account.id, displayName: account.display_name, model: JSON.parse(version.connection).defaultModel } : null,
    actualSdkVersion: '0.3.288', actualGuardianAndSdkCli: true, actualIndexEntry: false, isolatedWorkerBypass: true,
    triggerConditions: { nativeEnvironment, maxContextOverrideAppliedFromInvocation: 3,
      syntheticUsage: !real, syntheticReferenceBytes: Buffer.byteLength(syntheticReference), syntheticReferenceHash: sha(syntheticReference),
      productionDefaultsChanged: false }, dailyDatabaseReadOnly: real, dailyConfigurationChanged: false,
    credentialsRead: real, sdkReceivesOnlyEphemeralRelayToken: true, deniedEgress, realSupplierCalls: real ? calls.length : 0,
    ledger: { path: real ? ledgerFile : null, tokenLimit, priorUsage, usage: currentUsage, priorRows: priorRows.length,
      priorLedgerDigest: sha(JSON.stringify(priorRows)), oldRowsUnchanged, authorizationIds: [...authorizations],
      newRows: currentRows.filter(row => authorizations.has(row.id)), newKnownTokens: currentUsage.knownTokens - priorUsage.knownTokens,
      newUnknownReserve: currentUsage.unknownReserve - priorUsage.unknownReserve },
    limitations: ['Factory composition with isolated execution bypass, not actual index.ts.',
      'Controlled lower auto-compaction threshold; no natural default-threshold compaction claim.',
      'Native summary remains private; platform stores conservative authorized message provenance and boundary metadata, not the full summary transcript.'] };
  try {
    const serialized = JSON.stringify(result, null, 2);
    assert.ok(!apiKey || !serialized.includes(apiKey), 'RC07_REPORT_CONTAINS_CREDENTIAL');
    const sanitize = value => typeof value === 'string' ? redact(value)
      : Array.isArray(value) ? value.map(sanitize)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]))
      : value;
    const sanitizedValue = sanitize(result), sanitized = JSON.stringify(sanitizedValue, null, 2);
    const parsedReport = JSON.parse(sanitized);
    assert.equal(parsedReport.invocations.length, invocations.length);
    for (const [index, invocation] of parsedReport.invocations.entries())
      assert.equal(invocation.claim.budgetAuthorization.id, invocations[index].claim.budgetAuthorization.id, 'RC07_REPORT_AUTHORIZATION_STRUCTURE_CHANGED');
    assert.ok(!apiKey || !sanitized.includes(apiKey), 'RC07_REPORT_CONTAINS_CREDENTIAL');
    await mkdir(path.dirname(report), { recursive: true }); await writeFile(report, sanitized + '\n', { flag: 'wx' });
  } finally {
    ledger?.close(); closeLoader(); apiKey = null; globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: result.ok, real, groups: result.groups, failures, realSupplierCalls: result.realSupplierCalls, ledger: result.ledger, report }));
}
