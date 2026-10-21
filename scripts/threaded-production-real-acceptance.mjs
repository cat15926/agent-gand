import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

// This command has billable effects only after all four explicit operator flags.
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
assert.ok(args.includes('--authorized-real'), 'Explicit --authorized-real authorization required');
const selectedCase = option('--case') ?? 'all'; assert.ok(['all', 'sdk-only'].includes(selectedCase), 'Use --case all or sdk-only');
const accountId = option('--account'), tokenLedger = option('--token-ledger'), tokenLimit = Number(option('--token-limit'));
assert.equal(accountId, '267c2e27-b25f-43cf-acaa-143327f7f714', 'Select the explicitly authorized T12 acceptance account');
assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 200_000, 'The stricter cumulative 200000 token cap remains mandatory');
assert.ok(tokenLedger && !tokenLedger.startsWith('--'), 'Existing shared token ledger is required');
assert.equal(await realpath(tokenLedger), await realpath('/tmp/agent-gand-t07-authorized-token-ledger.sqlite'), 'Never create a substitute/reset token ledger');
const sourcePath = path.resolve(option('--source-db') ?? 'apps/server/data/agent-gand.sqlite');
const reportPath = path.resolve(option('--report') ?? `docs/reports/evidence/threaded-t12-service-recovery/real-production-${selectedCase}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
await access(reportPath).then(() => { throw new Error('Refusing to overwrite an earlier acceptance report'); }, error => { if (error.code !== 'ENOENT') throw error; });
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-t12-production-real-')));
await mkdir(path.join(root, 'agents')); const children = [], checks = [], failures = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const guard = new Database(await realpath(tokenLedger), { fileMustExist: true, timeout: 10_000 });
const priorEntries = guard.prepare('SELECT * FROM request_tokens ORDER BY id').all();
const ledgerSummary = () => {
  const known = guard.prepare('SELECT COALESCE(SUM(actual),0) n FROM request_tokens').get().n;
  const unresolved = guard.prepare('SELECT COALESCE(SUM(reserved),0) n FROM request_tokens WHERE actual IS NULL').get().n;
  return { knownTokens: known, unresolvedReservedTokens: unresolved, conservativelyChargedTokens: known + unresolved };
};
const priorUsage = ledgerSummary(); assert.ok(priorUsage.conservativelyChargedTokens < tokenLimit);
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'credential-loader.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(path.dirname(sourcePath), 'private') });
if (!process.env.ACCOUNT_MASTER_KEY) {
  const env = await readFile(new URL('../apps/server/.env', import.meta.url), 'utf8').catch(() => '');
  const line = env.split('\n').find(value => /^\s*ACCOUNT_MASTER_KEY\s*=/.test(value));
  if (line) process.env.ACCOUNT_MASTER_KEY = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const account = source.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND archived=0').get(accountId);
assert.ok(account && account.auth_type === 'api_key' && account.source === 'managed');
assert.equal(source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(accountId), undefined);
const version = source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(accountId, account.config_version);
const credential = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(accountId, account.credential_version);
source.close(); assert.ok(version && credential);
const connection = JSON.parse(version.connection), endpoint = new URL(connection.baseUrl);
assert.equal(endpoint.protocol, 'https:'); assert.equal(endpoint.hostname, 'open.bigmodel.cn');
assert.equal(endpoint.port, ''); assert.ok(connection.protocols.includes('anthropic-messages')); assert.equal(connection.defaultModel, 'glm-5.3');
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { db: credentialDb, closeDatabase } = await import('../apps/server/src/db/database.ts');
for (const [table, row] of [['accounts', account], ['account_versions', version], ['account_credentials', credential]]) {
  const keys = Object.keys(row); credentialDb.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
const { readCredential } = await import('../apps/server/src/accounts/credentials.ts');
const { redactSecrets } = await import('../apps/server/src/accounts/secrets.ts');
const apiKey = readCredential(accountId, account.credential_version);
const applicationTools = ['knowledge_publish', 'knowledge_read', 'knowledge_search', 'update_sop', 'read_sop'];
const packFile = path.join(root, 'public-release-pack.json');
await writeFile(packFile, JSON.stringify({ schemaVersion: 1, platform: 'darwin',
  members: [['t12-real-api', 'api', 'threaded-http-v1'], ['t12-real-sdk', 'claude-sdk', '0.3.288']].map(([agentId, backend, backendVersion]) => ({
    agentId, backend, backendVersion, model: connection.defaultModel, roleVersion: 1, permissionVersion: 1,
    accountId, accountConfigVersion: account.config_version, accountCredentialVersion: account.credential_version,
    accountIdentityGeneration: account.identity_generation ?? null })), applicationTools,
  maxOutputTokens: 4096, maxInputTokens: 98_304, maxRequests: 8 }), { mode: 0o600 });
const markers = { api: `T12_API_${randomUUID().replaceAll('-', '')}`, sdk: `T12_SDK_${randomUUID().replaceAll('-', '')}` };
const privateMarkers = { api: `T12_PRIVATE_API_${randomUUID()}`, sdk: `T12_PRIVATE_SDK_${randomUUID()}` };
const report = { stage: 'T12', case: selectedCase, date: new Date().toISOString(), composition: 'production-factory HTTP server', actualMainIndex: false,
  skippedChecks: selectedCase === 'sdk-only' ? ['API real model invocation; previous API acceptance report is retained separately'] : [],
  account: { id: accountId, name: account.display_name, model: connection.defaultModel, endpointHost: endpoint.hostname,
    configVersion: account.config_version, credentialVersion: account.credential_version },
  authorizedTokenLimit: tokenLimit, priorUsage, checks, failures,
  privacy: { sourceDatabaseReadOnly: true, sourceTablesRead: ['accounts', 'account_versions', 'account_credentials', 'account_revocations'],
    dailyConversationOrMessageReads: false, credentialInMemoryOnly: true, credentialPassedViaPrivateIPCOnly: true,
    isolatedSdkHomeAndWorkspace: true, configuredEndpointOnly: true, remoteWrites: 0,
    syntheticPrivateHistorySeededThroughFixtureMessagePort: true, realInvocationsAdmittedThroughAuthenticatedHTTP: true },
  limitations: ['This real HTTP server uses production factories/routes/settings, not apps/server/src/index.ts or the legacy recovery composition.',
    'No unknown billable crash is manufactured. Existing unknown reservations remain in the shared ledger.',
    'Independent PR review, semantic retrieval and OS commands are outside this real-supplier test.'] };
let actualRequests = 0, currentWorker, currentMessageId, latestFacts;
async function unusedPort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function worker(restore = false) {
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const child = fork(new URL('./fixtures/threadedT12ProductionRealWorker.mjs', import.meta.url), [], {
    execArgv: ['--import', new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'test', LANG: 'en_US.UTF-8',
      AGENT_GAND_ISOLATED_WORKER: '1', LOG_LEVEL: 'silent', DB_PATH: path.join(root, `unused-child-${randomUUID()}.sqlite`),
      AGENTS_DIR: path.join(root, 'agents'), AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
      HOST: '127.0.0.1', PORT: String(port), ACCOUNT_TRUSTED_ORIGINS: origin, THREADED_COLLABORATION_MODE: 'execute' } });
  children.push(child); let output = '', sequence = 0, readyResolve, readyReject;
  child.stdout.on('data', data => { output = (output + data).slice(-20_000); });
  child.stderr.on('data', data => { output = (output + data).slice(-20_000); });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }), pending = new Map();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { const error = new Error(redactSecrets(`Real server exited ${code}/${signal}: ${output}`));
    readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); resolve({ code, signal }); }));
  child.once('error', readyReject); child.on('message', message => {
    if (message.ready) { readyResolve(message); return; } if (message.event === 'provider-request') { actualRequests++; return; }
    const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
    if (message.error) waiter.reject(new Error(redactSecrets(message.error))); else waiter.resolve(message.result);
  });
  child.send({ operation: 'initialize', root, account, version, apiKey, packFile, ledgerFile: await realpath(tokenLedger),
    tokenLimit, port, restore, forbiddenByAgent: { 't12-real-api': privateMarkers.sdk, 't12-real-sdk': privateMarkers.api } });
  let timer; const state = await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Real HTTP server startup timeout')), 30_000); })]).finally(() => clearTimeout(timer));
  let auth;
  const request = async (url, payload, method = 'POST', headers = auth) => {
    const response = await fetch(`${origin}${url}`, { method, headers: { origin,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { statusCode: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const call = (operation, extra = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error(`Real HTTP ${operation} timeout`)), 10_000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } }); child.send({ id, operation, ...extra }); });
  return { child, state, request, call, exited, diagnosticLog: () => redactSecrets(output).slice(-12_000),
    async login() { const parent = await request('/api/accounts/session', undefined, 'POST', { 'x-gand-bootstrap': '1' }); assert.equal(parent.statusCode, 200, redactSecrets(JSON.stringify(parent)));
      const bridge = await request('/api/accounts/threaded/access-session', undefined, 'POST', { cookie: parent.cookie, 'x-gand-csrf': parent.body.csrfToken }); assert.equal(bridge.statusCode, 200);
      return auth = { cookie: bridge.cookie, 'x-gand-csrf': bridge.body.csrfToken }; },
    async kill() { child.kill('SIGKILL'); const result = await exited; assert.equal(result.signal, 'SIGKILL'); return result; },
    async close() { await call('close'); await exited; } };
}
async function control(w, admissionOpen, dispatchOpen) {
  const state = await w.request('/api/threaded/release', undefined, 'GET'); assert.equal(state.statusCode, 200);
  const result = await w.request('/api/threaded/release/controls', { expectedVersion: state.body.control.version,
    requestId: randomUUID(), admissionOpen, dispatchOpen, reason: 'Authorized isolated T12 real backend acceptance' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); return result.body;
}
const receiptOf = response => response.body.receipt ?? response.body;
async function submit(w, threadId, body, member, extra = {}) {
  const response = await w.request(`/api/threaded/threads/${threadId}/messages`, { clientRequestId: randomUUID(), body, targets: member ? [member] : [], ...extra });
  assert.equal(response.statusCode, 200, redactSecrets(JSON.stringify(response))); return receiptOf(response).message;
}
async function completed(w, messageId) {
  currentWorker = w; currentMessageId = messageId;
  const end = Date.now() + 300_000; let value;
  while (Date.now() < end) { value = await w.call('facts', { messageId });
    latestFacts = compact({ ...value, sourceMessageId: messageId });
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(value.status)) break; await delay(500); }
  if (value?.status !== 'completed') { const error = new Error(redactSecrets(JSON.stringify({ status: value?.status,
    invocationReason: value?.invocationReason, attempt: value?.attempt, backendRequests: value?.backendRequests,
    transport: value?.transport, processes: value?.processes })));
    error.acceptanceFacts = latestFacts; throw error; }
  assert.equal(value.foreignDestinationAttempts, 0); assert.equal(value.forbiddenInputMatches, 0); assert.deepEqual(value.foreignKeys, []);
  return { ...value, sourceMessageId: messageId };
}
function compact(value) {
  return { ...value, manifestPayload: undefined, anchors: (value.anchors ?? []).map(a => ({ id: a.id, recordDigest: hash(a.record) })),
    decision: value.decision ? { mode: value.decision.mode, sessionKind: value.decision.sessionKind, nativeId: value.decision.session?.nativeId,
      anchorId: value.decision.anchorId, sessionId: value.decision.session?.id } : null,
    receipts: (value.receipts ?? []).map(r => ({ name: r.name, result: r.result, privacySourceIds: r.privacySourceIds, readSourceIds: r.readSourceIds })) };
}
async function toolsCase(w, threadId, backend) {
  const member = `t12-real-${backend}`, marker = markers[backend]; await control(w, true, false); await w.call('phase', { agent: member });
  const prompt = `Perform this exact synthetic tool task. In the provided JSON context locate the ID of THIS current user message. ` +
    `Call knowledge_publish exactly once: idempotencyKey "t12-${backend}-knowledge", title "${marker}", body "${marker}", anchors [{kind:"message",id:CURRENT_USER_MESSAGE_ID}]. ` +
    `Call update_sop exactly once: idempotencyKey "t12-${backend}-sop", sopKey "t12-${backend}", expectedVersion 0, title "T12 ${backend} synthetic SOP", stage "ready", baton "${member}", checks [{id:"self",label:"Self report only",state:"attested"}]. ` +
    `Then call knowledge_read for the knowledgeId returned by knowledge_publish, knowledge_search with query "${marker}", and read_sop with sopKey "t12-${backend}". ` +
    `Do not send messages or use other tools. Remember ${marker} for the next memory-only request. After all five tool types succeed, final answer exactly T12_TOOLS_DONE. Do not repeat the remembered marker in the final answer.`;
  const message = await submit(w, threadId, prompt, member); await w.call('budget', { messageId: message.id }); await control(w, true, true);
  const value = await completed(w, message.id); assert.equal(value.answer.trim(), 'T12_TOOLS_DONE');
  for (const name of applicationTools) assert.ok(value.receipts.some(r => r.name === name), `Real ${backend} must call ${name}`);
  assert.ok(value.receipts.every(r => applicationTools.includes(r.name)), 'No native or unselected application tool may complete');
  const publications = value.receipts.filter(r => r.name === 'knowledge_publish'); assert.equal(publications.length, 1);
  const publication = publications[0].result; assert.equal(publication.body, marker); assert.ok(publication.sourceMessageIds.includes(message.id));
  const read = value.receipts.find(r => r.name === 'knowledge_read').result;
  assert.equal(read.knowledgeId, publication.knowledgeId); assert.equal(read.body, marker);
  const search = value.receipts.find(r => r.name === 'knowledge_search').result;
  assert.equal(search.retrieval, 'literal_substring'); assert.ok(search.items.some(item => item.knowledgeId === publication.knowledgeId));
  assert.equal(value.knowledgePermissions.length, 1); assert.equal(value.knowledgePermissions[0].authorCanRead, true);
  assert.equal(value.knowledgePermissions[0].otherAgentCanRead, false, 'Private source provenance must continue to restrict derived knowledge');
  const sop = value.receipts.find(r => r.name === 'read_sop').result;
  assert.equal(sop.sopKey, `t12-${backend}`); assert.equal(sop.baton, member); assert.equal(sop.checks.length, 1);
  assert.equal(sop.checks[0].id, 'self'); assert.equal(sop.checks[0].state, 'attested'); assert.equal(sop.checks[0].verifiedFact, undefined);
  assert.ok(!value.manifestPayload.includes(backend === 'api' ? privateMarkers.sdk : privateMarkers.api));
  if (backend === 'sdk') { assert.equal(value.decision.mode, 'cold'); assert.ok(value.decision.session.nativeId);
    assert.ok(value.anchors.length > 0); assert.ok(value.processes.length > 0); assert.ok(value.processes.every(p => p.state === 'verified_stopped')); }
  else { assert.equal(value.decision.sessionKind, 'reconstructed'); assert.equal(value.decision.session.nativeId, null); }
  await control(w, true, false);
  checks.push({ ...compact(value), name: `${backend} real production HTTP knowledge/SOP tools`, status: 'passed', invocationStatus: value.status,
    privateSourceExcluded: true, selfReportStayedAttested: true, durableTools: applicationTools });
  return value;
}
try {
  const first = await worker(); assert.equal(first.state.recoveryRequests, 0); await first.login();
  assert.equal((await first.request('/api/threaded/threads', { title: 'Initially denied', clientRequestId: randomUUID() })).statusCode, 403);
  await control(first, true, false);
  const created = await first.request('/api/threaded/threads', { title: 'T12 isolated real production acceptance', clientRequestId: randomUUID() });
  assert.equal(created.statusCode, 200, JSON.stringify(created)); const threadId = created.body.thread?.id ?? created.body.id;
  assert.ok(threadId);
  await first.call('seed-private-history', { threadId });
  if (selectedCase === 'all') await toolsCase(first, threadId, 'api');
  const sdk = await toolsCase(first, threadId, 'sdk');
  const oldSession = await first.login(), requestsBeforeCrash = sdk.requests, anchor = sdk.anchors.at(-1);
  await first.kill(); const requestsBeforeRecovery = actualRequests;
  const second = await worker(true); assert.notEqual(second.state.pid, first.state.pid);
  assert.equal(second.state.recoveryRequests, 0); assert.equal(second.state.requestsThisProcess, 0);
  assert.equal(actualRequests, requestsBeforeRecovery);
  const stale = await second.request('/api/threaded/session', undefined, 'GET', oldSession); assert.equal(stale.statusCode, 401); await second.login();
  const recovered = await second.call('facts', { messageId: sdk.sourceMessageId }); assert.equal(recovered.requests, requestsBeforeCrash);
  assert.deepEqual(recovered.budget, sdk.budget, 'Process recovery must retain the original settled causal budget');
  assert.deepEqual(recovered.anchors, sdk.anchors, 'The prior verified anchor must survive byte-for-byte');
  await second.call('phase', { agent: 't12-real-sdk' });
  const next = await submit(second, threadId, 'Memory-only request: return the exact T12_SDK_ marker you were asked to remember in our preceding task. Do not call tools and do not mention any member.', 't12-real-sdk');
  await second.call('budget', { messageId: next.id }); await control(second, true, true);
  const resumed = await completed(second, next.id);
  assert.equal(resumed.decision.mode, 'resume'); assert.equal(resumed.decision.session.nativeId, sdk.decision.session.nativeId);
  assert.equal(resumed.decision.anchorId, anchor.id); assert.notEqual(resumed.resourceOwner, sdk.resourceOwner);
  assert.equal(resumed.answer.trim(), markers.sdk); assert.ok(!resumed.manifestPayload.includes(markers.sdk), 'Native incremental manifest must not reconstruct the remembered marker');
  assert.ok(resumed.processes.every(p => p.state === 'verified_stopped'));
  checks.push({ ...compact(resumed), name: 'real SDK full HTTP server SIGKILL and separate-process native resume', status: 'passed', invocationStatus: resumed.status,
    oldServerPid: first.state.pid, newServerPid: second.state.pid, recoveryProviderRequests: 0,
    priorAnchorId: anchor.id, sameNativeId: true, freshResourceOwner: true, memoryMatched: true,
    incrementalManifestExcludedRememberedMarker: true });
  await control(second, false, false); await second.close();
} catch (error) {
  if (currentWorker && currentWorker.child.exitCode === null && !currentWorker.child.signalCode) {
    try { latestFacts = compact({ ...await currentWorker.call('facts', { messageId: currentMessageId }), sourceMessageId: currentMessageId }); }
    catch (diagnosticError) { report.diagnosticCaptureFailure = redactSecrets(diagnosticError.message); }
  }
  failures.push({ reason: redactSecrets(error instanceof Error ? error.message : String(error)),
    facts: error.acceptanceFacts ?? latestFacts, serverLogTail: currentWorker?.diagnosticLog() }); process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  const oldRows = priorEntries.map(row => guard.prepare('SELECT * FROM request_tokens WHERE id=?').get(row.id));
  assert.deepEqual(oldRows, priorEntries, 'All previous known and unknown reservations must remain unchanged');
  Object.assign(report, ledgerSummary(), { actualRequests, passed: failures.length === 0, priorReservationsUnchanged: true,
    priorReservationsDigest: hash(priorEntries), knownTokensThisRun: ledgerSummary().knownTokens - priorUsage.knownTokens,
    unresolvedReservedTokensThisRun: ledgerSummary().unresolvedReservedTokens - priorUsage.unresolvedReservedTokens });
  assert.ok(report.conservativelyChargedTokens <= tokenLimit, 'Cumulative operator cap must remain intact');
  if (failures.length) {
    await chmod(root, 0o700); report.failedIsolationRoot = root;
    report.failedIsolationScope = 'Synthetic messages and SDK history, isolated execution facts, and an existing encrypted credential clone. No configured key plaintext is written.';
  }
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  guard.close(); closeDatabase(); if (!report.failedIsolationRoot) await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: failures.length, actualRequests,
    knownTokensThisRun: report.knownTokensThisRun, conservativelyChargedTokens: report.conservativelyChargedTokens, reportPath }));
}
