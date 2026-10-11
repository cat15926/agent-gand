import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'gand-network-r1-'));
const repo = path.resolve('.'), children = new Set(), sockets = new Set();
const env = { ...process.env, NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', R1_FIXTURE_ROOT: root,
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  SANDBOX_DIR: path.join(root, 'sandbox'), R1_CALL_LOG: path.join(root, 'calls.jsonl'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_RUNTIME_KERNEL: 'execute', ORCHESTRATION_ENTRY_MODE: 'execute',
  ORCHESTRATION_ENABLED_DRIVERS: 'builtin-llm', ORCHESTRATION_ENABLED_WORKFLOWS: 'routine', PORT: '0', HOST: '127.0.0.1' };
for (const key of Object.keys(env)) if (/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_API_|CODEX_ACCESS_|CLAUDE_CODE_OAUTH_|ACCOUNT_MASTER_KEY|ACCOUNT_ADMIN_TOKEN)/.test(key)) delete env[key];
let child, base, port, browser;
async function start() {
  if (!port) {
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
    port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  }
  child = fork(path.join(repo, 'scripts/fixtures/platform-network-server.mjs'), [], { cwd: repo, env: { ...env, PORT:String(port), R1_FIXTURE_PORT: String(port) },
    execArgv: ['--import', path.join(repo, 'apps/server/node_modules/tsx/dist/loader.mjs')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child); let tail = '';
  child.stdout.on('data', chunk => { tail = (tail + chunk).slice(-6000); }); child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-6000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture boot timeout: ' + tail)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${tail}`)); });
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  port = ready.port; base = `http://127.0.0.1:${port}`;
}
async function stop(signal = 'SIGTERM') {
  const current = child; if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise(resolve => { current.once('exit', resolve); current.kill(signal); }); children.delete(current);
}
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, signal: AbortSignal.timeout(10000), ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function waitFor(check, label, limit = 10000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('Timed out: ' + label);
}
async function tap() {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws'), events = []; sockets.add(socket);
  socket.addEventListener('message', event => events.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return { socket, events };
}
async function payload(goal, more = {}) {
  const input = { goal, agentIds: ['network-a'], recipientIds: ['network-a'], strategy: 'serial', workflow: 'routine', constraints: { readonly: true, ...more } };
  const preview = await api('/api/orchestration/preview', 'POST', input); assert.equal(preview.status, 200);
  assert.ok(!preview.data.decision.issues.some(issue => issue.severity === 'error'), JSON.stringify(preview.data.decision.issues));
  return { ...input, entryVersion: 1, clientRequestId: randomUUID(), previewId: preview.data.previewId, orchestrationFingerprint: preview.data.fingerprint };
}
async function terminal(runId, status = 'completed') {
  return waitFor(async () => (await api('/fixture/state')).data.runs.find(run => run.id === runId && run.status === status), status + ' Run');
}
try {
  await start(); const ws = await tap();
  const firstBody = await payload('R1_NETWORK_SUCCESS 一次请求');
  const pair = await Promise.all([api('/api/conversations', 'POST', firstBody), api('/api/conversations', 'POST', firstBody)]);
  assert.deepEqual(pair.map(item => item.status).sort(), [200, 201]); assert.equal(pair[0].data.run.id, pair[1].data.run.id);
  const first = pair[0].data; await terminal(first.run.id);
  await waitFor(() => ws.events.some(event => event.type === 'run.updated' && event.run.id === first.run.id && event.run.status === 'completed'), 'real WS terminal');
  assert.equal((await api('/fixture/state')).data.calls.length, 1, 'concurrent submit invokes one model');
  const conflict = await api('/api/conversations', 'POST', { ...firstBody, goal: 'mutated request' }); assert.equal(conflict.status, 409);

  // Drop a committed HTTP response, then retry its exact payload.
  const lostBody = await payload('R1_NETWORK_SUCCESS response lost');
  await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/conversations', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => { response.destroy(); request.destroy(); resolve(); });
    request.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); }); request.end(JSON.stringify(lostBody));
  });
  const recovered = await api('/api/conversations', 'POST', lostBody); assert.equal(recovered.status, 200); await terminal(recovered.data.run.id);
  assert.equal((await api('/fixture/state')).data.calls.length, 2, 'lost response does not repeat inference');

  // The preview survives a cold host restart before confirmation.
  const beforeCommit = await payload('R1_NETWORK_SUCCESS restart before confirmation');
  ws.socket.close(); await stop(); await start(); const ws2 = await tap();
  const committed = await api('/api/conversations', 'POST', beforeCommit); assert.equal(committed.status, 201); await terminal(committed.data.run.id);
  const callsBefore = (await api('/fixture/state')).data.calls.length;
  ws2.socket.close(); await stop(); await start(); const ws3 = await tap();
  const retried = await api('/api/conversations', 'POST', beforeCommit); assert.equal(retried.status, 200); assert.equal(retried.data.run.id, committed.data.run.id);
  assert.equal((await api('/fixture/state')).data.calls.length, callsBefore, 'cold exact retry preserves terminal and never replays');
  const history = await api(`/api/conversations/${first.conversation.id}/history`); assert.equal(history.status, 200);
  assert.ok(history.data.messages.some(message => message.runId === first.run.id && message.kind === 'agent'));
  assert.equal(new Set(history.data.messages.map(message => message.id)).size, history.data.messages.length);

  const faultBody = await payload('R1_NETWORK_TIMEOUT', { idleTimeoutMs: 200, firstResponseTimeoutMs: 3000 });
  const fault = await api('/api/conversations', 'POST', faultBody); assert.equal(fault.status, 201); await terminal(fault.data.run.id, 'failed');
  const failure = await api(`/api/runs/${fault.data.run.id}/failures`); assert.equal(failure.status, 200);
  assert.ok(failure.data.primaryNodeIds.length); assert.ok(failure.data.nodes.some(node => node.details?.timeoutKind === 'idle'));
  await waitFor(() => ws3.events.some(event => event.type === 'run.updated' && event.run.id === fault.data.run.id && event.run.status === 'failed'), 'WS fault');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.doesNotMatch(JSON.stringify(ws3.events), /R1_LATE_CALLBACK/, 'late provider callbacks must not reach real WS');
  const lateFailure = await api(`/api/runs/${fault.data.run.id}/failures`);
  assert.deepEqual(lateFailure.data.primaryNodeIds, failure.data.primaryNodeIds); assert.equal(lateFailure.data.status, 'failed');
  assert.ok(lateFailure.data.nodes.some(node => node.progress?.lastActivityAt && node.details?.limitMs === 200));

  if (process.env.R1_VERIFY_UI === '1') {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message)); await page.goto(base + '/?room=' + fault.data.conversation.id);
    const panel = page.getByLabel('失败关系与恢复依据', { exact: true }); await panel.waitFor(); await panel.locator('summary').first().click();
    await page.getByText('原始失败', { exact: false }).first().waitFor();
    const output = path.resolve(process.env.R1_QA_DIR ?? 'apps/server/data/platform-r1-qa'); await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'desktop-failure.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'mobile failure details do not widen the page');
    await panel.locator('summary').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'mobile-failure.png') });
    // R2 actual browser: scope/executor separation, private attachment, preview, owner publication and immutable download.
    await page.getByRole('button',{name:'私密',exact:true}).click();
    await page.getByLabel('授权 network-a',{exact:true}).check();
    await page.getByLabel('任务目标',{exact:true}).fill('R2_UI_PRIVATE_SECRET 私密分析附件');
    await page.getByLabel('添加任务附件',{exact:true}).setInputFiles({name:'ui-secret.txt',mimeType:'text/plain',buffer:Buffer.from('R2_UI_FILE_SECRET')});
    await page.getByRole('button',{name:'预览计划',exact:true}).click();
    const privatePreview=page.getByRole('region',{name:'本轮计划'}); await privatePreview.waitFor();
    await privatePreview.getByText('谁能看到：仅你与 network-a',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'mobile-private-preview.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth+1),false,'private preview does not widen mobile page');
    await privatePreview.getByRole('button',{name:'确认并执行本任务',exact:true}).click();
    await waitFor(async()=> (await api('/fixture/state')).data.runs.find(run=>run.goal==='R2_UI_PRIVATE_SECRET 私密分析附件' && run.status==='completed'),'UI private task completion');
    await page.getByRole('button',{name:'公开',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'公开',exact:true}).getAttribute('aria-pressed'),'true','next task scope resets to public');
    await page.getByLabel('聊天室菜单',{exact:true}).click(); await page.getByRole('button',{name:'受控文件与授权',exact:true}).click();
    const drawer=page.getByRole('dialog',{name:'受控文件与授权'}); await drawer.getByText('attachments/ui-secret.txt · v1',{exact:true}).waitFor();
    await drawer.getByText('私密 · 仅你与 network-a',{exact:false}).waitFor();
    const downloadPromise=page.waitForEvent('download'); await drawer.getByRole('button',{name:'下载此版本',exact:true}).click();
    const download=await downloadPromise; assert.equal(download.suggestedFilename(),'ui-secret.txt');
    await drawer.getByRole('button',{name:'扩大授权…',exact:true}).click(); await drawer.getByLabel('文件新可见范围',{exact:true}).selectOption('public');
    await drawer.getByLabel('文件授权原因',{exact:true}).fill('所有者确认发布本验收文件');
    await drawer.getByRole('button',{name:'确认扩大授权并创建新版本',exact:true}).click();
    await drawer.getByText('attachments/ui-secret.txt · v2',{exact:true}).waitFor(); await drawer.getByText('attachments/ui-secret.txt · v1',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'mobile-artifact-versions.png')});
    await page.setViewportSize({width:1440,height:1000}); await page.screenshot({path:path.join(output,'desktop-artifact-versions.png')});
    assert.deepEqual(pageErrors, []); await browser.close(); browser = null;
  }
  // Kill while a budgeted call is in progress. Startup must fence its unknown result, not call the model again.
  const crashBody = await payload('R1_NETWORK_CRASH', { maxTokens: 400, idleTimeoutMs: 30000 });
  const crash = await api('/api/conversations', 'POST', crashBody); assert.equal(crash.status, 201);
  await waitFor(async () => (await api('/fixture/state')).data.calls.some(call => call.scenario === 'crash'), 'started unknown call');
  const snapshot = (await api('/fixture/state')).data.calls.length;
  ws3.socket.close(); await stop('SIGKILL'); await start();
  const after = (await api('/fixture/state')).data;
  assert.equal(after.calls.length, snapshot, 'restart never replays an unconfirmed call');
  assert.ok(after.controls.some(control => control.run_id === crash.data.run.id && control.recovery_attention === 1));
  assert.equal(after.runs.find(run => run.id === crash.data.run.id).status, 'waiting_for_user');
  const denied = await api(`/api/runs/${crash.data.run.id}/actions`, 'POST', { action: 'resume' }); assert.equal(denied.status, 409);
  assert.equal((await api('/fixture/state')).data.calls.length, snapshot);
  // R3 actual owner HTTP: archive persists across a cold host restart, restore is idempotent and model-free.
  const archiveRun=after.runs.find(run=>run.goal==='R2_UI_PRIVATE_SECRET 私密分析附件')??after.runs.find(run=>run.id===committed.data.run.id);
  async function ownerSession(){const r=await fetch(base+'/api/accounts/session',{method:'POST',headers:{'x-gand-bootstrap':'1'}});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],'x-gand-csrf':(await r.json()).csrfToken};}
  let archiveAuth=await ownerSession();
  async function managed(url,body,method='POST'){const r=await fetch(base+url,{method,headers:{...archiveAuth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
  const snapshotUrl='/api/accounts/artifact-snapshots/runs/'+archiveRun.id;
  const archivePreview=await managed(snapshotUrl+'/preview',{paths:[],stageIds:[]});assert.equal(archivePreview.status,200,JSON.stringify(archivePreview.data));
  const archived=await managed(snapshotUrl,{paths:[],stageIds:[],fingerprint:archivePreview.data.fingerprint});assert.equal(archived.status,200,JSON.stringify(archived.data));
  const archiveCalls=(await api('/fixture/state')).data.calls.length;
  await stop();await start();archiveAuth=await ownerSession();
  const archiveRestore=await managed('/api/accounts/artifact-snapshots/'+archived.data.id+'/restore-preview',{});assert.equal(archiveRestore.status,200,JSON.stringify(archiveRestore.data));
  const restoreBody={fingerprint:archiveRestore.data.fingerprint,clientRequestId:randomUUID()};
  const restored=await managed('/api/accounts/artifact-snapshots/'+archived.data.id+'/restores',restoreBody);assert.equal(restored.status,200,JSON.stringify(restored.data));
  const againRestore=await managed('/api/accounts/artifact-snapshots/'+archived.data.id+'/restores',restoreBody);assert.equal(againRestore.status,200);assert.equal(againRestore.data.path,restored.data.path);
  assert.equal((await api('/fixture/state')).data.calls.length,archiveCalls,'snapshot and restore never call models');
  if(archived.data.files.length){const downloaded=await managed('/api/accounts/artifact-snapshots/'+archived.data.id+'/content/file/0',null,'GET');assert.equal(downloaded.status,200);assert.equal(Buffer.from(downloaded.data.contentBase64,'base64').toString(),'R2_UI_FILE_SECRET');}
  console.log(JSON.stringify({ status: 'passed', evidence: 'real loopback HTTP/WS and cold host restart; mocked inference only',
    checks: ['concurrent deduplication', 'lost response retry', 'preview across restart', 'terminal retry after restart', 'WS disconnect/reconnect and history', 'idle timeout diagnostics and late callback fence', 'unknown-call restart fence','R3 owner archive, cold restart and idempotent isolated restore', ...(process.env.R1_VERIFY_UI === '1' ? ['desktop/mobile actual HTTP/WS UI','R2 private preview and attachment','owner download, explicit publication and immutable versions','R3 private versions archived, retained encrypted and owner downloaded after restart'] : [])], supplierRequests: 0 }));
} finally {
  if (browser) await browser.close(); for (const socket of sockets) socket.close();
  await Promise.all([...children].map(worker => new Promise(resolve => {
    if (worker.exitCode !== null || worker.signalCode !== null) return resolve();
    worker.once('exit', resolve); worker.kill('SIGKILL');
  })));
  await rm(root, { recursive: true, force: true });
}
