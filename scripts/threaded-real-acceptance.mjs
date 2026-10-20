import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

// This is an explicit operator acceptance command, never a normal test or startup path.
const args = process.argv.slice(2);
if (!args.includes('--authorized-real')) throw new Error('Pass --authorized-real only after the user authorizes configured accounts and a token cap');
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const limit = Number(option('--token-limit'));
assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 10_000_000);
const tokenLedger = option('--token-ledger');
assert.ok(typeof tokenLedger === 'string' && tokenLedger.trim() && !tokenLedger.startsWith('--'),
  'Pass --token-ledger with the shared cumulative acceptance ledger; do not reset prior unknown reservations');
const accountId = option('--account');
assert.ok(typeof accountId === 'string' && accountId.trim() && !accountId.startsWith('--'),
  'Pass --account with an explicitly selected configured account ID');
const sourcePath = path.resolve(option('--source-db', 'apps/server/data/agent-gand.sqlite'));
const selected = option('--backend', 'all'); assert.ok(['api', 'claude-sdk', 'all'].includes(selected));
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-t07-real-')));
const reportPath = path.resolve(option('--report', 'docs/reports/evidence/threaded-t07-real-acceptance.json'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(path.dirname(sourcePath), 'private') });
// Only the optional master key setting is loaded; no unrelated global provider authentication is inherited.
if (!process.env.ACCOUNT_MASTER_KEY) {
  const env = await readFile(new URL('../apps/server/.env', import.meta.url), 'utf8').catch(() => '');
  const line = env.split('\n').find(value => /^\s*ACCOUNT_MASTER_KEY\s*=/.test(value));
  if (line) process.env.ACCOUNT_MASTER_KEY = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const account = source.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0').get(accountId);
assert.ok(account && account.auth_type === 'api_key', 'Selected account must be an enabled configured API-key account');
assert.equal(source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(accountId), undefined);
const version = source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(accountId, account.config_version);
const credential = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(accountId, account.credential_version);
assert.ok(version && credential);
const connection = JSON.parse(version.connection);
assert.ok(connection.protocols.includes('anthropic-messages'));
const rows = { accounts: [account], account_versions: [version], account_credentials: [credential] };
source.close();
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { db: credentialDb, closeDatabase } = await import('../apps/server/src/db/database.ts');
for (const [table, values] of Object.entries(rows)) for (const row of values) {
  const keys = Object.keys(row);
  credentialDb.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
const { readCredential } = await import('../apps/server/src/accounts/credentials.ts');
const { anthropicAuthHeaders } = await import('../apps/server/src/accounts/headers.ts');
const { redactSecrets } = await import('../apps/server/src/accounts/secrets.ts');
const apiKey = readCredential(accountId, account.credential_version);
const guard = new Database(path.resolve(tokenLedger));
guard.exec(`CREATE TABLE IF NOT EXISTS request_tokens(id TEXT PRIMARY KEY,reserved INTEGER NOT NULL,actual INTEGER,state TEXT NOT NULL)`);
const priorKnownTokens = guard.prepare('SELECT COALESCE(SUM(actual),0) n FROM request_tokens').get().n;
const priorReservedTokens = guard.prepare('SELECT COALESCE(SUM(reserved),0) n FROM request_tokens WHERE actual IS NULL').get().n;
let actualRequests = 0, interruptedFixture;
const fixtures = [], checks = [], failures = [];
const report = { stage: 'T07', date: new Date().toISOString(), platform: process.platform, sdkVersion: '0.3.288',
  account: { id: account.id, name: account.display_name, configVersion: account.config_version,
    credentialVersion: account.credential_version, endpointHost: new URL(connection.baseUrl).hostname, model: connection.defaultModel },
  authorizedTokenLimit: limit, checks, failures,
  privacy: { sourceDatabaseReadOnly: true, sourceTablesRead: ['accounts', 'account_revocations', 'account_versions', 'account_credentials'],
    modelContent: 'New synthetic acceptance messages and isolated SDK history only',
    dailyConversationOrMessageReads: false, realCredentialAllowedOnlyInConfiguredEndpointHeaders: true } };
const reserve = guard.transaction((id, description) => {
  const amount = description.inputBytes + description.maxOutputTokens + 8192;
  const old = guard.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
  if (old) { assert.equal(old.reserved, amount); return; }
  const used = guard.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
  if (used + amount > limit) throw new Error('T07_OPERATOR_TOKEN_LIMIT');
  guard.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id, amount);
});
function settle(id, usage) {
  if (Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)) {
    guard.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=?")
      .run(usage.inputTokens + usage.outputTokens, id);
  }
}
const nativeFetch = globalThis.fetch;
async function fixture(name, cancelOnHeaders = false) {
  const f = await openBackendRuntimeFixture(root, name, { account: { id: accountId,
    rows: { accounts: rows.accounts, account_versions: rows.account_versions } }, model: connection.defaultModel,
    connection: { baseUrl: connection.baseUrl, timeoutMs: Math.min(connection.timeoutMs ?? 180_000, 180_000),
      headers: { ...anthropicAuthHeaders(apiKey, connection), 'anthropic-version': '2023-06-01' } },
    quote: { maxOutputTokens: 4096 }, price: null,
    onRequestReserved: (id, description) => reserve.immediate(id, description), onRequestSettled: settle,
    fetch: async (url, init) => {
      const destination = new URL(url), configured = new URL(connection.baseUrl);
      assert.equal(destination.protocol, 'https:'); assert.equal(destination.origin, configured.origin);
      assert.ok(destination.pathname.startsWith(configured.pathname.replace(/\/$/, '')));
      assert.ok(typeof init.body === 'string' && !init.body.includes(apiKey), 'Credentials cannot appear in model input');
      assert.ok(!init.body.includes(sourcePath), 'The daily database path cannot appear in model input');
      if (f.forbiddenInput) assert.ok(!init.body.includes(f.forbiddenInput), 'Another member private message cannot appear in model input');
      actualRequests++;
      const response = await nativeFetch(url, init);
      if (cancelOnHeaders && interruptedFixture) {
        const claim = interruptedFixture;
        queueMicrotask(() => f.runtime.lifecycle.requestControl({ ownerId: f.thread.ownerId,
          scope: { kind: 'invocation', threadId: f.thread.id, invocationId: claim.binding.invocationId },
          action: 'stop', requestId: `real-cancel:${claim.binding.attemptId}` }));
      }
      return response;
    },
  });
  fixtures.push(f); return f;
}
async function step(f, body, member) {
  const receipt = f.user(body, [member]);
  const budget = f.runtime.budget.ensureRootForMessage(receipt.message.id);
  f.runtime.reviseRoot({ ownerId: f.thread.ownerId, rootId: budget.id, expectedVersion: budget.version,
    requestId: `real-policy:${receipt.message.id}`, reason: 'Authorized T07 acceptance; unknown price remains explicitly reserved',
    patch: { unknownCost: 'reserve', unknownCostReserveMicrousd: 1_000_000 } });
  f.runtime.queue.enqueueWake(receipt.wakes[0].id);
  const claim = f.runtime.queue.claimNext('authorized-t07-real'); assert.ok(claim, 'Real acceptance Wake must be claimable');
  if (f.cancelOnHeaders) interruptedFixture = claim;
  const result = await f.runtime.executeClaim(claim);
  const answer = f.db.prepare("SELECT body FROM threaded_messages WHERE source_attempt_id=? AND origin='agent_response'").get(claim.binding.attemptId)?.body ?? '';
  const prep = JSON.parse(f.db.prepare('SELECT preparation FROM threaded_wake_queue WHERE id=?').get(claim.queue.id).preparation);
  return { receipt, claim, result, answer, decision: prep.threadedContext.decision };
}
async function caseRun(name, action) {
  const started = Date.now(); process.stdout.write(`T07 real: ${name} started\n`);
  try { const details = await action(); checks.push({ name, status: 'passed', elapsedMs: Date.now() - started, ...details });
    process.stdout.write(`T07 real: ${name} passed\n`); }
  catch (error) { failures.push({ name, reason: redactSecrets(error instanceof Error ? error.message : String(error)), elapsedMs: Date.now() - started });
    process.stdout.write(`T07 real: ${name} failed (details in sanitized report)\n`); }
}
try {
  if (selected === 'all' || selected === 'api') await caseRun('API reconstruction and private ACL', async () => {
    const f = await fixture('real-api');
    const hidden = `PRIVATE_${randomUUID()}`; f.user(hidden, [], { visibility: 'private', audience: ['other-member'] });
    f.forbiddenInput = hidden;
    const marker = `T07_${randomUUID().replaceAll('-', '')}`;
    const first = await step(f, `Remember this marker: ${marker}. Reply only ACK. Do not use tools.`, 'api-member');
    assert.equal(first.result.status, 'completed'); assert.equal(first.decision.sessionKind, 'reconstructed');
    const second = await step(f, 'Return the exact T07_ marker from our previous message. Return only that marker. Do not use tools.', 'api-member');
    assert.equal(second.result.status, 'completed'); assert.ok(second.answer.includes(marker)); assert.ok(!second.answer.includes(hidden));
    assert.equal(second.decision.session.nativeId, null);
    return { invocations: 2, reconstruction: true, memoryMatched: true, privateSourceExcluded: true };
  });
  if (selected === 'all' || selected === 'claude-sdk') {
    await caseRun('SDK cold, reopened runtime native resume and permission cold boundary', async () => {
      const f = await fixture('real-sdk');
      const marker = `T07_${randomUUID().replaceAll('-', '')}`;
      const first = await step(f, `Remember this marker: ${marker}. Reply only ACK. Do not use tools.`, 'sdk-member');
      assert.equal(first.result.status, 'completed'); assert.equal(first.decision.mode, 'cold');
      const firstAnchor = f.db.prepare('SELECT id,record FROM threaded_session_anchors WHERE manifest_id=?').get(
        f.db.prepare('SELECT id FROM threaded_context_manifests WHERE binding_id=?').get(first.claim.binding.id).id);
      assert.ok(firstAnchor, 'Real SDK must persist a verified native anchor');
      const oldDb = f.db, oldRuntime = f.runtime, oldResources = f.resources;
      const configDir = f.configurations.get('sdk-member').configDir;
      const firstResourceOwner = f.resources.getClaim(first.claim.binding.claimId).identity.claimOwner;
      const requestsBeforeReopen = actualRequests;
      f.reopen();
      assert.equal(oldDb.open, false);
      assert.notEqual(f.db, oldDb); assert.notEqual(f.runtime, oldRuntime); assert.notEqual(f.resources, oldResources);
      assert.equal(f.configurations.get('sdk-member').configDir, configDir);
      f.runtime.recover();
      const recoveryRequests = actualRequests - requestsBeforeReopen;
      assert.equal(recoveryRequests, 0, 'Factory/SQLite recovery must not send a provider request');
      assert.deepEqual(f.db.prepare('SELECT id,record FROM threaded_session_anchors WHERE id=?').get(firstAnchor.id), firstAnchor);
      const second = await step(f, 'Return the exact T07_ marker from our previous message. Return only that marker. Do not use tools.', 'sdk-member');
      assert.equal(second.result.status, 'completed'); assert.equal(second.decision.mode, 'resume');
      assert.equal(second.decision.session.nativeId, first.decision.session.nativeId); assert.ok(second.answer.includes(marker));
      assert.equal(second.decision.anchorId, firstAnchor.id);
      assert.notEqual(f.resources.getClaim(second.claim.binding.claimId).identity.claimOwner, firstResourceOwner);
      const workers = f.db.prepare(`SELECT token,binding_id,state FROM threaded_backend_processes
        WHERE binding_id IN (?,?) ORDER BY rowid`).all(first.claim.binding.id, second.claim.binding.id);
      assert.ok(workers.some(worker => worker.binding_id === first.claim.binding.id));
      assert.ok(workers.some(worker => worker.binding_id === second.claim.binding.id));
      assert.ok(workers.every(worker => worker.state === 'verified_stopped'));
      assert.equal(new Set(workers.map(worker => worker.token)).size, workers.length);
      f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='sdk-member'").run(f.thread.id);
      const third = await step(f, 'Reply only COLD_OK. Do not use tools.', 'sdk-member');
      assert.equal(third.result.status, 'completed'); assert.equal(third.decision.mode, 'cold');
      assert.notEqual(third.decision.session.nativeId, second.decision.session.nativeId);
      return { invocations: 3, cold: true, nativeResume: true, memoryMatched: true, permissionChangeCold: true,
        runtimeFactoryAndSqliteReopened: true, freshResourceOwner: true, persistedAnchorReused: true,
        recoveryRequests,
        restartScope: 'Runtime factory and SQLite connection rebuilt in the same harness process; separate SDK workers execute each Invocation',
        processStates: f.db.prepare('SELECT DISTINCT state FROM threaded_backend_processes').all().map(row => row.state) };
    });
    await caseRun('SDK cancel and persistent unknown recovery', async () => {
      const f = await fixture('real-sdk-cancel', true); f.cancelOnHeaders = true;
      const attempt = await step(f, 'Write a long numbered list of 500 facts. Do not use tools.', 'sdk-member');
      assert.ok(['unknown', 'cancelled'].includes(attempt.result.status));
      const before = actualRequests; f.runtime.recover(); f.runtime.recover();
      assert.equal(actualRequests, before); assert.equal(f.runtime.queue.claimNext('no-blind-replay'), null);
      return { invocationStatus: attempt.result.status, claimState: f.resources.getClaim(attempt.claim.binding.claimId).state,
        noReplay: true, requestUsage: f.runtime.budget.getUsage(attempt.receipt.message.id) };
    });
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
} finally {
  report.actualRequests = actualRequests;
  report.knownTokens = guard.prepare('SELECT COALESCE(SUM(actual),0) n FROM request_tokens').get().n;
  report.unresolvedReservedTokens = guard.prepare('SELECT COALESCE(SUM(reserved),0) n FROM request_tokens WHERE actual IS NULL').get().n;
  report.conservativelyChargedTokens = report.knownTokens + report.unresolvedReservedTokens;
  report.knownTokensThisRun = report.knownTokens - priorKnownTokens;
  report.unresolvedReservedTokensThisRun = report.unresolvedReservedTokens - priorReservedTokens;
  report.passed = failures.length === 0;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, knownTokens: report.knownTokens,
    unresolvedReservedTokens: report.unresolvedReservedTokens, actualRequests, reportPath }) + '\n');
  for (const f of fixtures) if (f.db.open) f.close();
  guard.close(); closeDatabase();
  if (args.includes('--keep-isolated-evidence')) process.stdout.write(`Isolated evidence: ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}
if (failures.length) process.exitCode = 1;
