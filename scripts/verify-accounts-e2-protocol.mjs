// Fixed-version native protocol checks. No model turn and no login/start.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-account-protocol-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent' });
const { config } = await import('../apps/server/src/config.ts');
const { closeDatabase } = await import('../apps/server/src/db/database.ts');
const { withRpcProcess } = await import('../apps/server/src/execution/rpc.ts');
const { codexCredentialPolicy } = await import('../apps/server/src/accounts/launch.ts');
const { inspectNative, nativeEnvironment, privateDirectory, initializeAccountPeer } = await import('../apps/server/src/accounts/native.ts');
const native = path.join(config.accounts.privateDir, 'protocol'); const cwd = path.join(root, 'repo'); await mkdir(cwd); await privateDirectory(path.join(native, 'config')); await privateDirectory(path.join(native, 'login'));
const fencedFile = path.join(native, 'private-fixture.txt'); await writeFile(fencedFile, 'private-protocol-marker', { mode: 0o600 });
try {
  const codexVersion = execFileSync(config.externalAgents.codexCommand, ['--version'], { encoding: 'utf8' }).trim(); assert.equal(codexVersion, 'codex-cli 0.159.2');
  await withRpcProcess({ command: config.externalAgents.codexCommand, args: ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'model_provider="gand_account"', '-c', 'model_providers.gand_account={name="Gand protocol fixture",base_url="http://127.0.0.1:1",env_key="GAND_INFERENCE_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false}', ...codexCredentialPolicy()], cwd, env: { ...nativeEnvironment('codex', native), GAND_INFERENCE_TOKEN: 'fixture-protocol-no-inference' }, signal: new AbortController().signal, timeoutMs: 15000 }, async (peer) => {
    await initializeAccountPeer(peer);
    const account = await peer.request('account/read', { refreshToken: false }); assert.equal(account.account, null);
    const response = await peer.request('thread/start', { cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    assert.equal(response.modelProvider, 'gand_account'); assert.equal(response.sandbox.type, 'readOnly'); assert.equal(response.sandbox.networkAccess, false); assert.equal(response.approvalsReviewer, 'user');
    const read = await peer.request('command/exec', { command: ['/bin/cat', fencedFile], cwd, timeoutMs: 3000 }); assert.notEqual(read.exitCode, 0); assert.ok(!read.stdout.includes('private-protocol-marker'), 'Configured native fence must deny credential reads');
    const env = await peer.request('command/exec', { command: ['/usr/bin/env'], cwd, timeoutMs: 3000 }); assert.ok(!env.stdout.includes('GAND_INFERENCE_TOKEN'), 'Native shell must not inherit inference token');
  });
  const codexAuth = await inspectNative('codex', native); assert.equal(codexAuth.authenticated, false);
  const claudeAuth = await inspectNative('claude', path.join(config.accounts.privateDir, 'claude-protocol')); assert.equal(claudeAuth.authenticated, false, 'Independent HOME/config must not reuse personal login');
  console.log('本机原生协议验证通过：Codex 0.159.2 Responses provider/私有路径 deny profile/只读无网络；Codex、Claude 空目录无隐式个人认证；模型调用=0，授权启动=0');
} finally { closeDatabase(); await rm(root, { recursive: true, force: true }); }
