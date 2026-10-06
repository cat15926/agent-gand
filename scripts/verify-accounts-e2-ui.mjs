import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const base = process.env.GAND_UI_URL ?? 'http://localhost:5173';
const calls = []; const upstream = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; calls.push({ key: req.headers.authorization, path: req.url, body: JSON.parse(raw) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
const prefix = 'E2 浏览器临时' + randomUUID().slice(0, 8); const key = 'fixture-ui-supplier-T123'; const output = path.resolve(import.meta.dirname, '../apps/server/data/accounts-e2-qa'); await mkdir(output, { recursive: true });
async function cleanup() {
  const session = await page.request.post(base + '/api/accounts/session', { headers: { 'x-gand-bootstrap': '1' } }); const csrf = (await session.json()).csrfToken;
  const listing = await page.request.get(base + '/api/accounts');
  for (const account of (await listing.json()).accounts) {
    if (account.source !== 'managed' || !account.displayName.startsWith(prefix) || account.roleCount) continue;
    const login = await page.request.get(`${base}/api/accounts/${account.id}/login`); const operation = await login.json(); if (operation?.id) await page.request.delete(`${base}/api/accounts/logins/${operation.id}`, { headers: { 'x-gand-csrf': csrf } });
    const latest = await page.request.get(`${base}/api/accounts/${account.id}`); const response = await page.request.delete(`${base}/api/accounts/${account.id}`, { headers: { 'x-gand-csrf': csrf }, data: { expectedVersion: (await latest.json()).version } }); assert.equal(response.status(), 200);
  }
}
try {
  await page.goto(base + '/'); await cleanup(); await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '＋ 添加账户或密钥', exact: true }).click(); let dialog = page.getByRole('dialog', { name: '添加账户或密钥' });
  await dialog.getByLabel('连接名称', { exact: true }).fill(prefix + '网关'); await dialog.getByLabel('服务类型', { exact: true }).selectOption('custom');
  await dialog.getByPlaceholder('粘贴供应商提供的密钥').fill(key); await dialog.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${upstream.address().port}/v1`);
  await dialog.getByLabel(/Chat Completions/).check(); await dialog.getByLabel(/模型列表/).fill('fixture-ui-model'); await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  let card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: prefix + '网关', exact: true }) }); await card.getByText('密钥已设置 · ••••T123', { exact: true }).waitFor(); assert.equal(calls.length, 0);
  await card.getByRole('button', { name: '测试模型', exact: true }).click(); dialog = page.getByRole('dialog', { name: '模型连接测试' }); await dialog.getByRole('button', { name: '发送测试请求', exact: true }).click(); await dialog.getByRole('status').filter({ hasText: '测试通过' }).waitFor(); assert.equal(calls.length, 1); assert.equal(calls[0].key, 'Bearer ' + key); assert.ok(!calls[0].body.tools); await dialog.getByRole('button', { name: '关闭账户操作' }).click();
  await card.getByText('模型测试通过', { exact: true }).waitFor(); await card.getByText('最近测试：模型 API · Chat Completions · fixture-ui-model').waitFor();
  await card.getByRole('button', { name: '编辑', exact: true }).click(); dialog = page.getByRole('dialog', { name: '编辑连接配置' }); await dialog.getByLabel(/模型列表/).fill('fixture-ui-model\nother-model'); await dialog.getByRole('button', { name: '保存连接', exact: true }).click(); await card.getByText('测试已过期', { exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept()); await card.getByRole('button', { name: '立即撤销', exact: true }).click(); await card.getByText('已撤销', { exact: true }).waitFor(); assert.equal(await card.getByRole('button', { name: '测试模型', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '＋ 添加账户或密钥', exact: true }).click(); dialog = page.getByRole('dialog', { name: '添加账户或密钥' }); await dialog.getByLabel('认证方式', { exact: true }).selectOption('native_login'); await dialog.getByLabel('账户名称', { exact: true }).fill(prefix + 'Claude'); await dialog.getByLabel('登录客户端', { exact: true }).selectOption('claude'); await dialog.getByRole('button', { name: '创建并登录', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '账户登录' }); await dialog.getByRole('button', { name: '复制命令', exact: true }).waitFor(); assert.match(await dialog.locator('code').innerText(), /^pnpm accounts:login [0-9a-f-]+$/); assert.ok(!(await dialog.innerText()).includes('/Users/'));
  await dialog.getByRole('button', { name: '重新检测', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '尚未完成供应商登录' }).waitFor(); await dialog.getByRole('button', { name: '取消登录', exact: true }).click(); await dialog.getByRole('status').filter({ hasText: '已取消' }).waitFor();
  await page.screenshot({ path: output + '/claude-login-desktop.png', fullPage: true }); await dialog.getByRole('button', { name: '关闭账户操作' }).click();
  const nativeCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: prefix + 'Claude', exact: true }) }); assert.equal(await nativeCard.getByRole('button', { name: '替换密钥', exact: true }).count(), 0); await nativeCard.getByRole('button', { name: '编辑', exact: true }).click(); dialog = page.getByRole('dialog', { name: '编辑连接配置' }); assert.equal(await dialog.getByPlaceholder('粘贴供应商提供的密钥').count(), 0); await dialog.getByRole('button', { name: '关闭账户表单' }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: output + '/mobile.png', fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await nativeCard.getByRole('button', { name: '登录', exact: true }).click(); dialog = page.getByRole('dialog', { name: '账户登录' }); await dialog.waitFor(); await page.screenshot({ path: output + '/native-login-mobile.png', fullPage: true }); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  // Device panel UI fixture; real backend device login is covered by verify:accounts-e2.
  await page.setViewportSize({ width: 1440, height: 960 }); let deviceOperation;
  await page.route('**/api/accounts/*/login', async (route) => { if (route.request().method() !== 'POST') return route.continue(); const accountId = new URL(route.request().url()).pathname.split('/')[3]; deviceOperation = { id: 'fixture-ui-device', accountId, generation: 1, client: 'codex', status: 'pending', error: null, expiresAt: new Date(Date.now() + 600000).toISOString(), verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' }; await route.fulfill({ json: deviceOperation }); });
  await page.route('**/api/accounts/logins/fixture-ui-device', async (route) => { if (route.request().method() === 'DELETE') deviceOperation = { ...deviceOperation, status: 'cancelled', userCode: null, verificationUrl: null }; await route.fulfill({ json: deviceOperation }); });
  await page.getByRole('button', { name: '＋ 添加账户或密钥', exact: true }).click(); dialog = page.getByRole('dialog', { name: '添加账户或密钥' }); await dialog.getByLabel('认证方式', { exact: true }).selectOption('native_login'); await dialog.getByLabel('账户名称', { exact: true }).fill(prefix + 'Codex'); await dialog.getByRole('button', { name: '创建并登录', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '账户登录' }); await dialog.getByText('TEST-1234', { exact: true }).waitFor(); assert.equal(await dialog.getByRole('link', { name: '打开授权页面 ↗' }).getAttribute('href'), 'https://auth.openai.com/codex/device'); await page.screenshot({ path: output + '/codex-device-desktop.png', fullPage: true }); await dialog.getByRole('button', { name: '取消登录', exact: true }).click(); await dialog.getByRole('status').filter({ hasText: '已取消' }).waitFor(); await dialog.getByRole('button', { name: '关闭账户操作' }).click();
  assert.deepEqual(errors, []); assert.ok(!(await page.locator('body').innerText()).includes(key)); console.log('E2 浏览器验收通过：网关创建/显式模型测试/按模型状态/配置变更过期/撤销/Claude 登录引导与检测取消/Codex 设备码面板 fixture/原生编辑/390px/键盘关闭；真实供应商模型请求=0');
} finally { await cleanup(); await browser.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
