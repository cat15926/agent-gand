import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

// This pinned historical audit imports no application singleton, credentials,
// transport, process signalling, mutation SQL or settlement API.
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ledgerPath = '/tmp/agent-gand-t07-authorized-token-ledger.sqlite';
const outputPath = path.join(repo, 'docs/reports/evidence/threaded-rc09/history-ledger-audit.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const rowHash = rows => hash(JSON.stringify(rows));
const sourceFiles = [
  'threaded-t07-real-sdk.json', 'threaded-t07-real-sdk-reopen.json',
  'threaded-t12-service-recovery/real-production.json',
  'threaded-t12-service-recovery/real-production-sdk-only-2026-10-21T14-29-22-514Z-23b3eb69.json',
  'threaded-rc05/main-live-second.json', 'threaded-rc05/main-live-extended.json',
  'threaded-rc05/main-live-extended-second.json', 'threaded-rc05/main-live-receipt-io-after-fix.json',
  'threaded-rc06/main-live-first.json',
  ...['05', '06', '07', '08'].map(stage => `threaded-rc${stage}/ledger.json`),
];
const sources = new Map();
for (const source of sourceFiles) {
  const relative = `docs/reports/evidence/${source}`;
  const bytes = await readFile(path.join(repo, relative));
  sources.set(source, { relative, sha256: hash(bytes), data: JSON.parse(bytes) });
}
const ledgerBytesBefore = hash(await readFile(ledgerPath));
const db = new Database(ledgerPath, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
assert.equal(db.pragma('query_only', { simple: true }), 1);
const rows = db.prepare('SELECT id,reserved,actual,state FROM request_tokens ORDER BY id').all();
assert.equal(rows.length, 89, 'Audit is pinned to the RC08 89-row snapshot');
for (const row of rows) {
  assert.ok(Number.isSafeInteger(row.reserved) && row.reserved >= 0);
  assert.ok(['known', 'reserved'].includes(row.state));
  if (row.state === 'known') assert.ok(Number.isSafeInteger(row.actual) && row.actual >= 0);
  else assert.equal(row.actual, null);
}
const total = selected => ({
  rows: selected.length,
  knownRequests: selected.filter(row => row.state === 'known').length,
  unknownRequests: selected.filter(row => row.state !== 'known').length,
  knownTokens: selected.reduce((n, row) => n + (row.state === 'known' ? row.actual : 0), 0),
  unknownReserve: selected.reduce((n, row) => n + (row.state !== 'known' ? row.reserved : 0), 0),
});
const totals = total(rows);
assert.deepEqual(totals, { rows: 89, knownRequests: 77, unknownRequests: 12, knownTokens: 220478, unknownReserve: 206832 });
const ledgerHistory = [];
let previous = [...rows];
for (const stage of ['08', '07', '06', '05']) {
  const baseline = sources.get(`threaded-rc${stage}/ledger.json`).data;
  const additions = new Map(baseline.addedRequests.map(row => [row.id, row]));
  const observed = previous.filter(row => additions.has(row.id));
  assert.deepEqual(observed, [...additions.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  previous = previous.filter(row => !additions.has(row.id));
  assert.equal(previous.length, baseline.originalRows);
  assert.equal(rowHash(previous), baseline.originalRowsSha256);
  ledgerHistory.push({ stage: `RC${stage}`, retainedRows: previous.length, removedExactAdditionIds: additions.size,
    originalRowsSha256: rowHash(previous), matchesArchivedBaseline: true });
}
const unknownRows = rows.filter(row => row.state !== 'known');
const observations = new Map(unknownRows.map(row => [row.id, []]));
const hostObservations = new Map(unknownRows.map(row => [row.id, []]));
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const snapshots = (value, visit, pointer = '$') => {
  if (!value || typeof value !== 'object') return;
  visit(value, pointer);
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) snapshots(child, visit, Array.isArray(value) ? `${pointer}[${key}]` : `${pointer}.${key}`);
  }
};
for (const [source, record] of sources) {
  if (source.endsWith('/ledger.json')) continue;
  snapshots(record.data, (snapshot, pointer) => {
    const requests = Array.isArray(snapshot.requests) ? snapshot.requests : Array.isArray(snapshot.backendRequests) ? snapshot.backendRequests : [];
    for (const request of requests) {
      const authorizationId = request?.authorization_id;
      if (!observations.has(authorizationId)) continue;
      const attemptId = request.attempt_id ?? snapshot.attempt?.id;
      const binding = list(snapshot.bindings).find(item => item.attempt_id === attemptId);
      const bindingId = request.binding_id ?? binding?.id ?? snapshot.bindingId;
      const attempt = list(snapshot.attempts).find(item => item.id === attemptId) ?? snapshot.attempt;
      const invocationId = request.invocation_id ?? attempt?.invocation_id ?? snapshot.invocation?.id ?? snapshot.invocationId;
      const invocation = snapshot.invocation?.id === invocationId ? snapshot.invocation : list(snapshot.invocations).find(item => item.id === invocationId);
      const claim = list(snapshot.claims).find(item => item.identity?.attemptId === attemptId);
      const queue = list(snapshot.queue).find(item => item.invocation_id === invocationId) ?? (!Array.isArray(snapshot.queue) ? snapshot.queue : undefined);
      const processes = list(snapshot.processes).filter(item => item.binding_id ? item.binding_id === bindingId : requests.length === 1);
      observations.get(authorizationId).push({
        source: record.relative, pointer, label: snapshot.label ?? null,
        request: pick(request, ['id', 'authorization_id', 'binding_id', 'attempt_id', 'invocation_id', 'backend', 'model', 'state', 'delivered', 'input_tokens', 'output_tokens', 'cost_microusd']),
        identity: { requestId: request.id, bindingId: bindingId ?? null, attemptId: attemptId ?? null, invocationId: invocationId ?? null,
          causalRootId: invocation?.causal_root_id ?? null, queueGeneration: queue?.generation ?? null,
          invocationAuthorityEpoch: invocation?.authority_epoch ?? null,
          claimId: claim?.identity?.claimId ?? binding?.claim_id ?? null, claimGeneration: claim?.identity?.generation ?? null },
        execution: { invocationStatus: invocation?.status ?? snapshot.status ?? null,
          reason: invocation?.recovery_reason ?? snapshot.invocationReason ?? null,
          attempt: pick(attempt, ['id', 'status', 'execution_stage', 'execution_reason', 'resource_release_state']),
          queue: pick(queue, ['state', 'reason', 'authorization_version', 'generation']), claimState: claim?.state ?? null },
        processes: processes.map(item => pick(item, ['token', 'binding_id', 'host', 'pid', 'state', 'created_at', 'stopped_at', 'groupStoppedAtInspection'])),
        unjoinedClaimSnapshots: list(snapshot.claims).filter(item => !item.identity).map(item => pick(item, ['id', 'state'])),
        transport: list(snapshot.transport).map(item => pick(item, ['sequence', 'method', 'endpointHost', 'pathname', 'status', 'state', 'bodyBytes', 'signalAborted'])),
        externalEffects: { durableToolReceiptCount: Array.isArray(snapshot.receipts) ? snapshot.receipts.length : null,
          unresolvedCommands: snapshot.release?.work?.unresolvedCommands ?? null,
          unresolvedActions: snapshot.release?.work?.unresolvedActions ?? null },
      });
    }
    const boundary = snapshot.boundary;
    if (boundary && hostObservations.has(boundary.authorizationId)) {
      hostObservations.get(boundary.authorizationId).push({ source: record.relative, pointer,
        boundary: pick(boundary, ['requestId', 'authorizationId', 'backend', 'headersReceived', 'status']),
        nativeProcesses: list(snapshot.nativeProcesses).map(item => pick(item, ['token', 'host', 'pid', 'state', 'groupStopped'])) });
    }
  });
}
const inStage = (stage, id) => sources.get(`threaded-rc${stage}/ledger.json`).data.addedRequests.some(row => row.id === id);
const unresolved = unknownRows.map(row => {
  const evidence = observations.get(row.id);
  const identities = [...new Map(evidence.map(item => [JSON.stringify(item.identity), item.identity])).values()];
  const completeTokens = evidence.some(item => Number.isSafeInteger(item.request.input_tokens) && Number.isSafeInteger(item.request.output_tokens));
  assert.equal(completeTokens, false);
  return {
    authorizationId: row.id, ledgerState: row.state, reservedTokens: row.reserved, actualTokens: row.actual,
    origin: inStage('05', row.id) ? 'RC05 exact added-request set' : inStage('06', row.id) ? 'RC06 exact added-request set' : 'Pre-RC05 retained-row set; individual run not assigned without an ID bridge',
    mappingStatus: evidence.length ? 'exact archived request identity' : 'missing request/binding identity bridge',
    identityObservations: identities, archivedObservations: evidence, hostObservations: hostObservations.get(row.id),
    reconciliation: {
      tokenUsage: 'unknown; retain full reservation', monetaryCost: 'unknown; no per-request price/charge receipt',
      providerRequestId: 'not present in the selected archived evidence',
      replay: 'prohibited while original execution/effects remain unknown',
      release: 'no automatic refund, claim release or Invocation completion from a stopped PID or HTTP 200',
      requiredEvidence: evidence.length ? ['Original provider request correlation and complete trusted usage/charge receipt', 'Exact original binding/claim generation and trusted quiescence/effect proof before any resource mutation'] : ['Original authorization-to-request/binding identity bridge', 'Original provider request correlation and complete trusted usage/charge receipt', 'Original execution and side-effect identities'],
    },
  };
});
assert.equal(unresolved.filter(item => item.archivedObservations.length).length, 9);
const missingIdentityIds = unresolved.filter(item => !item.archivedObservations.length).map(item => item.authorizationId);
assert.deepEqual(missingIdentityIds, ['0a662bd1-f011-4859-9017-1bedab6cbf06', '5769d162-deaf-4ac8-8745-1fe013be3595', '76de0837-8d83-4379-8d28-2e2ae4ac6256']);
// Only report evidence is searched. Original native/credential contents are never read.
const search = { root: 'docs/reports/evidence', excluded: ['threaded-rc09'], jsonFilesRead: 0, exactIdMatches: [] };
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'threaded-rc09' || entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(target);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const bytes = await readFile(target); search.jsonFilesRead++;
      for (const id of missingIdentityIds) if (bytes.includes(Buffer.from(id))) search.exactIdMatches.push({ authorizationId: id, source: path.relative(repo, target), sha256: hash(bytes) });
    }
  }
}
await scan(path.join(repo, 'docs/reports/evidence'));
assert.deepEqual(search.exactIdMatches, [], 'New exact-ID evidence needs an explicit audit revision');
const failedRoot = sources.get('threaded-t12-service-recovery/real-production-sdk-only-2026-10-21T14-29-22-514Z-23b3eb69.json').data.failedIsolationRoot;
assert.match(failedRoot, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/agent-gand-t12-production-real-[A-Za-z0-9]+$/);
const retainedIsolation = { source: 'T12 SDK diagnostic failedIsolationRoot', path: failedRoot, exists: false, metadataOnly: true, databaseFileCount: 0, nativeOrCredentialFilesRead: 0 };
try {
  const stat = await lstat(failedRoot);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(failedRoot), failedRoot);
  retainedIsolation.exists = true;
  async function inspect(directory, depth = 0) {
    assert.ok(depth < 20, 'Unexpected retained fixture depth');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(target, depth + 1);
      else if (entry.isFile() && /\.(sqlite|sqlite3|db)(-wal|-shm)?$/i.test(entry.name)) retainedIsolation.databaseFileCount++;
    }
  }
  await inspect(failedRoot);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const afterRows = db.prepare('SELECT id,reserved,actual,state FROM request_tokens ORDER BY id').all();
assert.deepEqual(afterRows, rows);
db.close();
const ledgerBytesAfter = hash(await readFile(ledgerPath));
assert.equal(ledgerBytesAfter, ledgerBytesBefore);
const report = {
  schemaVersion: 1, stage: 'RC09', auditedAt: new Date().toISOString(),
  scope: 'Read-only historical accounting audit through RC08; no supplier calls and no historical settlement',
  auditPassed: true, historicalUnknownResolved: false,
  ledger: { path: ledgerPath, readonly: true, queryOnly: true, ...totals,
    conservativeTokens: totals.knownTokens + totals.unknownReserve,
    operatorTokenLimit: 500000, userAuthorizedTokenLimit: 10000000, remainingWithinSelectedCap: 72690,
    logicalRowsSha256: rowHash(rows), databaseBytesSha256: ledgerBytesAfter, logicalRowsUnchanged: true, databaseBytesUnchanged: true },
  archivedLedgerChain: ledgerHistory,
  unknownByOrigin: { preRC05: total(unknownRows.filter(row => !inStage('05', row.id) && !inStage('06', row.id))),
    RC05: total(unknownRows.filter(row => inStage('05', row.id))), RC06: total(unknownRows.filter(row => inStage('06', row.id))) },
  exactMappedRequests: 9, missingRequestIdentityBridges: 3, safeTokenSettlementsAvailable: 0, safeMonetarySettlementsAvailable: 0,
  unresolved,
  aggregateOnlyHistory: [
    { source: sources.get('threaded-t07-real-sdk.json').relative, unknownDelta: 19505, individualAuthorizationId: null },
    { source: sources.get('threaded-t07-real-sdk-reopen.json').relative, unknownDelta: 19505, individualAuthorizationId: null },
    { source: sources.get('threaded-t12-service-recovery/real-production.json').relative, unknownDelta: 26041, individualAuthorizationId: null },
  ],
  missingIdentitySearch: search, retainedIsolation,
  conclusions: [
    'T07 two 19505 reservations and T12 first 26041 are aggregate corroboration only; value or insertion order is not an identity bridge.',
    'T12 diagnostic 18269946 and RC06 c7fb88e3 include archived durable verified_stopped processes; their requests and resource/execution facts remain unknown.',
    'RC05 3afbd4bc has a same-event exact guardian token/host/PID groupStopped observation, while the archived durable process still says registered. This audit does not mutate it.',
    'RC05 two extended timeouts retain their exact request identities and unknown reservations; subsequent passing tests do not establish their original cause.',
    'HTTP headers and process quiescence cannot supply final token or monetary facts. Budget costMicrousd reservations are not provider invoices.',
    'No global assertion that external side effects are absent: available receipts/command/action snapshots are scoped and incomplete; no replay or synthetic zero-effect proof is created.',
    'Historical inventory can pass while all 12 reservations remain unknown. Retain/pause original work; resume requires separate trusted original identity and domain facts.',
  ],
  sources: [...sources.values()].map(({ relative, sha256 }) => ({ path: relative, sha256 })),
  actions: { supplierCalls: 0, credentialsRead: false, dailyDatabaseRead: false, ledgerWrites: 0, historicalEvidenceWrites: 0,
    processSignals: 0, resourceReleases: 0, usageRefunds: 0, executionReplays: 0 },
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ auditPassed: true, output: path.relative(repo, outputPath), ...totals, exactMappedRequests: 9, missingRequestIdentityBridges: 3, safeSettlementsAvailable: 0 }));
