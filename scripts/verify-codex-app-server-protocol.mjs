// Optional local protocol probe: initialize and create an empty thread, never turn/start.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withRpcProcess } from '../apps/server/src/execution/rpc.ts';
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-protocol-'));
const cwd = path.join(root, 'repo'); const nativeHome = path.join(root, 'home'); await mkdir(cwd); await mkdir(nativeHome, { mode: 0o700 });
try {
  await withRpcProcess({ command: process.env.EXTERNAL_CODEX_COMMAND ?? 'codex', args: ['app-server', '--listen', 'stdio://', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false'], cwd, env: { CODEX_HOME: nativeHome }, signal: new AbortController().signal, timeoutMs: 15000 }, async (peer) => {
    await peer.request('initialize', { clientInfo: { name: 'agent_gand', title: 'Agent Gand', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    peer.send({ method: 'initialized', params: {} });
    const response = await peer.request('thread/start', { cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only' });
    assert.equal(response.cwd, cwd); assert.equal(response.approvalPolicy, 'untrusted'); assert.equal(response.approvalsReviewer, 'user'); assert.equal(response.sandbox.type, 'readOnly'); assert.equal(response.sandbox.networkAccess, false); assert.ok(response.thread.id);
    console.log('Real Codex app-server protocol verified: initialize, thread/start, read-only sandbox, user approvals; model turns = 0');
  });
} finally { await rm(root, { recursive: true, force: true }); }
