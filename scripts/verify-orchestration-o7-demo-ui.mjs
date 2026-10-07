import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { httpClient, waitUntil } from './helpers/orchestration-acceptance.mjs';

const base = process.env.O7_DEMO_URL ?? 'http://127.0.0.1:5174';
const request = httpClient(base);
const options = await request('/api/orchestration/options');
assert.equal(options.verificationEnvironment?.fixture, true, 'Browser demonstration must use the isolated fixture service');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
const output = path.resolve('apps/server/data/orchestration-o7-qa'); await mkdir(output, { recursive: true });
const errors = [], checks = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => sessionStorage.setItem('gand:room-draft:v2', JSON.stringify({ version: 2, goal: '', title: '', selected: [], initialTargets: [], workspace: '', strategy: 'auto', workflow: 'routine', constraints: {}, supervisorId: null, defaultReviewerId: null, aggregatorId: null })));
  page.on('pageerror', error => errors.push(error.message));
  let socketHello = false;
  page.on('websocket', socket => socket.on('framereceived', event => { try { if (JSON.parse(String(event.payload)).type === 'hello') socketHello = true; } catch {} }));
  await page.goto(base);
  await page.getByRole('button', { name: '＋ 新聊天室', exact: true }).click();
  const fleet = page.getByRole('group', { name: '房间成员', exact: true });
  await fleet.getByRole('button', { name: '分析员 A', exact: true }).click();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const measure = () => page.locator('[data-testid="task-composer"]').evaluate(el => ({ width: el.getBoundingClientRect().width, input: el.querySelector('#goal-input').getBoundingClientRect().width }));
    const before = await measure(); await fleet.getByRole('button', { name: 'Claude SDK（模拟）', exact: true }).click();
    assert.equal(await page.getByLabel('本轮策略').inputValue(), 'auto');
    const after = await measure(); assert.ok(Math.abs(before.width - after.width) < 0.5, JSON.stringify({ width, before, after })); assert.ok(Math.abs(before.input - after.input) < 0.5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `demo-${width}.png`), fullPage: true });
    await fleet.getByRole('button', { name: 'Claude SDK（模拟）', exact: true }).click();
  }
  checks.push('真实 Vite 代理页面三种宽度无溢出；选择模拟 SDK 不切策略、不改输入区宽度');
  await page.getByRole('button', { name: '执行设置', exact: true }).click();
  await page.getByLabel('本轮策略').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');
  await page.keyboard.press('Escape');
  const title = 'O7 浏览器验收 ' + Date.now();
  await page.getByLabel('房间名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '选择接收人', exact: true }).click();
  await page.getByRole('group', { name: '本轮对象', exact: true }).getByRole('button', { name: '@分析员 A', exact: true }).click();
  await page.getByLabel('任务目标', { exact: true }).fill('只读分析接口并说明验证结果');
  await page.getByRole('button', { name: '创建并发送', exact: true }).click();
  await page.getByRole('region', { name: '第 1 轮任务', exact: true }).waitFor();
  const detail = await waitUntil(async () => {
    const room = (await request('/api/conversations')).find(item => item.title === title);
    if (!room) return null;
    const value = await request(`/api/conversations/${room.id}`);
    return value.runs[0]?.status === 'completed' ? value : null;
  }, 'BROWSER_TASK');
  await waitUntil(() => socketHello, 'WEBSOCKET_HELLO');
  assert.equal((await request(`/api/runs/${detail.runs[0].id}/orchestration`)).snapshot.executionAuthority, 'orchestration');
  await page.reload(); await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.getByRole('region', { name: '第 1 轮任务', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'demo-task-1440.png'), fullPage: true });
  assert.deepEqual(errors, []);
  checks.push('真实 HTTP/WebSocket 代理创建并完成任务；刷新保留任务卡和冻结策略，键盘可操作，React 零异常');
  const result = { ok: true, scope: 'isolated_local_fixture', checks, browserErrors: errors, realBackendAcceptance: 'not_run' };
  await writeFile(path.join(output, 'demo-ui-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { await page?.screenshot({ path: path.join(output, 'demo-ui-failure.png'), fullPage: true }); throw error; }
finally { await browser.close(); }
