// Real React UI with intercepted API fixtures; no user data or supplier model calls.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(import.meta.dirname, '..');
const { createServer } = await import('../apps/web/node_modules/vite/dist/node/index.js');
const vite = await createServer({ root: path.join(repo, 'apps/web'), configFile: path.join(repo, 'apps/web/vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
const output = path.join(repo, 'apps/server/data/room-members-qa'); await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const roles = [
  ['coder', 'Coder', ['execute']], ['sdk', 'SDK 成员', ['execute', 'review'], 'claude-sdk'],
  ['planner', 'Planner', ['execute', 'coordinate']], ['reviewer', 'Reviewer', ['review']],
  ['cli', '只读 CLI 成员', ['execute'], 'claude-cli'],
].map(([id, name, capabilities, driver]) => ({ id, name, capabilities, ...(driver ? { execution: { kind: 'external', driver } } : {}), model: 'mock:fixture', description: 'local UI fixture', systemPrompt: 'fixture', tools: [], disallowedTools: [], permissionMode: 'readonly', color: '#7c5cff', avatar: '', enabled: true, version: 1 }));
const previews = []; const creations = []; const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.routeWebSocket('**/ws', () => {});
await page.route('**/api/**', async (route) => {
  const request = route.request(); const url = new URL(request.url());
  if (url.pathname === '/api/agents') { await route.fulfill({ json: roles }); return; }
  if (request.method() === 'GET' && ['/api/runs', '/api/conversations', '/api/tasks', '/api/approvals', '/api/usage'].includes(url.pathname)) { await route.fulfill({ json: [] }); return; }
  if (url.pathname === '/api/coordination/preview') {
    const input = request.postDataJSON(); previews.push(input);
    await route.fulfill({ json: { snapshot: { agents: roles.filter((role) => input.agentIds.includes(role.id)) }, plan: { steps: [] }, draft: { id: 'fixture-preview', runtimeMode: 'pipeline', decision: 'confirm', displayName: '成员选择规划 fixture', summary: 'fixture', risk: 'low', platformConfidence: 0.8, planning: { source: 'deterministic' }, validationErrors: [], validationIssues: [], alternatives: [] } } }); return;
  }
  if (url.pathname === '/api/conversations' && request.method() === 'POST') {
    creations.push(request.postDataJSON()); await route.fulfill({ status: 409, json: { error: 'fixture 不创建真实聊天室' } }); return;
  }
  await route.fulfill({ status: 404, json: { error: 'unsupported UI fixture route' } });
});
const fleet = () => page.getByRole('group', { name: '舰队成员', exact: true });
const member = (name) => fleet().getByRole('button', { name, exact: true });
const mode = () => page.getByLabel('协作方式', { exact: true });
const pressed = (name) => member(name).getAttribute('aria-pressed');
const composerLayout = () => page.locator('#goal-input').evaluate((input) => {
  const bounds = (element) => { const { x, width } = element.getBoundingClientRect(); return { x, width }; };
  return { composer: bounds(input.parentElement), goal: bounds(input), fleet: bounds(input.parentElement.querySelector('fieldset')), scrolls: input.parentElement.scrollHeight > input.parentElement.clientHeight };
});
const assertStableLayout = (before, after, context) => {
  for (const element of ['composer', 'goal', 'fleet']) for (const dimension of ['x', 'width']) {
    assert.ok(Math.abs(before[element][dimension] - after[element][dimension]) <= 0.5, `${context}: ${element}.${dimension} changed from ${before[element][dimension]} to ${after[element][dimension]}`);
  }
};
try {
  await page.goto(ui); await member('SDK 成员').waitFor();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('gand:room-draft:v1')).selected.length === 3);
  assert.equal(await mode().inputValue(), 'auto'); assert.equal(await pressed('Coder'), 'true'); assert.equal(await pressed('SDK 成员'), 'false'); assert.equal(await pressed('只读 CLI 成员'), 'false');
  await page.locator('#goal-input').fill('保留的任务目标');
  const unselectedLayout = await composerLayout(); await page.screenshot({ path: path.join(output, 'auto-desktop-unselected.png') });
  await member('SDK 成员').click(); assert.equal(await mode().inputValue(), 'auto'); assert.equal(await pressed('SDK 成员'), 'true');
  const selectedLayout = await composerLayout(); await page.screenshot({ path: path.join(output, 'auto-desktop-selected.png') });
  console.log(JSON.stringify({ viewport: 1440, unselectedLayout, selectedLayout })); assertStableLayout(unselectedLayout, selectedLayout, 'desktop SDK selection');
  assert.equal(await page.getByRole('button', { name: '智能规划并开始', exact: true }).isDisabled(), false);
  await page.getByRole('button', { name: '智能规划并开始', exact: true }).click(); await page.getByText('成员选择规划 fixture', { exact: true }).waitFor();
  assert.ok(previews.at(-1).agentIds.includes('sdk')); assert.equal(creations.length, 0);
  await mode().selectOption('collaboration'); assert.equal(await mode().inputValue(), 'collaboration'); assert.equal(await pressed('SDK 成员'), 'true');
  await member('只读 CLI 成员').click(); assert.equal(await mode().inputValue(), 'collaboration'); await page.getByRole('status').filter({ hasText: '目前仅支持顺序流水线' }).waitFor(); assert.equal(await mode().isDisabled(), false); assert.equal(await page.getByRole('button', { name: '创建并发送', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '改用顺序流水线', exact: true }).click(); assert.equal(await mode().inputValue(), 'pipeline'); assert.equal(await pressed('只读 CLI 成员'), 'true');
  await mode().selectOption('auto'); assert.equal(await mode().inputValue(), 'auto'); await page.getByRole('button', { name: '移除只读 CLI 成员', exact: true }).click(); assert.equal(await pressed('SDK 成员'), 'true'); assert.equal(await pressed('只读 CLI 成员'), 'false'); assert.equal(await mode().inputValue(), 'auto');
  await member('SDK 成员').click();
  await member('Coder').click(); await page.getByRole('button', { name: '智能规划并开始', exact: true }).click(); await page.getByText('成员选择规划 fixture', { exact: true }).waitFor(); assert.deepEqual(previews.at(-1).agentIds, ['planner', 'reviewer']); assert.equal(previews.at(-1).goal, '保留的任务目标'); assert.equal(creations.length, 0);
  await member('SDK 成员').click(); assert.equal(await mode().inputValue(), 'auto'); await page.getByText('成员选择规划 fixture', { exact: true }).waitFor({ state: 'detached' });
  await page.reload(); await member('SDK 成员').waitFor(); assert.equal(await mode().inputValue(), 'auto'); assert.equal(await pressed('SDK 成员'), 'true'); assert.equal(await page.locator('#goal-input').inputValue(), '保留的任务目标'); assert.equal(await page.getByRole('button', { name: '智能规划并开始', exact: true }).isDisabled(), false);
  await page.setViewportSize({ width: 390, height: 844 }); await member('SDK 成员').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'auto-mobile.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok((await page.locator('#goal-input').boundingBox()).height > 100, 'mobile task input must retain usable height');
  await member('SDK 成员').focus(); await page.keyboard.press('Space'); assert.equal(await pressed('SDK 成员'), 'false'); assert.equal(await mode().inputValue(), 'auto');
  await mode().selectOption('supervisor'); await member('SDK 成员').click(); assert.equal(await mode().inputValue(), 'supervisor'); await page.reload(); await member('SDK 成员').waitFor(); assert.equal(await mode().inputValue(), 'supervisor'); assert.equal(await pressed('SDK 成员'), 'true');
  for (const viewport of [{ width: 1440, height: 540 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.reload(); await member('SDK 成员').waitFor(); await mode().selectOption('auto');
    if (await pressed('SDK 成员') === 'true') await member('SDK 成员').click();
    const before = await composerLayout();
    await member('SDK 成员').click(); const after = await composerLayout();
    assert.equal(await mode().inputValue(), 'auto'); assertStableLayout(before, after, `${viewport.width}x${viewport.height} SDK selection`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `auto-${viewport.width}-selected.png`) });
    await member('SDK 成员').click(); assertStableLayout(before, await composerLayout(), `${viewport.width}x${viewport.height} SDK deselection`);
    await page.screenshot({ path: path.join(output, `auto-${viewport.width}-unselected.png`) });
    console.log(JSON.stringify({ viewport, unselectedLayout: before, selectedLayout: after }));
  }
  assert.deepEqual(errors, []); assert.equal(creations.length, 0);
  console.log('建房成员浏览器验证通过：默认模型 API 团队、成员点击不改模式、SDK/CLI 兼容提示与显式切换、智能规划候选范围、计划失效、旧草稿恢复、键盘、390/1024/1440px 选择与取消成员不改变表单宽度；真实聊天室创建/供应商模型调用=0。');
} catch (error) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await browser.close(); await vite.close(); }
