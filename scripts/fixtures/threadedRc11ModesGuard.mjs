import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';

// Synthetic database only. This preload observes the real index, never replaces
// its production factory, admission policy, recovery or dispatch implementation.
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER, '1');
const root = process.env.RC11_MODES_ROOT;
assert.ok(path.isAbsolute(root ?? ''));
const initial = await new Promise(resolve => process.once('message', resolve));
assert.equal(initial.operation, 'initialize');
assert.equal(initial.root, root);
let decryptions = 0;
const decipher = crypto.createDecipheriv;
crypto.createDecipheriv = (...args) => { decryptions++; return decipher(...args); };
syncBuiltinESMExports();
const {config} = await import('../../apps/server/src/config.ts');
config.dataDir = root;
config.sandboxDir = path.join(root, 'sandbox');
config.accounts.masterKey = initial.ephemeralMasterKey;
const mutablePaths = {
  data: config.dataDir, database: config.dbPath, sandbox: config.sandboxDir,
  private: config.accounts.privateDir, agents: config.agentsDir,
  externalCodexHome: config.externalAgents.codexHome,
  externalClaudeHome: config.externalAgents.claudeHome,
  externalWorkspaces: config.externalAgents.workspaceDir,
};
for (const location of Object.values(mutablePaths)) {
  const relative = path.relative(root, location);
  assert.ok(relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)), 'RC11_MUTABLE_PATH_OUTSIDE_ROOT');
}
assert.equal(config.mcp.command, null);
assert.equal(config.llm.openaiApiKey, null);
assert.equal(config.llm.anthropicApiKey, null);
const {db} = await import('../../apps/server/src/db/database.ts');
delete process.env.AGENT_GAND_ISOLATED_WORKER;
if (!initial.restore) {
  for (const [table, row] of [['accounts', initial.account], ['account_versions', initial.version]]) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  const {writeCredential} = await import('../../apps/server/src/accounts/credentials.ts');
  writeCredential(initial.account.id, 1, 'RC11_SYNTHETIC_KEY');
  const now = new Date().toISOString(), member = initial.member;
  const definition = {id: member.agentId, name: member.agentId, version: 1, enabled: true,
    model: member.model, accountRef: member.accountId, requiresAccount: true,
    tools: ['hold_ball'], disallowedTools: [], capabilities: [], permissionMode: 'readonly', systemPrompt: 'Use the isolated acceptance instructions.'};
  db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'db',?,?)")
    .run(definition.id, definition.name, JSON.stringify(definition), now, now);
  // Existing legacy histories are explicit fixture seeds, not executed models.
  for (const mode of ['pipeline', 'supervisor', 'collaboration']) {
    const id = `rc11-legacy-${mode}`;
    db.prepare('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(`${id}-room`, `${mode} historical room`, mode, '[]', now, now);
    db.prepare('INSERT INTO runs(id,conversation_id,turn_no,goal,mode,status,agent_ids,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`${id}-run`, `${id}-room`, 1, `${mode} historical work`, mode, 'completed', '[]', now, now);
  }
}
const effects = [];
let deniedEgress = 0;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  if (target.origin !== 'https://rc11.invalid' || target.pathname !== '/v1/messages'
    || target.search || target.hash || init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') {
    deniedEgress++; throw new Error('RC11_UNEXPECTED_EGRESS');
  }
  const requests = db.prepare("SELECT * FROM threaded_backend_requests WHERE state='sending' AND request_hash=?").all(sha(init.body));
  assert.equal(requests.length, 1);
  const request = requests[0];
  const binding = db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(request.binding_id);
  const invocation = db.prepare('SELECT * FROM threaded_invocations WHERE id=?').get(binding.invocation_id);
  const message = db.prepare('SELECT * FROM threaded_messages WHERE id=?').get(invocation.causal_root_id);
  effects.push({requestId: request.id, bindingId: request.binding_id, rootMessageId: message.id, realSupplier: false});
  if (message.body === 'RC11_UNKNOWN') throw new Error('RC11_INJECTED_TRANSPORT_UNKNOWN');
  assert.equal(message.body, 'RC11_TIMER');
  const prior = db.prepare("SELECT 1 FROM threaded_waits WHERE kind='timer' AND root_id=?").get(message.id);
  const body = JSON.parse(init.body);
  const content = prior ? {type: 'text', text: 'RC11_TIMER_REGISTERED'} : {type: 'tool_use', id: 'rc11-hold-tool', name: 'hold_ball', input: {
    idempotencyKey: 'rc11-grounded-hold', jobKey: 'rc11-overdue-observe', seconds: 5,
    waitSourceRef: {kind: 'thread_message', value: message.id, expectedSignal: 'business_check_completed', slaUntilMs: Date.now() + 3600000},
  }};
  return new Response(JSON.stringify({id: `rc11-response-${effects.length}`, type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: prior ? 'end_turn' : 'tool_use', stop_sequence: null,
    usage: {input_tokens: 20, output_tokens: 7}}), {headers: {'content-type': 'application/json'}});
};
const {threadedRuntime: runtime} = await import('../../apps/server/src/threaded/service.ts');
function snapshot(prefix = 'threaded_') {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? AND name<>'execution_resource_availability' ORDER BY name").all(prefix + '%').map(row => row.name);
  const tables = names.map(name => {
    assert.match(name, /^[a-z0-9_]+$/);
    const rows = db.prepare(`SELECT * FROM ${name}`).all().map(row => JSON.stringify(row)).sort();
    return {name, count: rows.length, sha256: sha(JSON.stringify(rows))};
  });
  return {tables, digest: sha(JSON.stringify(tables))};
}
function facts() {
  return {pid: process.pid, mode: process.env.THREADED_COLLABORATION_MODE, isolatedExecutionBypass: false,
    effects, deniedEgress, decryptions, mutablePaths: Object.fromEntries(Object.entries(mutablePaths).map(([name, value]) => [name, path.relative(root, value) || '.'])),
    pathIsolation: 'explicit preload config redirection before database/service import; repository source is not copied', snapshot: snapshot(),
    resources: {snapshot: snapshot('execution_resource_'),
      scope: 'All shared resource policy/tickets/epochs/claims/items/fairness/quiescence/sessions/session_versions in this synthetic-only database; availability hints and external host registration are excluded.',
      unknownClaims: db.prepare(`SELECT c.* FROM execution_resource_claims c JOIN threaded_execution_bindings b ON b.claim_id=c.id
        JOIN threaded_invocations i ON i.id=b.invocation_id WHERE i.status='unknown' ORDER BY c.id`).all()},
    waits: db.prepare('SELECT id,kind,state,deadline,root_id FROM threaded_waits').all(),
    invocations: db.prepare('SELECT id,status,causal_root_id FROM threaded_invocations').all(),
    budget: db.prepare('SELECT * FROM threaded_budget_requests').all(),
    callbacks: db.prepare('SELECT * FROM threaded_collaboration_callbacks').all(),
    requests: db.prepare('SELECT id,state FROM threaded_backend_requests').all(),
    foreignKeys: db.pragma('foreign_key_check'),
    legacy: db.prepare("SELECT id,mode,status FROM runs WHERE mode IN ('pipeline','supervisor','collaboration') ORDER BY id").all()};
}
process.on('message', message => {
  if (!message.id) return;
  try {
    let result;
    if (message.operation === 'facts') result = facts();
    else if (message.operation === 'hints') {
      runtime.collaboration.notifyCommitted();
      runtime.wakeup();
      result = runtime.recover();
      runtime.startDispatch();
    } else if (message.operation === 'budget') {
      const root = runtime.budget.ensureRootForMessage(message.messageId);
      result = runtime.reviseRoot({ownerId: root.ownerId, rootId: root.id, expectedVersion: root.version,
        requestId: `rc11-budget:${root.id}`, reason: 'Synthetic RC11 mode rehearsal',
        patch: {activityAllowanceMs: 10000, unknownCost: 'reserve', unknownCostReserveMicrousd: 1000000, maxCostMicrousd: 10000000}});
    } else throw new Error('RC11_OPERATION_FORBIDDEN');
    process.send?.({id: message.id, result});
  } catch (error) {
    process.send?.({id: message.id, error: error.code ?? error.message ?? 'RC11_OPERATION_FAILED'});
  }
});
