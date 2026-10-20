import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-messages-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent' });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in message fixture'); };
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createThreadedMessages } = await import('../apps/server/src/threaded/messages.ts');
const { createThreadedMessageAcl } = await import('../apps/server/src/threaded/acl.ts');
const { createThreadedOutbox } = await import('../apps/server/src/threaded/outbox.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [], children = [], checks = [];
const now = '2026-10-20T00:00:00.000Z';
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const snapshot = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const messageTables = ['threaded_messages', 'threaded_deliveries', 'threaded_wakes', 'threaded_outbox'];
const conflict = error => /IDEMPOTENCY_CONFLICT/.test(error?.code ?? error?.message ?? '');
const rejected = error => /THREADED_|OUTBOX_/.test(error?.code ?? error?.message ?? '');

function fixture(name, messageOptions = {}) {
  const databasePath = path.join(root, `${name}.sqlite`), db = new Database(databasePath, { timeout: 10_000 });
  databases.push(db); db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER'); applyOrchestrationSchemaMigrations(db);
  for (const id of ['aa', 'bb', 'cc', 'dd']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, enabled: true,
      model: 'mock:fixture', capabilities: ['execute'], tools: [], disallowedTools: [], permissionMode: 'readonly', systemPrompt: 'Fixture' }), now, now);
  const store = createThreadedStore(db);
  const room = (label, members = ['aa', 'bb', 'cc']) => {
    const value = store.createThread({ title: label, members: members.map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(value.id); return value;
  };
  const thread = room(name), ownerId = thread.ownerId;
  const resources = createFakeThreadedResources(), authority = createThreadedAuthority(db, resources);
  const lifecycle = createThreadedLifecycle(db, authority, { resources });
  const acl = createThreadedMessageAcl(db);
  const messages = createThreadedMessages(db, { authority, acl, ...messageOptions });
  const binding = (agentId = 'aa', target = thread, start = true) => {
    const invocation = lifecycle.createInvocation({ ownerId, threadId: target.id, agentId, causalRootId: randomUUID(), goal: name, requestId: randomUUID() });
    const value = lifecycle.prepareAttempt({ ownerId, invocationId: invocation.id,
      claim: resources.acquire({ ownerId, threadId: target.id, invocationId: invocation.id, runId: invocation.runId, agentId }) });
    if (start) lifecycle.startAttempt(value);
    return value;
  };
  const user = (overrides = {}) => ({ ownerId, threadId: thread.id, clientRequestId: randomUUID(), body: name, ...overrides });
  let clock = Date.now() + 60_000;
  const outbox = createThreadedOutbox(db, { now: () => clock, leaseMs: 1000 });
  return { db, databasePath, store, room, thread, ownerId, resources, authority, lifecycle, acl, messages, binding, user, outbox,
    setClock(value) { clock = value; } };
}

async function worker(databasePath) {
  const child = fork(fileURLToPath(new URL('./fixtures/threadedMessageWorker.mjs', import.meta.url)), [databasePath, `fixture-worker:${randomUUID()}`], {
    execArgv: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url))],
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let sequence = 0, stderr = '', readyResolve, readyReject;
  const pending = new Map(), ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on('data', value => { stderr += value; });
  const failed = error => { readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on('message', message => {
    if (message.ready) { readyResolve(); return; }
    const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.result);
  });
  child.on('error', failed);
  child.on('exit', code => failed(Object.assign(new Error(`Message fixture worker exited ${code}: ${stderr}`), { exitCode: code })));
  await ready;
  const call = (operation, ...args) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation, args });
  });
  return { call, close: () => child.connected ? call('close') : Promise.resolve() };
}

try {
  {
    const f = fixture('concurrent-idempotency');
    const input = f.user({ targets: ['aa', 'bb'] });
    const a = await worker(f.databasePath), b = await worker(f.databasePath);
    const [first, second] = await Promise.all([a.call('acceptUserMessage', input), b.call('acceptUserMessage', input)]);
    assert.deepEqual(second, first);
    assert.equal(count(f.db, 'threaded_messages'), 1);
    assert.equal(count(f.db, 'threaded_deliveries'), 2);
    assert.equal(count(f.db, 'threaded_wakes'), 2);
    assert.equal(count(f.db, 'threaded_outbox'), first.outboxIds.length);
    const before = snapshot(f.db, messageTables);
    assert.deepEqual(f.messages.acceptUserMessage(input), first);
    assert.deepEqual(snapshot(f.db, messageTables), before);
    assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'orchestration_model_calls'), 0);
    await a.close(); await b.close();
    checks.push('DB01/M03: real independent SQLite workers concurrently accept one user identity and return the same durable Message/Delivery/Wake/Outbox receipt with no Run or model call');
  }

  {
    const f = fixture('same-key-conflicts');
    const input = f.user({ visibility: 'private', audience: ['aa', 'bb', 'cc'], targets: ['aa'], body: 'exact body\n' });
    f.messages.acceptUserMessage(input);
    const before = snapshot(f.db, messageTables);
    for (const change of [{ body: 'exact body' }, { targets: ['bb'] }, { audience: ['aa', 'bb'] }]) {
      assert.throws(() => f.messages.acceptUserMessage({ ...input, ...change }), conflict);
      assert.deepEqual(snapshot(f.db, messageTables), before);
    }
    checks.push('DB02: same request identity with changed exact body, targets or audience conflicts without a second durable intent');
  }

  {
    const f = fixture('post-response-separate-identities'), binding = f.binding();
    const payload = { binding, body: 'same text addressed to bb', targets: ['bb'] };
    assert.throws(() => f.messages.postAgentMessage({ ...payload, binding: { ...binding, agentId: 'bb' }, toolCallId: 'forged' }), rejected);
    assert.throws(() => f.db.transaction(() => f.messages.postAgentMessage({ ...payload, toolCallId: 'nested-post' }))(), /STANDALONE_TRANSACTION_REQUIRED/);
    const post = f.messages.postAgentMessage({ ...payload, toolCallId: 'post-once' });
    const proof = f.resources.quiescent(binding);
    assert.throws(() => f.messages.appendResponseWithinTransaction({ ...payload, responseCommitKey: 'response-once', quiescence: proof }), /RESPONSE_TRANSACTION_REQUIRED/);
    const postCommitted = snapshot(f.db, [...messageTables, 'threaded_message_sequences']);
    f.db.exec("CREATE TRIGGER fixture_response_failure BEFORE INSERT ON threaded_messages WHEN NEW.origin='agent_response' BEGIN SELECT RAISE(ABORT,'fixture_response_failure'); END;");
    assert.throws(() => f.db.transaction(() => f.messages.appendResponseWithinTransaction({ ...payload,
      responseCommitKey: 'response-once', quiescence: proof })).immediate(), /fixture_response_failure/);
    assert.deepEqual(snapshot(f.db, [...messageTables, 'threaded_message_sequences']), postCommitted);
    f.db.transaction(() => {
      assert.throws(() => f.messages.appendResponseWithinTransaction({ ...payload,
        responseCommitKey: 'response-once', quiescence: proof }), /fixture_response_failure/);
      // Catching a ledger error must not allow the enclosing terminal transaction
      // to commit a consumed sequence or partial authored response.
    }).immediate();
    assert.deepEqual(snapshot(f.db, [...messageTables, 'threaded_message_sequences']), postCommitted);
    f.db.exec('DROP TRIGGER fixture_response_failure');
    const response = f.db.transaction(() => f.messages.appendResponseWithinTransaction({ ...payload,
      responseCommitKey: 'response-once', quiescence: proof })).immediate();
    assert.notEqual(response.message.id, post.message.id);
    assert.equal(response.message.bodyHash, post.message.bodyHash);
    assert.equal(post.message.origin, 'agent_post'); assert.equal(response.message.origin, 'agent_response');
    assert.notEqual(post.wakes[0].id, response.wakes[0].id);
    assert.equal(count(f.db, 'threaded_messages'), 2); assert.equal(count(f.db, 'threaded_wakes'), 2);
    assert.deepEqual(f.messages.postAgentMessage({ ...payload, toolCallId: 'post-once' }), post);
    assert.throws(() => f.messages.postAgentMessage({ ...payload, toolCallId: 'post-once', body: 'changed tool result' }), conflict);
    assert.deepEqual(f.db.transaction(() => f.messages.appendResponseWithinTransaction({ ...payload,
      responseCommitKey: 'response-once', quiescence: proof })).immediate(), response);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 0, 'this checks distinct source ledgers, not the later terminal/final integration');
    checks.push('M01 ledger subcase: forged authority/incorrect transaction ports are rejected; committed post survives failed response, and identical post/response text remains two source identities with stable retries without pretending a final Run commit occurred');
  }

  {
    const f = fixture('prepared-agent-cannot-publish'), binding = f.binding('aa', f.thread, false);
    const before = snapshot(f.db, messageTables);
    assert.throws(() => f.messages.postAgentMessage({ binding, toolCallId: 'not-started', body: 'premature tool result' }), rejected);
    assert.throws(() => f.db.transaction(() => f.messages.appendResponseWithinTransaction({ binding, responseCommitKey: 'not-started',
      body: 'premature response', quiescence: f.resources.quiescent(binding) })).immediate(), rejected);
    assert.deepEqual(snapshot(f.db, messageTables), before);
    f.lifecycle.startAttempt(binding);
    const notStarted = f.resources.quiescent(binding, { reason: 'not_started', sideEffects: 'none' });
    assert.throws(() => f.db.transaction(() => f.messages.appendResponseWithinTransaction({ binding, responseCommitKey: 'wrong-proof',
      body: 'no execution cannot be a response', quiescence: notStarted })).immediate(), rejected);
    assert.deepEqual(snapshot(f.db, messageTables), before);
    checks.push('ISO03/M01 boundary: prepared-but-unstarted Agent bindings cannot publish tool/final messages, and a not-started quiescence proof cannot authorize an authored response');
  }

  {
    const f = fixture('message-acl');
    const owner = { ownerId: f.ownerId, threadId: f.thread.id, viewer: { kind: 'owner' } };
    const viewer = agentId => ({ ...owner, viewer: { kind: 'agent', agentId } });
    const publicMessage = f.messages.acceptUserMessage(f.user({ body: 'public marker', targets: ['aa'] }));
    const privateMessage = f.messages.acceptUserMessage(f.user({ body: 'private marker', visibility: 'private', audience: ['aa', 'bb'], targets: ['aa'],
      attachments: [{ name: 'private.txt', mediaType: 'text/plain', contentBase64: Buffer.from('private attachment marker').toString('base64') }] }));
    const draft = f.messages.acceptUserMessage(f.user({ body: 'owner draft marker', state: 'draft', visibility: 'private', audience: ['aa'] }));
    assert.equal(publicMessage.deliveries.length, 1);
    assert.equal(f.messages.getMessage(viewer('bb'), publicMessage.message.id).id, publicMessage.message.id);
    assert.equal(privateMessage.deliveries.length, 1);
    assert.equal(f.messages.getMessage(viewer('bb'), privateMessage.message.id).id, privateMessage.message.id);
    assert.equal(f.messages.getMessage(viewer('cc'), privateMessage.message.id), null);
    assert.equal(f.messages.getMessage(viewer('dd'), publicMessage.message.id), null);
    assert.equal(f.messages.getMessage({ ...owner, ownerId: 'forged-owner' }, privateMessage.message.id), null);
    assert.equal(f.messages.getMessage(viewer('aa'), draft.message.id), null);
    assert.equal(f.messages.getMessage(owner, draft.message.id).id, draft.message.id);
    assert.equal(draft.deliveries.length, 0); assert.equal(draft.wakes.length, 0);
    assert.throws(() => f.messages.acceptUserMessage(f.user({ body: 'invalid private routing', visibility: 'private', audience: ['aa'], targets: ['cc'] })), rejected);
    const listed = JSON.stringify(f.messages.listMessages(viewer('cc'), {}));
    assert.ok(listed.includes('public marker')); assert.ok(!listed.includes('private marker')); assert.ok(!listed.includes('draft marker'));
    assert.deepEqual(f.messages.searchMessages(viewer('cc'), { query: 'private marker' }), []);
    const attachmentId = privateMessage.message.attachments[0].id;
    assert.equal(f.messages.getAttachment(viewer('cc'), attachmentId), null);
    assert.ok(f.messages.getAttachment(viewer('bb'), attachmentId));
    const agentDraft = f.messages.postAgentMessage({ binding: f.binding(), toolCallId: 'agent-draft', body: 'agent draft marker',
      state: 'draft', visibility: 'private', audience: ['aa', 'bb'] });
    assert.equal(f.messages.getMessage(viewer('aa'), agentDraft.message.id).id, agentDraft.message.id);
    assert.equal(f.messages.getMessage(viewer('bb'), agentDraft.message.id), null);
    checks.push('CTX01/CTX02: public recipients differ from audience; private exact-ID/history/search/attachment reads share ACL; owner/Agent drafts create no wakes and remain private');

    const secretId = privateMessage.message.id;
    assert.throws(() => f.messages.acceptUserMessage(f.user({ body: 'public laundering', sourceRefs: [secretId] })), rejected);
    assert.throws(() => f.messages.acceptUserMessage(f.user({ body: 'broader private summary', visibility: 'private', audience: ['aa', 'bb', 'cc'], sourceRefs: [secretId] })), rejected);
    const summary = f.messages.acceptUserMessage(f.user({ body: 'permitted summary', visibility: 'private', audience: ['aa', 'bb'], sourceRefs: [secretId] }));
    assert.equal(f.messages.getMessage(viewer('bb'), summary.message.id).id, summary.message.id);
    assert.equal(f.acl.canRead(viewer('cc'), { ...publicMessage.message, sourceRefs: [secretId] }), false);
    f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='bb'").run(f.thread.id);
    assert.equal(f.messages.getMessage(viewer('bb'), summary.message.id), null);
    assert.equal(f.messages.getAttachment(viewer('bb'), attachmentId), null);
    checks.push('CTX02: derived summaries cannot broaden source visibility; recursive source authorization and current membership protect later exact/attachment reads');
  }

  {
    const f = fixture('frozen-wave');
    const input = f.messages.acceptUserMessage(f.user({ body: 'independent thought', targets: ['aa', 'bb'] }));
    assert.equal(input.wakes.length, 2);
    assert.equal(input.wakes[0].waveId, input.wakes[1].waveId);
    assert.equal(input.wakes[0].inputMaxSeq, input.wakes[1].inputMaxSeq);
    const before = snapshot(f.db, ['threaded_deliveries', 'threaded_wakes']);
    const answer = f.messages.postAgentMessage({ binding: f.binding(), toolCallId: 'early-answer', body: 'aa answered first' });
    assert.ok(answer.message.seq > input.wakes[1].inputMaxSeq);
    assert.deepEqual(snapshot(f.db, ['threaded_deliveries', 'threaded_wakes']), before);
    checks.push('CTX05 ledger subcase: explicit multi-target acceptance freezes one wave/cutoff; an early peer answer cannot mutate the other target input boundary');
  }

  {
    const f = fixture('cross-thread-source-acl'), binding = f.binding();
    const destination = f.room('authorized destination', ['aa', 'bb']);
    const denied = f.room('no writer membership', ['bb', 'dd']);
    const publicSource = f.messages.acceptUserMessage(f.user({ body: 'cross-thread public source' }));
    const privateSource = f.messages.acceptUserMessage(f.user({ body: 'private source never exported', visibility: 'private', audience: ['aa', 'bb'] }));
    const baseline = snapshot(f.db, messageTables);
    for (const input of [
      { threadId: destination.id, sourceRefs: [publicSource.message.id] },
      { threadId: denied.id, targets: ['bb'], sourceRefs: [publicSource.message.id] },
      { threadId: destination.id, targets: ['bb'], visibility: 'private', audience: ['aa', 'bb'], sourceRefs: [privateSource.message.id] },
    ]) {
      assert.throws(() => f.messages.postAgentMessage({ binding, toolCallId: randomUUID(), body: 'cross post attempt', ...input }), rejected);
      assert.deepEqual(snapshot(f.db, messageTables), baseline);
    }
    const valid = f.messages.postAgentMessage({ binding, toolCallId: 'authorized-cross-post', body: 'public source derivative',
      threadId: destination.id, targets: ['bb'], sourceRefs: [publicSource.message.id] });
    assert.equal(valid.message.threadId, destination.id);
    assert.equal(valid.message.sourceThreadId, f.thread.id);
    assert.deepEqual(valid.message.sourceRefs, [publicSource.message.id]);
    checks.push('M02 store subcase: missing cross-post target, unauthorized Thread and private source are rejected atomically; authorized public source keeps immutable provenance');
  }

  {
    const atomicTables = ['threaded_message_sequences', 'threaded_messages', 'threaded_message_attachments',
      'threaded_deliveries', 'threaded_wakes', 'threaded_outbox'];
    for (const table of atomicTables) {
      let notices = 0;
      const f = fixture(`write-failure-${table}`, { onCommitted() { notices++; } });
      const input = f.user({ targets: ['aa'], attachments: [{ name: 'atomic.txt', mediaType: 'text/plain', contentBase64: Buffer.from('atomic').toString('base64') }] });
      f.db.exec(`CREATE TRIGGER fixture_message_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture_message_write_failure'); END;`);
      const baseline = snapshot(f.db, atomicTables);
      assert.throws(() => f.messages.acceptUserMessage(input), /fixture_message_write_failure/);
      assert.deepEqual(snapshot(f.db, atomicTables), baseline);
      assert.equal(notices, 0);
      f.db.exec('DROP TRIGGER fixture_message_failure');
      const receipt = f.messages.acceptUserMessage(input);
      assert.equal(receipt.message.seq, 1, 'rollback does not consume the Thread sequence');
      assert.deepEqual(f.messages.acceptUserMessage(input), receipt);
    }
    const f = fixture('sequence-update-failure');
    f.messages.acceptUserMessage(f.user());
    const before = snapshot(f.db, atomicTables);
    f.db.exec("CREATE TRIGGER fixture_sequence_failure BEFORE UPDATE ON threaded_message_sequences BEGIN SELECT RAISE(ABORT,'fixture_sequence_update_failure'); END;");
    assert.throws(() => f.messages.acceptUserMessage(f.user()), /fixture_sequence_update_failure/);
    assert.deepEqual(snapshot(f.db, atomicTables), before);
    let notices = 0;
    const notificationFailure = fixture('commit-callback-failure', { onCommitted() { notices++; throw new Error('lost process-local hint'); } });
    const request = notificationFailure.user({ targets: ['aa'] });
    const accepted = notificationFailure.messages.acceptUserMessage(request);
    assert.equal(count(notificationFailure.db, 'threaded_messages'), 1);
    assert.equal(count(notificationFailure.db, 'threaded_wakes'), 1);
    assert.deepEqual(notificationFailure.messages.acceptUserMessage(request), accepted);
    assert.equal(notices, 1, 'a failed process-local hint cannot reject durable acceptance or create a second intent');
    checks.push('REC06: SQLite faults at sequence insert/update, message, attachment, delivery, wake and outbox writes roll back the entire intent and suppress commit notification; same-key retry commits once');
  }

  {
    const f = fixture('readonly-message-db');
    const readOnly = new Database(f.databasePath, { readonly: true, fileMustExist: true }); databases.push(readOnly);
    readOnly.pragma('foreign_keys = ON');
    const messages = createThreadedMessages(readOnly, { authority: f.authority, acl: createThreadedMessageAcl(readOnly) });
    const before = snapshot(f.db, messageTables);
    assert.throws(() => messages.acceptUserMessage(f.user({ targets: ['aa'] })), /readonly|read-only/i);
    assert.deepEqual(snapshot(f.db, messageTables), before);
    checks.push('REC06: a read-only SQLite connection rejects acceptance rather than returning an in-memory success');
  }

  {
    const f = fixture('commit-before-notify-crash');
    const input = f.user({ targets: ['aa', 'bb'] });
    const crashed = await worker(f.databasePath);
    await assert.rejects(crashed.call('commitThenExit', input), error => error.exitCode === 23);
    const before = snapshot(f.db, messageTables);
    assert.equal(count(f.db, 'threaded_messages'), 1); assert.equal(count(f.db, 'threaded_wakes'), 2);
    const restarted = await worker(f.databasePath);
    const recovered = await restarted.call('acceptUserMessage', input);
    assert.equal(recovered.message.id, before.threaded_messages[0].id);
    assert.deepEqual(snapshot(f.db, messageTables), before);
    const pending = f.outbox.scanPending();
    assert.deepEqual(new Set(pending.events.map(event => event.id)), new Set(recovered.outboxIds));
    const wakeBefore = snapshot(f.db, ['threaded_wakes', 'threaded_deliveries']);
    assert.deepEqual(f.outbox.scanPendingWakes(), f.outbox.scanPendingWakes());
    assert.deepEqual(snapshot(f.db, ['threaded_wakes', 'threaded_deliveries']), wakeBefore);
    await restarted.close();
    checks.push('REC01/REC05: actual worker exit after DB commit loses the caller receipt/notification; restart recovers the same receipt, original wakes and pending outbox without new work');
  }

  {
    const f = fixture('outbox-owner-generation');
    const accepted = f.messages.acceptUserMessage(f.user());
    assert.equal(accepted.outboxIds.length, 1);
    const a = await worker(f.databasePath), b = await worker(f.databasePath), clock = Date.now() + 60_000;
    await a.call('setClock', clock); await b.call('setClock', clock);
    const acquired = await Promise.all([a.call('claim'), b.call('claim')]);
    assert.equal(acquired.filter(Boolean).length, 1);
    const first = acquired.find(Boolean), winner = acquired[0] ? a : b, successorWorker = acquired[0] ? b : a;
    const hint = await winner.call('notification', first);
    assert.equal(hint.eventId, accepted.outboxIds[0]);
    assert.ok(!Object.hasOwn(hint, 'body')); assert.ok(!Object.hasOwn(hint, 'audience'));
    assert.equal(await successorWorker.call('claim'), null);
    await successorWorker.call('setClock', clock + 2000);
    const successor = await successorWorker.call('claim');
    assert.equal(successor.id, first.id); assert.ok(successor.generation > first.generation);
    assert.notEqual(successor.ownerNonce, first.ownerNonce); assert.notEqual(successor.fencingToken, first.fencingToken);
    const before = snapshot(f.db, ['threaded_outbox', 'threaded_outbox_receipts']);
    for (const [operation, args] of [['ack', [first, 'fixture-consumer']], ['release', [first]], ['renew', [first]], ['notification', [first]]]) {
      await assert.rejects(winner.call(operation, ...args), rejected);
      assert.deepEqual(snapshot(f.db, ['threaded_outbox', 'threaded_outbox_receipts']), before);
    }
    assert.equal(await successorWorker.call('ack', successor, 'fixture-consumer'), true);
    assert.equal(await successorWorker.call('ack', successor, 'fixture-consumer'), false);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    assert.equal(await successorWorker.call('claim'), null);
    await a.close(); await b.close();
    checks.push('REC05: real workers race one outbox event; expired-owner replacement advances the fence, stale ACK/release/renew/hint cannot mutate its successor, and receipt ACK is idempotent');
  }

  {
    const f = fixture('notification-before-ack-crash');
    const receipt = f.messages.acceptUserMessage(f.user({ targets: ['aa'] }));
    const initial = snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes']);
    const hints = [];
    const first = f.outbox.claim('before-crash');
    hints.push(f.outbox.notification(first));
    // No ACK: a restart sees the same event after the old notification lease expires.
    const restarted = createThreadedOutbox(f.db, { now: () => Date.now() + 120_000, leaseMs: 1000 });
    const result = restarted.dispatchOne('after-crash', 'fixture-consumer', hint => hints.push(hint));
    assert.equal(result.status, 'acked');
    assert.deepEqual(hints[1], hints[0]);
    assert.equal(hints[0].eventId, receipt.outboxIds[0]);
    assert.deepEqual(snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes']), initial);
    const beforeAck = snapshot(f.db, ['threaded_outbox', 'threaded_outbox_receipts']);
    f.db.exec("CREATE TRIGGER fixture_ack_failure BEFORE UPDATE OF status ON threaded_outbox WHEN NEW.status='acked' BEGIN SELECT RAISE(ABORT,'fixture_ack_failure'); END;");
    const second = restarted.claim('ack-fault'); assert.ok(second);
    assert.throws(() => restarted.ack(second, 'fixture-consumer'), /fixture_ack_failure/);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), beforeAck.threaded_outbox_receipts.length);
    assert.equal(f.db.prepare('SELECT status FROM threaded_outbox WHERE id=?').get(second.id).status, 'claimed');
    f.db.exec('DROP TRIGGER fixture_ack_failure');
    f.db.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON threaded_outbox_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END;");
    assert.throws(() => restarted.ack(second, 'fixture-consumer'), /fixture_receipt_failure/);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), beforeAck.threaded_outbox_receipts.length);
    assert.equal(f.db.prepare('SELECT status FROM threaded_outbox WHERE id=?').get(second.id).status, 'claimed');
    f.db.exec('DROP TRIGGER fixture_receipt_failure');
    assert.equal(restarted.ack(second, 'fixture-consumer'), true);
    assert.deepEqual(snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes']), initial);
    assert.throws(() => f.db.transaction(() => restarted.dispatchOne('nested', 'fixture-consumer', () => {}))(), /NOTIFY_IN_TRANSACTION/);
    checks.push('REC05/REC06: notify-before-ACK replay repeats only the immutable hint identity; ACK failure rolls back its receipt, never mutates delivery/wake state, and external callbacks cannot run inside an outer transaction');
  }

  {
    const f = fixture('wake-authority-revalidation');
    const input = f.user({ body: 'private pending wake', visibility: 'private', audience: ['aa', 'bb'], targets: ['bb'] });
    const receipt = f.messages.acceptUserMessage(input);
    const messageNotice = f.outbox.claim('fixture');
    assert.equal(messageNotice.eventType, 'message.created'); f.outbox.ack(messageNotice, 'fixture');
    const wakeNotice = f.outbox.claim('fixture'); assert.equal(wakeNotice.eventType, 'wake.available');
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='bb'").run(f.thread.id);
    assert.equal(f.outbox.notification(wakeNotice), null);
    assert.equal(f.db.prepare('SELECT status FROM threaded_wakes WHERE id=?').get(receipt.wakes[0].id).status, 'blocked');
    assert.equal(f.db.prepare('SELECT status FROM threaded_outbox WHERE id=?').get(wakeNotice.id).status, 'rejected');
    assert.deepEqual(f.outbox.scanPendingWakes(), []);
    assert.deepEqual(f.messages.acceptUserMessage(input), receipt, 'receipt records acceptance, not a mutable execution/delivery status');
    assert.equal(count(f.db, 'threaded_invocations'), 0); assert.equal(count(f.db, 'runs'), 0);
    checks.push('REC05/CTX02: an outbox Wake rechecks frozen target permissions, becomes durably blocked/rejected after revocation, and never invents an Invocation or changes the original acceptance receipt');
  }

  {
    const f = fixture('derived-wake-source-revalidation'), binding = f.binding();
    const destination = f.room('derived destination', ['aa', 'bb']);
    const source = f.messages.acceptUserMessage(f.user({ body: 'public source with current membership' }));
    const derived = f.messages.postAgentMessage({ binding, toolCallId: 'derived-notice', threadId: destination.id,
      body: 'source-dependent reply', targets: ['bb'], sourceRefs: [source.message.id] });
    f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='bb'").run(f.thread.id);
    assert.equal(f.messages.getMessage({ ownerId: f.ownerId, threadId: destination.id, viewer: { kind: 'agent', agentId: 'bb' } }, derived.message.id), null);
    const hints = [];
    for (let i = 0; i < 4; i++) if (f.outbox.dispatchOne('fixture', 'fixture', hint => hints.push(hint)).status === 'empty') break;
    assert.equal(hints.filter(hint => hint.eventType === 'wake.available').length, 0);
    assert.equal(f.db.prepare('SELECT status FROM threaded_wakes WHERE id=?').get(derived.wakes[0].id).status, 'blocked');
    assert.deepEqual(f.outbox.scanPendingWakes(), []);
    checks.push('CTX02/REC05: a cross-Thread derived Wake revalidates source membership recursively; losing source access blocks both message reads and all wake hints despite unchanged destination membership');
  }

  {
    const f = fixture('notification-listener-failure');
    const accepted = f.messages.acceptUserMessage(f.user());
    const clock = Date.now() + 60_000; f.setClock(clock);
    const before = snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes']);
    let calls = 0;
    const failed = f.outbox.dispatchOne('fixture', 'fixture', () => { calls++; throw new Error('fixture listener failure'); });
    assert.equal(failed.status, 'retry'); assert.equal(failed.eventId, accepted.outboxIds[0]);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 0);
    assert.equal(f.outbox.claim('too-early'), null);
    f.setClock(clock + 101);
    const success = f.outbox.dispatchOne('fixture', 'fixture', hint => { calls++; assert.equal(hint.eventId, failed.eventId); });
    assert.equal(success.status, 'acked'); assert.equal(calls, 2);
    assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    assert.deepEqual(snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes']), before);
    checks.push('REC01/REC05: a failed synchronous notification listener retains the original event for delayed retry; success records one receipt without duplicating source work');
  }

  {
    const f = fixture('unknown-outbox-protocol');
    const accepted = f.messages.acceptUserMessage(f.user());
    f.outbox.ack(f.outbox.claim('fixture'), 'fixture');
    let callbacks = 0;
    for (const [eventType, schemaVersion] of [['future.event', 1], ['message.created', 2]]) {
      const id = randomUUID();
      f.db.prepare(`INSERT INTO threaded_outbox(id,owner_id,thread_id,event_type,schema_version,source_id,source_version,
        authority_epoch,dedupe_key,request_hash,status,available_at,created_at,updated_at)
        SELECT ?,owner_id,thread_id,?,?,source_id,source_version,authority_epoch,?,request_hash,'pending',available_at,created_at,updated_at
        FROM threaded_outbox WHERE id=?`).run(id, eventType, schemaVersion, `future-fixture:${id}`, accepted.outboxIds[0]);
      assert.equal(f.outbox.dispatchOne('fixture', 'fixture', () => { callbacks++; }).status, 'rejected');
      assert.equal(f.db.prepare('SELECT status FROM threaded_outbox WHERE id=?').get(id).status, 'rejected');
    }
    assert.equal(callbacks, 0); assert.equal(count(f.db, 'threaded_outbox_receipts'), 1);
    assert.equal(count(f.db, 'runs'), 0);
    checks.push('REC05 protocol boundary: unknown outbox event types and future schema versions fail closed without callback, consumer receipt or execution');
  }

  {
    for (const unavailable of ['disabled', 'stale-role']) {
      const f = fixture(`public-derived-${unavailable}`);
      const destination = f.room('derived with unavailable non-target');
      const source = f.messages.acceptUserMessage(f.user({ body: 'source requiring current source membership' }));
      f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='cc'").run(f.thread.id);
      if (unavailable === 'disabled') f.db.exec("UPDATE agents SET enabled=0 WHERE id='cc'");
      else f.db.prepare("UPDATE threaded_members SET role_version=2 WHERE thread_id=? AND agent_id='cc'").run(destination.id);
      const input = f.user({ threadId: destination.id, body: 'public derivative for eligible readers',
        targets: ['aa'], sourceRefs: [source.message.id] });
      const accepted = f.messages.acceptUserMessage(input);
      const scope = { ownerId: f.ownerId, threadId: destination.id, viewer: { kind: 'agent', agentId: 'cc' } };
      assert.equal(f.messages.getMessage(scope, accepted.message.id), null);
      const before = snapshot(f.db, [...messageTables, 'threaded_message_sequences']);
      for (const change of [{ targets: ['cc'] }, { visibility: 'private', audience: ['aa', 'cc'] }]) {
        assert.throws(() => f.messages.acceptUserMessage({ ...input, clientRequestId: randomUUID(), ...change }), rejected);
        assert.deepEqual(snapshot(f.db, [...messageTables, 'threaded_message_sequences']), before);
      }
      if (unavailable === 'disabled') f.db.exec("UPDATE agents SET enabled=1 WHERE id='cc'");
      else f.db.prepare("UPDATE threaded_members SET role_version=1 WHERE thread_id=? AND agent_id='cc'").run(destination.id);
      assert.equal(f.messages.getMessage(scope, accepted.message.id), null, 'restoring destination eligibility does not grant access to a source Thread');
      f.db.prepare("UPDATE threaded_members SET status='joined' WHERE thread_id=? AND agent_id='cc'").run(f.thread.id);
      assert.equal(f.messages.getMessage(scope, accepted.message.id).id, accepted.message.id);
      f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='cc'").run(f.thread.id);
      assert.equal(f.messages.getMessage(scope, accepted.message.id), null, 'every read recursively checks current source authorization');
      assert.deepEqual(f.messages.acceptUserMessage(input), accepted);
    }
    checks.push('CTX02: disabled/stale-role non-target members do not veto public derived writes; explicit target/audience still rejects them, and restored eligibility never bypasses current recursive source ACL');
  }

  {
    const f = fixture('source-depth-transaction-boundary');
    const owner = { ownerId: f.ownerId, threadId: f.thread.id, viewer: { kind: 'owner' } };
    const agent = { ...owner, viewer: { kind: 'agent', agentId: 'aa' } };
    const accepted = [];
    for (let depth = 1; depth <= 32; depth++) {
      const input = f.user({ body: `source chain depth ${depth}`, targets: ['aa'],
        sourceRefs: accepted.length ? [accepted.at(-1).receipt.message.id] : [] });
      const receipt = f.messages.acceptUserMessage(input);
      accepted.push({ input, receipt });
      assert.equal(f.messages.getMessage(owner, receipt.message.id).id, receipt.message.id);
      assert.equal(f.messages.getMessage(agent, receipt.message.id).id, receipt.message.id);
    }
    const before = snapshot(f.db, [...messageTables, 'threaded_message_sequences', 'threaded_message_attachments']);
    assert.throws(() => f.messages.acceptUserMessage(f.user({ body: 'forbidden source chain depth 33', targets: ['aa'],
      sourceRefs: [accepted.at(-1).receipt.message.id],
      attachments: [{ name: 'depth.txt', mediaType: 'text/plain', contentBase64: Buffer.from('must roll back').toString('base64') }] })), rejected);
    assert.deepEqual(snapshot(f.db, [...messageTables, 'threaded_message_sequences', 'threaded_message_attachments']), before);
    for (const { input, receipt } of accepted) assert.deepEqual(f.messages.acceptUserMessage(input), receipt);
    assert.equal(count(f.db, 'threaded_messages'), 32);
    assert.equal(f.messages.getMessage(agent, accepted.at(-1).receipt.message.id).seq, 32);
    checks.push('CTX02/REC06: all 32 nodes of a legal source chain remain readable; a 33rd node is rejected before any sequence/message/attachment/delivery/wake/outbox change and all prior receipts remain frozen');
  }

  assert.equal(networkCalls, 0);
  for (const db of databases) assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls,
    scope: 'T05 message ledger/outbox/ACL only; final execution commit, scheduling and model-context delivery remain later integration work' }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child =>
    new Promise(resolve => { child.once('exit', resolve); child.kill(); })));
  for (const db of databases) if (db.open) db.close();
  await rm(root, { recursive: true, force: true });
}
