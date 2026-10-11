import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemoEnvironment } from './helpers/orchestration-demo-environment.mjs';

// All HTTP is fulfilled from the built app and Fastify.inject. No listening sockets.
Object.assign(process.env, { HOST: '127.0.0.1', PORT: '43220', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:43220' });
const output = path.resolve('apps/server/data/business-stage-ui-qa'); await mkdir(output, { recursive: true });
const dist = path.resolve('apps/web/dist'); const origin = 'http://127.0.0.1:43220';
let environment, browser, page, unsubscribe;
let relay = Promise.resolve(); let navigating = false; const pageErrors = [], checks = [];
try {
  environment = await createDemoEnvironment();
  const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts'); await registerAccountRoutes(environment.app);
  const roomResponse = await environment.app.inject({ method: 'POST', url: '/api/conversations/empty', payload: {
    title: '阶段门禁 UI 回归', agentIds: ['aa','bb'], workspace: environment.workspace,
    preferences: { strategy: 'auto', workflow: 'routine', constraints: { readonly: true } },
  } }); assert.equal(roomResponse.statusCode, 201, roomResponse.body);
  const roomId = roomResponse.json().conversation.id;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__fixtureSockets = [];
    class FixtureSocket {
      static OPEN = 1; static CONNECTING = 0; readyState = 1;
      constructor() { window.__fixtureSockets.push(this); queueMicrotask(() => this.onopen?.({})); }
      send() {} close() { this.readyState = 3; this.onclose?.({}); }
    }
    window.WebSocket = FixtureSocket;
  });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...await request.allHeaders(), host: '127.0.0.1:43220' }; delete headers['content-length'];
      const response = await environment.app.inject({ method: request.method(), url: url.pathname + url.search, headers, ...(request.postData() ? { payload: request.postData() } : {}) });
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([k]) => k !== 'content-length').map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]));
      return route.fulfill({ status: response.statusCode, headers: responseHeaders, body: response.body });
    }
    const file = url.pathname === '/' ? path.join(dist, 'index.html') : path.resolve(dist, '.' + url.pathname);
    if (!file.startsWith(dist + path.sep)) return route.abort('blockedbyclient');
    try {
      const body = await readFile(file); const ext = path.extname(file);
      return route.fulfill({ contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[ext] ?? 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  page = await context.newPage(); page.on('pageerror', e => pageErrors.push(e.message));
  const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
  unsubscribe = subscribe(event => { relay = relay.then(async () => { if (!page.isClosed() && !navigating) await page.evaluate(value => {
    for (const socket of window.__fixtureSockets ?? []) socket.onmessage?.({ data: JSON.stringify(value) });
  }, event); }).catch(e => { if (!page.isClosed() && !navigating) pageErrors.push(e.message); }); });
  await page.goto(`${origin}/?room=${roomId}`);
  await page.getByRole('heading', { name: '阶段门禁 UI 回归', exact: true }).waitFor();
  await page.getByRole('button', { name: '执行设置', exact: true }).click();
  await page.getByLabel('本任务启用阶段验收').check();
  await page.getByLabel('阶段执行方式').selectOption('stage_gated');
  await page.getByLabel('阶段 1 名称', { exact: true }).fill('分析方案');
  await page.getByLabel('阶段 1 验收标准', { exact: true }).fill('原因和边界清楚');
  await page.getByLabel('阶段 1 交付项 1', { exact: true }).fill('分析报告');
  await page.getByLabel('阶段 1 任务 1 成员', { exact: true }).selectOption('aa');
  await page.getByLabel('阶段 1 任务 1 内容', { exact: true }).fill('只读分析本轮目标，给出实际结论与边界。');
  await page.getByLabel('阶段 1 执行时限', { exact: true }).fill('30');
  await page.getByLabel('阶段 1 Token 总预算', { exact: true }).fill('12');
  await page.getByRole('button', { name: '添加阶段（最多 8 个）', exact: true }).click();
  await page.getByLabel('阶段 2 名称', { exact: true }).fill('行动计划');
  await page.getByLabel('阶段 2 验收标准', { exact: true }).fill('提供明确行动');
  await page.getByLabel('阶段 2 交付项 1', { exact: true }).fill('行动方案');
  await page.getByLabel('阶段 2 任务 1 成员', { exact: true }).selectOption('bb');
  await page.getByLabel('阶段 2 任务 1 内容', { exact: true }).fill('基于已经验收的分析给出下一步行动，不重复前一成员任务。');
  await page.getByLabel('阶段执行方式').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop-editor.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole('dialog', { name: '执行设置', exact: true });
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile stage editor cannot overflow');
  await page.screenshot({ path: path.join(output, 'mobile-editor.png') });
  await page.getByRole('button', { name: '关闭执行设置', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '选择接收人', exact: true }).isEnabled(), false);
  await page.getByLabel('任务目标', { exact: true }).fill('按阶段完成只读分析与行动方案。');
  await page.getByRole('button', { name: '发送新任务', exact: true }).click();
  await page.getByRole('button', { name: '确认并执行本任务', exact: true }).waitFor();
  assert.ok(await page.getByText('阶段交付后暂停；确认验收后将继续派发下一阶段，可能消耗额度。', { exact: true }).isVisible());
  await page.screenshot({ path: path.join(output, 'mobile-preview.png') });
  await page.getByRole('button', { name: '确认并执行本任务', exact: true }).click();
  await page.getByRole('button', { name: '查看计划、结果与验收', exact: true }).click();
  await page.getByText('执行：已交付，等待验收', { exact: true }).waitFor();
  assert.equal(environment.calls.length, 1, 'stage 2 must not run before owner acceptance');
  const resume = page.getByRole('button', { name: '恢复第 1 轮', exact: true }); await resume.waitFor();
  assert.equal(await resume.isEnabled(), false, 'ordinary resume cannot bypass business gate');
  const evidenceA = page.getByLabel('分析报告 证据', { exact: true });
  await page.waitForFunction(() => document.querySelector('select[aria-label="分析报告 证据"]')?.options.length > 1);
  await evidenceA.selectOption({ index: 1 });
  await page.getByRole('button', { name: '登记交付候选', exact: true }).first().click();
  await page.getByLabel('原因和边界清楚', { exact: true }).check();
  await page.screenshot({ path: path.join(output, 'mobile-acceptance.png') });
  await page.getByRole('button', { name: '验收通过并继续执行', exact: true }).click();
  await page.getByText('2. 行动计划 · 待关联交付证据', { exact: true }).waitFor();
  const evidenceB = page.getByLabel('行动方案 证据', { exact: true });
  await page.waitForFunction(() => document.querySelector('select[aria-label="行动方案 证据"]')?.options.length > 1);
  assert.equal(await evidenceB.locator('option').count(), 2, 'only current stage output can be selected');
  assert.equal(environment.calls.length, 2);
  await evidenceB.selectOption({ index: 1 });
  await page.getByRole('button', { name: '登记交付候选', exact: true }).click();
  await page.getByLabel('提供明确行动', { exact: true }).check();
  await page.getByRole('button', { name: '验收通过并继续执行', exact: true }).click();
  await page.getByText('业务目标：目标已达成 · 2/2 阶段已验收', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, 'desktop-completed.png') });
  assert.equal(environment.calls.length, 2); assert.deepEqual(pageErrors, []); assert.equal(environment.externalRequests, 0);
  checks.push('实际阶段编辑、分工/预算预览与任务级接收人交互', '390px 编辑器无横向溢出', 'Owner cookie/CSRF 与交付登记/勾选验收/自动继续', '普通恢复禁用、下一阶段自动展开、仅当前阶段证据可选', '两个模拟调用完成两阶段，无重复执行或真实供应商请求');

  // R3: real browser owner flow, self-contained Git snapshot, binary/deletion and mobile review.
  const {config}=await import('../apps/server/src/config.ts');
  const {workspaceRootDir}=await import('../apps/server/src/tools/builtin/index.ts');
  const completed=environment.database.get('SELECT * FROM runs WHERE conversation_id=?',roomId);
  const completedPlan=environment.database.get('SELECT id FROM coordination_plans WHERE run_id=?',completed.id);
  const artifactRoot=workspaceRootDir({runId:completed.id,workspace:completed.workspace,workspaceScope:completedPlan.id.slice(0,8)});
  await mkdir(artifactRoot,{recursive:true});
  const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:artifactRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  await writeFile(path.join(artifactRoot,'demo.txt'),'BASE');await writeFile(path.join(artifactRoot,'deleted.txt'),'BASE DELETE');
  git(['init','--template=','--quiet']);git(['add','demo.txt','deleted.txt']);git(['-c','user.name=R3 UI','-c','user.email=r3-ui@example.invalid','commit','--quiet','-m','UI baseline']);
  const uiBaseline=git(['rev-parse','HEAD']);
  await writeFile(path.join(artifactRoot,'demo.txt'),'UI DECLARED CHANGE');await (await import('node:fs/promises')).rm(path.join(artifactRoot,'deleted.txt'));
  await writeFile(path.join(artifactRoot,'chart.bin'),Buffer.from([0,255,42]));await writeFile(path.join(artifactRoot,'.env'),'UI_EXCLUDED_KEY');
  const snapshotsPanel=page.getByLabel('产物与工作树快照',{exact:true});await snapshotsPanel.locator('summary').first().click();
  await snapshotsPanel.getByLabel('快照声明路径',{exact:true}).fill('demo.txt\nchart.bin\ndeleted.txt');
  const snapshotCalls=environment.calls.length;await snapshotsPanel.getByRole('button',{name:'预览产物归档',exact:true}).click();
  const snapshotPreview=snapshotsPanel.getByLabel('产物归档预览',{exact:true});await snapshotPreview.waitFor();
  assert.ok(await snapshotPreview.getByText('本次声明产物完整 · 验收账本版本 4 · 3 个文件版本',{exact:true}).isVisible());
  await snapshotPreview.getByText('查看文件版本、改动与权限',{exact:true}).click();
  await snapshotPreview.screenshot({path:path.join(output,'desktop-artifact-snapshot.png')});
  await page.setViewportSize({width:390,height:844});await snapshotPreview.getByRole('button',{name:'确认保存快照',exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await snapshotPreview.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile artifact manifest cannot overflow');
  await page.screenshot({path:path.join(output,'mobile-artifact-snapshot.png')});
  await snapshotPreview.getByRole('button',{name:'确认保存快照',exact:true}).click();await snapshotsPanel.getByText('产物快照已保存',{exact:true}).waitFor();
  const snapshotRow=snapshotsPanel.locator('details').filter({has:page.getByText('验收版本 4 · 3 个文件版本 · 可清理归档',{exact:true})}).first();await snapshotRow.locator('summary').first().click();
  await snapshotRow.getByText('查看已归档文本（2 项）',{exact:true}).click();
  const textDownloadPromise=page.waitForEvent('download');await snapshotRow.getByRole('button',{name:'下载归档文本',exact:true}).first().click();
  const textDownload=await textDownloadPromise;assert.ok(textDownload.suggestedFilename().endsWith('.txt'));assert.ok((await readFile(await textDownload.path(),'utf8')).length>0);
  await snapshotRow.getByText('查看文件版本、改动与权限',{exact:true}).click();
  const binaryDownloadPromise=page.waitForEvent('download');await snapshotRow.getByRole('button',{name:'下载归档文件',exact:true}).first().click();
  const binaryDownload=await binaryDownloadPromise;assert.equal(binaryDownload.suggestedFilename(),'chart.bin');assert.deepEqual(await readFile(await binaryDownload.path()),Buffer.from([0,255,42]));
  await snapshotRow.getByRole('button',{name:'预览恢复到新目录',exact:true}).click();
  const restorePreview=snapshotsPanel.getByLabel('快照恢复预览',{exact:true});await restorePreview.waitFor();
  await restorePreview.getByRole('button',{name:'确认恢复产物',exact:true}).scrollIntoViewIfNeeded();
  assert.ok(await restorePreview.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:path.join(output,'mobile-artifact-restore.png')});
  await restorePreview.getByRole('button',{name:'确认恢复产物',exact:true}).click();await snapshotsPanel.getByRole('status').filter({hasText:'已恢复到 '}).waitFor();
  const restoredPath=(await snapshotsPanel.getByRole('status').textContent()).replace('已恢复到 ','');
  assert.equal(await readFile(path.join(restoredPath,'demo.txt'),'utf8'),'UI DECLARED CHANGE');assert.deepEqual(await readFile(path.join(restoredPath,'chart.bin')),Buffer.from([0,255,42]));
  assert.equal(execFileSync('git',['-C',restoredPath,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),uiBaseline);
  assert.equal(environment.calls.length,snapshotCalls,'archive and restore never call models');
  checks.push('R3 桌面/390px 声明产物、Git 基线、新增/修改/删除/二进制及遗漏预览','真实浏览器 Owner 完整文本/二进制下载、归档与新目录恢复、保留原 commit、无模型副作用');
  await snapshotsPanel.locator('summary').first().click();

  // Prepare a settled read-only failure. The actual browser must preview and confirm its owner checkpoint.
  const { previewExecutionOrchestration, submitExecutionOrchestration } = await import('../apps/server/src/orchestration/entry.ts');
  const business = await import('../apps/server/src/orchestration/business.ts');
  const coordination = await import('../apps/server/src/coordination/runtime.ts');
  const { getRun } = await import('../apps/server/src/runs/trace.ts');
  const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
  const sourceInput = { goal: 'O7:failure 分阶段分析并完成行动建议', agentIds: ['aa','bb'], strategy: 'serial', workflow: 'routine', constraints: { readonly: true },
    businessContract: { version: 1, executionMode: 'stage_gated', stages: [
      { id: 'foundation', title: '确认基础', criteria: ['基础有依据'], deliverables: [{ id: 'foundation-report', title: '基础交付', kind: 'text' }], execution: { assignments: [{ agentId: 'aa', objective: '只读分析基础' }] } },
      { id: 'actions', title: '行动建议', criteria: ['明确后续行动'], deliverables: [{ id: 'actions-report', title: '后续交付', kind: 'text' }], execution: { assignments: [{ agentId: 'bb', objective: '基于已确认的基础提出建议' }] } },
    ] }, clientRequestId: crypto.randomUUID(), roomTitle: '阶段续跑 UI 回归' };
  const sourcePreview = await previewExecutionOrchestration(Object.fromEntries(Object.entries(sourceInput).filter(([k]) => k !== 'roomTitle')));
  const source = submitExecutionOrchestration({ ...sourceInput, entryVersion: 1, previewId: sourcePreview.previewId, orchestrationFingerprint: sourcePreview.fingerprint });
  await coordination.runCoordinationPlan(source.run, source.run.goal);
  const apply = command => business.applyBusinessCommand(source.run.id, { ...command, expectedVersion: business.getBusinessState(source.run.id).version, clientRequestId: crypto.randomUUID() });
  apply({ action: 'report', stageId: 'foundation', kind: 'delivery', note: '基础通过核对', evidence: [{ deliverableId: 'foundation-report', ref: business.listBusinessEvidence(source.run.id)[0].ref }] });
  apply({ action: 'decide', stageId: 'foundation', reportId: business.getBusinessState(source.run.id).stages[0].report.id, verdict: 'accept', checkedCriteria: [0], reason: '核对通过' });
  await assert.rejects(() => coordination.resumeCoordinationRun(source.run.id)); assert.equal(getRun(source.run.id).status, 'failed');
  const previousChat = mockProvider.chat;
  // The fixture's exact failure trigger is removed; public task wording remains unchanged in the product.
  mockProvider.chat = req => previousChat({ ...req, messages: req.messages.map(m => ({ ...m, content: m.content.replaceAll('O7:failure', 'O7:repaired') })) });
  const priorCalls = environment.calls.length;
  navigating = true; await relay;
  await page.goto(`${origin}/?room=${source.conversation.id}`);
  await page.getByRole('heading', { name: '阶段续跑 UI 回归', exact: true }).waitFor();
  navigating = false;
  await page.getByRole('button', { name: '预览阶段续跑', exact: true }).click();
  const continuation = page.getByLabel('关联续跑预览', { exact: true }); await continuation.waitFor();
  assert.ok(await continuation.getByText('继承已验收阶段：确认基础。已完成的成员步骤从执行图移除。', { exact: true }).isVisible());
  assert.equal(environment.calls.length, priorCalls, 'browser preview has no model call');
  await continuation.screenshot({ path: path.join(output, 'desktop-continuation-preview.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await continuation.screenshot({ path: path.join(output, 'mobile-continuation-preview.png') });
  const overflow = await continuation.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, children: [...el.querySelectorAll('*')].filter(child => child.scrollWidth > child.clientWidth + 1).map(child => ({ tag: child.tagName, width: child.clientWidth, scroll: child.scrollWidth, text: child.textContent.slice(0, 100), className: child.className })) }));
  assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  await continuation.getByRole('button', { name: '确认并续跑', exact: true }).click();
  await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const second = page.getByRole('region', { name: '第 2 轮任务', exact: true }); await second.waitFor();
  await second.getByRole('button', { name: '查看计划、结果与验收', exact: true }).click();
  await second.getByText('2. 行动建议 · 待关联交付证据', { exact: true }).waitFor();
  assert.equal(environment.calls.length, priorCalls + 1, 'accepted foundation must not be called again');
  assert.ok(await second.getByText('继承 1 个已验收阶段 · 复用 1 个成员结果', { exact: true }).isVisible());
  const nextEvidence = second.getByLabel('后续交付 证据', { exact: true });
  await page.waitForFunction(() => document.querySelector('select[aria-label="后续交付 证据"]')?.options.length > 1);
  await nextEvidence.selectOption({ index: 1 });
  await second.getByRole('button', { name: '登记交付候选', exact: true }).click();
  await second.getByLabel('明确后续行动', { exact: true }).check();
  await second.getByRole('button', { name: '验收通过并继续执行', exact: true }).click();
  await second.getByText('业务目标：目标已达成 · 2/2 阶段已验收', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await second.screenshot({ path: path.join(output, 'desktop-continuation-completed.png') });
  assert.equal(getRun(source.run.id).status, 'failed'); assert.equal(environment.calls.length, priorCalls + 1);
  assert.deepEqual(pageErrors, []); assert.equal(environment.externalRequests, 0);
  checks.push('桌面/390px 阶段续跑预览、Owner 确认、新任务来源及继承验收展示', '只调用剩余成员一次、继续验收至达成、原任务仍失败');

  // Actual UI rejection -> explicit revision input -> model-free preview -> linked Run -> fresh acceptance.
  const reworkInput = { ...sourceInput, goal: '分阶段分析并修订行动建议', roomTitle: '阶段返工 UI 回归', clientRequestId: crypto.randomUUID() };
  const rpp = await previewExecutionOrchestration(Object.fromEntries(Object.entries(reworkInput).filter(([k]) => k !== 'roomTitle')));
  const reworkSource = submitExecutionOrchestration({ ...reworkInput, entryVersion: 1, previewId: rpp.previewId, orchestrationFingerprint: rpp.fingerprint });
  await coordination.runCoordinationPlan(reworkSource.run, reworkSource.run.goal);
  const reworkApply = command => business.applyBusinessCommand(reworkSource.run.id, { ...command, expectedVersion: business.getBusinessState(reworkSource.run.id).version, clientRequestId: crypto.randomUUID() });
  reworkApply({ action: 'report', stageId: 'foundation', kind: 'delivery', note: '基础确认', evidence: [{ deliverableId: 'foundation-report', ref: business.listBusinessEvidence(reworkSource.run.id)[0].ref }] });
  reworkApply({ action: 'decide', stageId: 'foundation', reportId: business.getBusinessState(reworkSource.run.id).stages[0].report.id, verdict: 'accept', checkedCriteria: [0], reason: '通过' });
  await coordination.resumeCoordinationRun(reworkSource.run.id);
  navigating = true; await relay; await page.goto(`${origin}/?room=${reworkSource.conversation.id}`);
  await page.getByRole('heading', { name: '阶段返工 UI 回归', exact: true }).waitFor(); navigating = false;
  const rejectedCard = page.getByRole('region', { name: '第 1 轮任务', exact: true });
  await rejectedCard.getByRole('button', { name: '查看计划、结果与验收', exact: true }).click();
  await rejectedCard.getByText('2. 行动建议 · 待关联交付证据', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('select[aria-label="后续交付 证据"]')?.options.length > 1);
  await rejectedCard.getByLabel('后续交付 证据', { exact: true }).selectOption({ index: 1 });
  await rejectedCard.getByRole('button', { name: '登记交付候选', exact: true }).click();
  await rejectedCard.getByLabel('行动建议 说明', { exact: true }).fill('建议缺少反例与限制，需要补充边界。');
  const beforeReject = environment.calls.length;
  await rejectedCard.getByRole('button', { name: '拒绝候选，重新登记', exact: true }).click();
  const reworkPanel = rejectedCard.getByLabel('行动建议 阶段返工', { exact: true }); await reworkPanel.waitFor();
  assert.equal(environment.calls.length, beforeReject, 'rejection does not trigger a model call');
  assert.equal(await reworkPanel.getByRole('button', { name: '预览阶段返工', exact: true }).isEnabled(), false);
  await reworkPanel.getByLabel('行动建议 返工要求', { exact: true }).fill('补充反例与限制，逐项回答并交付完整修订建议。');
  await reworkPanel.getByRole('button', { name: '预览阶段返工', exact: true }).click();
  const reworkPreview = reworkPanel.getByLabel('阶段返工预览', { exact: true }); await reworkPreview.waitFor();
  assert.equal(environment.calls.length, beforeReject); assert.equal(getRun(reworkSource.run.id).status, 'waiting_for_user');
  assert.ok(await reworkPreview.getByText('保留已验收阶段：确认基础。后续阶段须等待本次重新验收。', { exact: true }).isVisible());
  await reworkPreview.screenshot({ path: path.join(output, 'desktop-rework-preview.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await reworkPreview.getByRole('button', { name: '确认并执行返工', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile-rework-preview.png') });
  assert.ok(await reworkPreview.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile rework preview cannot overflow');
  const confirmBox = await reworkPreview.getByRole('button', { name: '确认并执行返工', exact: true }).boundingBox();
  const historyBox = await page.getByTestId('chat-history').boundingBox();
  assert.ok(confirmBox.y >= historyBox.y && confirmBox.y + confirmBox.height <= historyBox.y + historyBox.height, 'mobile confirmation must be fully visible inside the message viewport');
  const jumpButton = page.getByRole('button', { name: /跳到最新/ });
  if (await jumpButton.isVisible()) {
    const jumpBox = await jumpButton.boundingBox();
    assert.ok(confirmBox.y + confirmBox.height <= jumpBox.y || confirmBox.y >= jumpBox.y + jumpBox.height
      || confirmBox.x + confirmBox.width <= jumpBox.x || confirmBox.x >= jumpBox.x + jumpBox.width,
      JSON.stringify({ issue: 'mobile latest-message shortcut cannot cover the rework confirmation', confirmBox, jumpBox,
        history: await page.getByTestId('chat-history').boundingBox() }));
  }
  await reworkPreview.getByRole('button', { name: '关闭返工预览', exact: true }).click();
  assert.equal(environment.calls.length, beforeReject); assert.equal(getRun(reworkSource.run.id).status, 'waiting_for_user');
  await reworkPanel.getByRole('button', { name: '预览阶段返工', exact: true }).click(); await reworkPreview.waitFor();
  await reworkPanel.getByLabel('行动建议 返工要求', { exact: true }).fill('补充反例与限制，说明每项建议的适用条件。');
  await reworkPreview.waitFor({ state: 'detached' });
  await reworkPanel.getByRole('button', { name: '预览阶段返工', exact: true }).click(); await reworkPreview.waitFor();
  await reworkPreview.getByRole('button', { name: '确认并执行返工', exact: true }).click();
  await page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const revisedCard = page.getByRole('region', { name: '第 2 轮任务', exact: true }); await revisedCard.waitFor();
  await revisedCard.getByRole('button', { name: '查看计划、结果与验收', exact: true }).click();
  await revisedCard.getByText('2. 行动建议 · 待关联交付证据', { exact: true }).waitFor();
  assert.equal(environment.calls.length, beforeReject + 1, 'only the rejected stage is rerun');
  assert.equal(getRun(reworkSource.run.id).status, 'cancelled');
  await revisedCard.getByText('查看本轮返工来源与修订要求', { exact: true }).click();
  assert.ok(await revisedCard.getByText(/修订要求：补充反例与限制，说明每项建议的适用条件/).isVisible());
  await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="第 2 轮任务"] select[aria-label="后续交付 证据"]')].some(el => el.options.length > 1));
  const revisedEvidence = revisedCard.getByLabel('后续交付 证据', { exact: true }); assert.equal(await revisedEvidence.locator('option').count(), 2, 'rejected original output is not selectable');
  await revisedEvidence.selectOption({ index: 1 }); await revisedCard.getByRole('button', { name: '登记交付候选', exact: true }).click();
  await revisedCard.getByLabel('明确后续行动', { exact: true }).check();
  await revisedCard.getByRole('button', { name: '验收通过并继续执行', exact: true }).click();
  await revisedCard.getByText('业务目标：目标已达成 · 2/2 阶段已验收', { exact: true }).waitFor();
  await revisedCard.getByText('业务目标：目标已达成 · 2/2 阶段已验收', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile-rework-completed.png') });
  const historySurface = page.getByTestId('chat-history');
  await historySurface.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await page.getByRole('navigation', { name: '消息阅读导航', exact: true }).waitFor();
  const { post } = await import('../apps/server/src/messaging/inbox.ts');
  post({ runId: business.getBusinessState(reworkSource.run.id).successorRunId, from: 'aa', to: 'user', kind: 'agent', body: 'UI_READING_POSITION 验证浏览历史时保留位置。', messageType: 'informational' });
  await relay;
  await page.getByRole('button', { name: /条新消息.*跳到最新/ }).waitFor();
  assert.ok(await historySurface.evaluate(el => el.scrollTop < 5), 'new messages cannot interrupt history reading');
  await page.getByRole('button', { name: /跳到最新/ }).click();
  await page.waitForFunction(() => { const el = document.querySelector('[data-testid="chat-history"]'); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 5; });
  await page.getByRole('navigation', { name: '消息阅读导航', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(pageErrors, []); assert.equal(environment.externalRequests, 0);
  checks.push('实际 UI 拒绝不自动调用模型、返工必填要求、预览关闭/编辑无模型副作用', '桌面/390px 返工范围与原执行关闭说明、仅被拒绝阶段调用一次', '旧候选不可选、原验收记录封存、继承基础阶段并重新验收至达成', '独立消息导航不遮挡确认按钮、新消息不抢阅读位置、点击可回到最新并关闭导航');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, screenshots: ['desktop-editor.png','mobile-editor.png','mobile-preview.png','mobile-acceptance.png','desktop-completed.png','desktop-artifact-snapshot.png','mobile-artifact-snapshot.png','mobile-artifact-restore.png','desktop-continuation-preview.png','mobile-continuation-preview.png','desktop-continuation-completed.png','desktop-rework-preview.png','mobile-rework-preview.png','mobile-rework-completed.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output, listeningPorts: 0, realProviderRequests: 0 }, null, 2));
} finally { unsubscribe?.(); await relay; await browser?.close(); await environment?.close(); }
