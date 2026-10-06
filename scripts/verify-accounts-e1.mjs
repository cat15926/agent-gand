import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-accounts-e1-'));
const agentsDir = path.join(root, 'agents'); await mkdir(agentsDir);
const dbPath = path.join(root, 'test.sqlite'); const port = 43000 + Math.floor(Math.random() * 1000);
const legacyKey = 'fixture-legacy-openai-X123'; const sdkKey = 'fixture-legacy-sdk-Y456';
Object.assign(process.env, { DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1', AGENTS_DIR: agentsDir,
  LLM_OPENAI_API_KEY: legacyKey, LLM_ANTHROPIC_API_KEY: 'fixture-legacy-anthropic-Z789', ANTHROPIC_API_KEY: sdkKey,
  ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', ACCOUNT_TRUSTED_ORIGINS: `http://127.0.0.1:${port}`, MCP_SERVER_CMD: '' });
const database = await import('../apps/server/src/db/database.ts');
const credentials = await import('../apps/server/src/accounts/credentials.ts');
const { containedPath } = await import('../apps/server/src/execution/policy.ts');
const { resolveSandboxPath, builtinTools } = await import('../apps/server/src/tools/builtin/index.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
let logs = ''; let child; let exiting; let cookie = ''; let csrf = '';
const base = `http://127.0.0.1:${port}`;
const fixtureKey1 = 'fixture-account-one-A123'; const fixtureKey2 = 'fixture-account-two-B456'; const fixtureKey3 = 'fixture-account-rotate-C789';
async function start(extra = {}) {
  child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], { cwd: repo,
    env: { ...process.env, LOG_LEVEL: 'info', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  exiting = new Promise((resolve) => child.once('exit', resolve));
  child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error('账户测试服务器提前退出：' + logs.replace(/fixture-[A-Za-z0-9_-]+/g, '[fixture-redacted]').slice(-2000));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('账户测试服务器启动超时');
}
async function stop() { if (child?.exitCode === null) child.kill('SIGTERM'); await exiting; cookie = ''; csrf = ''; }
async function api(route, method = 'GET', body, headers = {}, auth = true) {
  const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(auth ? { cookie, 'x-gand-csrf': csrf } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  for (const key of [fixtureKey1, fixtureKey2, fixtureKey3, legacyKey, sdkKey]) assert.ok(!raw.includes(key), '账户响应泄露密钥');
  return { status: response.status, data: JSON.parse(raw), response };
}
async function connect(token) {
  const result = await api('/api/accounts/session', 'POST', undefined, { 'x-gand-bootstrap': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) }, false);
  if (result.status === 200) { cookie = result.response.headers.get('set-cookie').split(';')[0]; csrf = result.data.csrfToken; }
  return result;
}
const input = { displayName: '团队 Claude', provider: 'anthropic', apiKey: fixtureKey1, baseUrl: 'https://api.anthropic.com',
  protocols: ['anthropic-messages'], models: ['fixture-model'], defaultModel: 'fixture-model', timeoutMs: 180000 };
try {
  await start();
  assert.equal((await api('/api/accounts', 'GET', undefined, {}, false)).status, 401);
  assert.equal((await api('/api/accounts/session', 'POST', undefined, {}, false)).status, 403);
  assert.equal((await api('/api/accounts/access', 'GET', undefined, { origin: 'https://evil.example' }, false)).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/accounts/access', { headers: { host: 'evil.example' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHost, 403);
  assert.equal((await api('/api/accounts/session', 'POST', undefined, { 'x-gand-bootstrap': '1', 'sec-fetch-site': 'cross-site' }, false)).status, 403);
  const established = await connect(); assert.equal(established.status, 200);
  assert.match(established.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await api('/api/accounts', 'POST', input, { 'x-gand-csrf': '' })).status, 403);
  assert.equal((await api('/api/accounts', 'POST', input, { origin: 'https://evil.example' })).status, 403);
  const cors = await fetch(base + '/api/accounts', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), null);
  const created = await api('/api/accounts', 'POST', input); assert.equal(created.status, 201); const id = created.data.id;
  assert.equal(created.data.authentication, 'configured'); assert.equal(created.data.keySuffix, 'A123'); assert.equal(created.data.testStatus, 'untested');
  const second = await api('/api/accounts', 'POST', { ...input, displayName: '第二个 Claude', apiKey: fixtureKey2 }); assert.equal(second.status, 201);
  assert.notEqual(second.data.id, id); assert.equal(credentials.readCredential(id, 1), fixtureKey1); assert.equal(credentials.readCredential(second.data.id, 1), fixtureKey2);
  assert.equal((await stat(path.join(root, 'private'))).mode & 0o777, 0o700);
  const masterPath = path.join(root, 'private', 'account-master-key.json'); assert.equal((await stat(masterPath)).mode & 0o777, 0o600);
  const listing = (await api('/api/accounts')).data;
  assert.equal(listing.features.roleBinding, true); assert.equal(listing.accounts.filter((item) => item.source === 'managed').length, 2);
  assert.equal(listing.accounts.find((item) => item.id === 'legacy-llm-openai').keySuffix, 'X123');
  assert.equal(listing.accounts.find((item) => item.id === 'legacy-claude-sdk').keySuffix, 'Y456');
  assert.equal(listing.accounts.find((item) => item.id === 'legacy-codex-native').authentication, 'unchecked');
  assert.equal((await api('/api/accounts/legacy-llm-openai', 'PATCH', { expectedVersion: 1, enabled: false })).status, 403);
  for (const overrides of [{ protocols: ['openai-responses'] }, { baseUrl: 'https://user:password@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { apiKey: 'short' }, { authType: 'native_login' }, { defaultModel: 'not-listed' }]) {
    assert.equal((await api('/api/accounts', 'POST', { ...input, ...overrides })).status, 400);
  }
  const malformed = await fetch(base + '/api/accounts', { method: 'POST', headers: { cookie, 'x-gand-csrf': csrf, 'content-type': 'application/json' }, body: `{\"apiKey\":${fixtureKey1}}` });
  assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes(fixtureKey1));
  const renamed = await api(`/api/accounts/${id}`, 'PATCH', { expectedVersion: 1, displayName: '重命名 Claude' }); assert.equal(renamed.status, 200);
  assert.equal(renamed.data.configVersion, 1); assert.equal(renamed.data.version, 2);
  assert.equal((await api(`/api/accounts/${id}`, 'PATCH', { expectedVersion: 1, enabled: false })).status, 409);
  const edited = await api(`/api/accounts/${id}`, 'PATCH', { expectedVersion: 2, models: ['fixture-model', 'fixture-second'], enabled: false });
  assert.equal(edited.status, 200); assert.equal(edited.data.configVersion, 2); assert.equal(edited.data.enabled, false);
  const rotated = await api(`/api/accounts/${id}/credentials`, 'POST', { expectedVersion: 3, apiKey: fixtureKey3 });
  assert.equal(rotated.status, 200); assert.equal(rotated.data.credentialVersion, 2);
  assert.equal(credentials.readCredential(id, 1), fixtureKey1); assert.equal(credentials.readCredential(id, 2), fixtureKey3);
  assert.equal(database.get('SELECT COUNT(*) count FROM account_versions WHERE account_id=?', id).count, 2);
  const check = await api(`/api/accounts/${id}/check`, 'POST'); assert.equal(check.data.testedModel, false); assert.equal(check.data.ok, false);
  const custom = await api('/api/accounts', 'POST', { ...input, displayName: 'Chat 网关', provider: 'custom', protocols: ['openai-chat-completions'], baseUrl: 'http://127.0.0.1:12345/v1' });
  assert.deepEqual(custom.data.compatibleBackends, ['builtin-openai']);
  const refsDef = JSON.stringify({ id: 'future-role', name: '引用角色', accountRef: id });
  database.run("INSERT INTO agents (id,name,definition,source,enabled,version,created_at,updated_at) VALUES ('future-role','引用角色',?,'db',0,1,?,?)", refsDef, new Date().toISOString(), new Date().toISOString());
  database.run("INSERT INTO agent_versions (agent_id,version,definition,created_at) VALUES ('future-role',1,?,?)", refsDef, new Date().toISOString());
  assert.equal((await api(`/api/accounts/${id}/references`)).data.roles.length, 1);
  assert.equal((await api(`/api/accounts/${id}/references`)).data.historicalRoleVersionCount, 0);
  assert.equal((await api(`/api/accounts/${id}`, 'DELETE', { expectedVersion: 4 })).status, 409);
  database.run("DELETE FROM agents WHERE id='future-role'");
  assert.equal((await api(`/api/accounts/${id}/references`)).data.historicalRoleVersionCount, 1);
  const versionOnly = await api('/api/accounts', 'POST', { ...input, displayName: '仅历史角色引用' });
  database.run("INSERT INTO agent_versions (agent_id,version,definition,created_at) VALUES ('deleted-role',1,?,?)", JSON.stringify({ accountRef: versionOnly.data.id }), new Date().toISOString());
  assert.equal((await api(`/api/accounts/${versionOnly.data.id}`, 'DELETE', { expectedVersion: 1 })).data.archived, true);
  assert.equal((await api(`/api/accounts/${versionOnly.data.id}`)).data.archived, true);
  database.run("INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES ('future-run','历史引用','pipeline','pending','[]',?)", new Date().toISOString());
  database.run("INSERT INTO run_account_bindings (run_id,agent_id,account_id,config_version,credential_version,backend,model) VALUES ('future-run','future-role',?,1,1,'claude-sdk','fixture-model')", id);
  assert.equal((await api(`/api/accounts/${id}`, 'DELETE', { expectedVersion: 4 })).status, 409);
  database.run("UPDATE runs SET status='completed' WHERE id='future-run'");
  assert.equal((await api(`/api/accounts/${id}/references`)).data.historicalRunCount, 1);
  assert.throws(() => containedPath(root, masterPath), /私有/);
  assert.throws(() => registerExternal({ path: path.join(root, 'private') }), /私有/);
  const workspace = registerExternal({ path: root });
  assert.throws(() => resolveSandboxPath('private/account-master-key.json', { runId: 'fixture', workspace: `ext:${workspace.id}` }), /私有/);
  await symlink(masterPath, path.join(root, 'key-alias'));
  assert.throws(() => containedPath(root, 'key-alias'), /私有/);
  const search = await builtinTools.find((tool) => tool.name === 'search.files').run({ pattern: '"key":' }, { runId: 'fixture', workspace: `ext:${workspace.id}` });
  assert.ok(!search.includes('account-master-key.json')); assert.ok(!search.includes('key-alias'));
  await stop(); await start(); await connect();
  assert.equal((await api(`/api/accounts/${id}`)).data.credentialVersion, 2); assert.equal(credentials.readCredential(id, 2), fixtureKey3);
  const originalMaster = await readFile(masterPath);
  await rename(masterPath, masterPath + '.backup');
  assert.equal((await api(`/api/accounts/${id}`)).data.authentication, 'locked');
  assert.equal((await api('/api/accounts', 'POST', input)).status, 503);
  await writeFile(masterPath, originalMaster, { mode: 0o600 });
  database.run("UPDATE account_credentials SET tag=? WHERE account_id=? AND version=2", Buffer.alloc(16).toString('base64'), id);
  assert.equal((await api(`/api/accounts/${id}`)).data.authentication, 'locked');
  assert.throws(() => credentials.readCredential(id, 2), /无法解密/);
  const archived = await api(`/api/accounts/${id}`, 'DELETE', { expectedVersion: 4 }); assert.equal(archived.data.archived, true);
  assert.equal((await api(`/api/accounts/${id}`)).data.archived, true); assert.equal(database.get('SELECT COUNT(*) count FROM account_credentials WHERE account_id=?', id).count, 0);
  const cleared = await api(`/api/accounts/${second.data.id}/credentials`, 'DELETE', { expectedVersion: 1 }); assert.equal(cleared.data.authentication, 'missing');
  assert.equal((await api(`/api/accounts/${second.data.id}`, 'DELETE', { expectedVersion: 2 })).data.archived, false);
  assert.equal((await api(`/api/accounts/${second.data.id}`)).status, 404);
  assert.equal((await api('/api/accounts/session', 'DELETE')).status, 200);
  assert.equal((await api('/api/accounts')).status, 401);
  await stop();
  await start({ HOST: '0.0.0.0', ACCOUNT_ADMIN_TOKEN: '' });
  assert.equal((await connect()).status, 503); await stop();
  const managementToken = 'fixture-administrator-token-32-characters';
  await start({ HOST: '0.0.0.0', ACCOUNT_ADMIN_TOKEN: managementToken });
  assert.equal((await connect('incorrect-token')).status, 401); assert.equal((await connect(managementToken)).status, 200);
  assert.equal((await api('/api/accounts')).status, 200); await stop();
  for (const key of [fixtureKey1, fixtureKey2, fixtureKey3, legacyKey, sdkKey, managementToken]) {
    assert.ok(!logs.includes(key), '服务器日志泄露秘密');
    assert.ok(!(await readFile(dbPath)).includes(Buffer.from(key)), '数据库包含明文秘密');
  }
  console.log('账户 E1 验证通过：加密/版本/重启/旧配置/引用/脱敏/Host-Origin-CSRF/远程认证/私有文件保护');
} finally { await stop(); database.closeDatabase(); await rm(root, { recursive: true, force: true }); }
