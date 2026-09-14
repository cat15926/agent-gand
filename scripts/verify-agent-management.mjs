import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-roles-'));
const agentsDir = path.join(root, 'agents'); await mkdir(agentsDir);
await writeFile(path.join(agentsDir, 'planner.agent.md'), `---\nname: Planner\ndescription: 协调测试\nmodel: mock:planner\ncapabilities: [coordinate, execute]\ntools: []\npermissionMode: confirm\ncolor: '#7c5cff'\n---\n负责协调。`);
const dbPath = path.join(root, 'test.sqlite'); const port = 40000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], { cwd: repo, env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
const childExit = new Promise((resolve) => child.once('exit', resolve));
let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
async function api(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, data: await response.json() }; }
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); if (i === 99) throw new Error(logs); }
  const options = await api('/api/agent-options'); assert.equal(options.status, 200); assert.ok(options.data.tools.some((tool) => tool.name === 'fs.read'));
  const bad = await api('/api/agents/validate', 'POST', { id: 'Bad ID' }); assert.equal(bad.status, 400); assert.ok(bad.data.fieldErrors.id);
  const input = { id: 'qa-reviewer', name: 'QA Reviewer', description: '检查实现结果', capabilities: ['review'], systemPrompt: '请严格检查结果并给出结论。', model: 'mock:reviewer', tools: ['fs.read'], disallowedTools: [], permissionMode: 'readonly', color: '#3366aa' };
  const created = await api('/api/agents', 'POST', input); assert.equal(created.status, 201); assert.equal(created.data.version, 1);
  assert.equal((await api('/api/agents', 'POST', input)).status, 409);
  assert.equal((await api('/api/agents/planner', 'PATCH', { ...input, expectedVersion: 1 })).status, 403);
  const updated = await api('/api/agents/qa-reviewer', 'PATCH', { ...input, description: '更新后的描述', expectedVersion: 1 }); assert.equal(updated.status, 200); assert.equal(updated.data.version, 2);
  assert.equal((await api('/api/agents/qa-reviewer', 'PATCH', { ...input, expectedVersion: 1 })).status, 409);
  const room = await api('/api/conversations', 'POST', { goal: '检查快照', mode: 'pipeline', agentIds: ['qa-reviewer'], defaultReviewerId: 'qa-reviewer' }); assert.equal(room.status, 201, JSON.stringify(room.data));
  await api('/api/agents/qa-reviewer', 'PATCH', { ...input, description: '快照之后修改', expectedVersion: 2 });
  const require = createRequire(import.meta.url); const Database = require('../apps/server/node_modules/better-sqlite3'); const db = new Database(dbPath, { readonly: true });
  const snapshot = JSON.parse(db.prepare('SELECT definition FROM run_agent_snapshots WHERE run_id=?').get(room.data.run.id).definition); db.close(); assert.equal(snapshot.version, 2); assert.equal(snapshot.description, '更新后的描述');
  const disabled = await api('/api/agents/qa-reviewer/status', 'PATCH', { enabled: false, expectedVersion: 3 }); assert.equal(disabled.status, 200); assert.equal(disabled.data.enabled, false);
  assert.ok(!(await api('/api/agents')).data.some((agent) => agent.id === 'qa-reviewer')); assert.ok((await api('/api/agents?includeDisabled=1')).data.some((agent) => agent.id === 'qa-reviewer'));
  assert.equal((await api(`/api/conversations/${room.data.conversation.id}/messages`, 'POST', { body: '继续', clientMessageId: crypto.randomUUID() })).status, 400);
  console.log('agent management verification passed');
} finally { if (child.exitCode === null) child.kill('SIGTERM'); await childExit; await rm(root, { recursive: true, force: true }); }
