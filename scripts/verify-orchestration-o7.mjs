import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDemoEnvironment } from './helpers/orchestration-demo-environment.mjs';
import { AcceptanceError, backendSmoke, httpClient, submitConfirmedTask, waitUntil } from './helpers/orchestration-acceptance.mjs';
import { parseRealAcceptanceArgs } from './orchestration-real-acceptance.mjs';

const environment = await createDemoEnvironment();
const { cleanupInventory } = await import('./orchestration-cleanup-inventory.mjs');
const output = path.resolve('apps/server/data/orchestration-o7-qa');
const checks = [];
await mkdir(output, { recursive: true });
try {
  await environment.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${environment.app.server.address().port}`;
  const request = httpClient(base);
  const finish = async submitted => waitUntil(async () => {
    const result = await request(`/api/runs/${submitted.run.id}`);
    return ['completed', 'failed', 'cancelled'].includes(result.run.status) ? result : null;
  }, 'DEMO_RUN');
  const run = async body => {
    const submitted = await submitConfirmedTask(request, body);
    assert.equal((await finish(submitted)).run.status, 'completed'); return submitted;
  };
  const rootInfo = await request('/api/health'); assert.equal(rootInfo.ok, true);
  const empty = await request('/api/conversations/empty', { title: 'O7 空房', agentIds: ['aa', 'bb'], preferences: { strategy: 'auto', workflow: 'routine', constraints: {} } });
  assert.equal(empty.conversation.runCount, 0); assert.equal(environment.calls.length, 0);
  const automatic = await run({ conversationId: empty.conversation.id, goal: 'O7:auto 只读分析接口', recipientIds: ['aa'], constraints: { readonly: true } });
  assert.equal((await request(`/api/runs/${automatic.run.id}/orchestration`)).snapshot.executionAuthority, 'orchestration');
  checks.push('真实 HTTP 服务：空房零调用，自动任务使用统一执行契约；确认与重复提交只创建同一任务');

  const serial = await run({ goal: 'O7:serial 只读比较接口', agentIds: ['aa', 'bb'], recipientIds: ['bb', 'aa'], strategy: 'serial', constraints: { readonly: true } });
  const relay = await request(`/api/runs/${serial.run.id}/coordination`);
  assert.ok(relay.steps.filter(step => step.status === 'completed').length >= 2);
  const serialCalls = environment.calls.filter(item => item.text.includes('O7:serial'));
  assert.deepEqual(serialCalls.map(item => item.model), ['mock:bb', 'mock:aa']);
  assert.ok(serialCalls[1].text.includes('2 + 2 = 4'));
  checks.push('顺序接力：实际成员顺序与确认计划一致，下游收到前序产物');

  const analysis = await run({ goal: 'O7:analysis 分析接口并汇总', agentIds: ['aa', 'bb', 'summary'], recipientIds: ['aa', 'bb'], workflow: 'analysis_summary', aggregatorId: 'summary' });
  const analysisState = await request(`/api/runs/${analysis.run.id}/coordination`);
  const aggregate = analysisState.steps.find(step => step.stepId === 'analysis-summary');
  assert.ok(analysisState.steps.filter(step => step.stepId.startsWith('work-')).every(step => step.completedAt <= aggregate.startedAt));
  checks.push('分析与汇总：必要分支结束后才运行显式汇总者');

  const approvalTask = await submitConfirmedTask(request, { goal: 'O7:approval 写入演示文件', agentIds: ['writer'], recipientIds: ['writer'], strategy: 'serial' });
  const approvalDetail = await waitUntil(async () => { const detail = await request(`/api/runs/${approvalTask.run.id}`); return detail.approvals.some(item => item.status === 'pending') ? detail : null; }, 'APPROVAL');
  const card = approvalDetail.approvals.find(item => item.status === 'pending');
  assert.equal(card.runId, approvalTask.run.id);
  await request(`/api/approvals/${card.id}/decide`, { decision: 'approve', by: 'O7 fixture' });
  assert.equal((await finish(approvalTask)).run.status, 'completed');
  assert.equal((await request(`/api/runs/${approvalTask.run.id}/tool-executions`)).filter(item => item.toolName === 'fs.write' && item.status === 'completed').length, 1);
  checks.push('审批等待：审批卡归属原任务，批准后同一任务继续，写入账本仅一条完成记录');

  const paused = await submitConfirmedTask(request, { goal: 'O7:pause 只读比较接口', agentIds: ['aa', 'bb'], recipientIds: ['aa', 'bb'], strategy: 'serial', constraints: { readonly: true } });
  await request(`/api/runs/${paused.run.id}/actions`, { action: 'pause' });
  await waitUntil(async () => (await request(`/api/runs/${paused.run.id}`)).run.status === 'waiting_for_user', 'PAUSED');
  await request(`/api/runs/${paused.run.id}/actions`, { action: 'resume' });
  assert.equal((await finish(paused)).run.status, 'completed');
  checks.push('任务暂停与恢复：明确恢复原 Run，不新建任务或改变冻结计划');

  const development = await run({ goal: 'O7:development 实现接口说明并独立评审', agentIds: ['aa', 'reviewer'], recipientIds: ['aa'], workflow: 'development_review', defaultReviewerId: 'reviewer', workspace: environment.workspace });
  const developmentState = await request(`/api/runs/${development.run.id}/coordination`);
  assert.equal(developmentState.steps.find(step => step.stepId === 'review-independent').status, 'completed');
  assert.equal(await readFile(path.join(environment.source, 'README.md'), 'utf8'), 'O7 demo baseline\n');
  checks.push('开发与评审：实现与独立评审按依赖运行，完成门禁通过，注册源仓库保持原样');

  const backends = [];
  const registry = await import('../apps/server/src/agents/registry.ts');
  const sdkRole = registry.getAgent('sdk');
  registry.updateAgent('sdk', { ...sdkRole, permissionMode: 'auto', execution: { ...sdkRole.execution, nativeTools: ['Write', 'Bash'] } }, sdkRole.version);
  for (const [agentId, driver] of [['sdk', 'claude-sdk'], ['codex', 'codex-app-server']]) {
    const smoke = await backendSmoke(request, { agentId, driver, timeoutMs: 15_000 });
    assert.equal(smoke.status, 'passed', JSON.stringify(smoke)); assert.ok(smoke.accountId); assert.ok(smoke.hasExecutionBinding);
    backends.push(smoke);
  }
  assert.equal((await environment.nativeCalls()).filter(item => item.kind === 'turn').length, 2);
  assert.equal(registry.getAgent('sdk').permissionMode, 'auto');
  assert.deepEqual(registry.getAgent('sdk').execution.nativeTools, ['Write', 'Bash']);
  const readonlySdk = await run({ goal: 'O7:readonly-sdk 只读验证', agentIds: ['sdk'], recipientIds: ['sdk'], strategy: 'serial', constraints: { readonly: true } });
  const readonlyExecutions = await request(`/api/runs/${readonlySdk.run.id}/executions`);
  assert.equal(readonlyExecutions.length, 1); assert.equal(readonlyExecutions[0].permissionMode, 'readonly');
  assert.equal(registry.getAgent('sdk').permissionMode, 'auto');
  assert.deepEqual(registry.getAgent('sdk').execution.nativeTools, ['Write', 'Bash']);
  checks.push('配置原生写工具的 SDK 角色可执行自动/接力只读请求；权限收紧不修改角色白名单');
  checks.push('SDK / app-server 模拟驱动走真实 HTTP、冻结托管账户和有效 attempt 绑定；重复提交未重复启动原生调用');

  const failed = await submitConfirmedTask(request, { goal: 'O7:failure 分别分析接口', agentIds: ['aa', 'bb'], recipientIds: ['aa', 'bb'], strategy: 'parallel', constraints: { readonly: true } });
  assert.equal((await finish(failed)).run.status, 'failed');
  const failedState = await request(`/api/runs/${failed.run.id}/coordination`);
  assert.equal(failedState.steps.find(step => step.stepId === 'complete').status, 'pending');
  assert.equal((await backendSmoke(request, { agentId: 'aa', driver: 'claude-sdk' })).errorCode, 'MANAGED_AGENT_REQUIRED');
  checks.push('失败边界：必要分支失败不得假完成；真实测试入口拒绝无匹配托管账户的角色');

  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/orchestration-real-acceptance.mjs', '--base-url', base, '--claude-agent', 'sdk', '--output', path.join(environment.root, 'false-real.json')]), error => error.code === 1 && error.stderr.includes('fixture'));
  assert.throws(() => parseRealAcceptanceArgs([]));
  assert.throws(() => parseRealAcceptanceArgs(['--claude-agent', 'sdk', '--api-key', 'never-accepted']));
  assert.throws(() => httpClient('http://secret@localhost:3010'));
  let lostSubmissions = 0;
  const lostResponse = await backendSmoke(async (endpoint, payload) => {
    const value = await request(endpoint, payload);
    if (payload && endpoint.endsWith('/requests')) { lostSubmissions++; throw new AcceptanceError('SERVICE_UNREACHABLE_OR_REQUEST_RESULT_UNKNOWN'); }
    return value;
  }, { agentId: 'sdk', driver: 'claude-sdk', timeoutMs: 15_000 });
  assert.equal(lostSubmissions, 1); assert.ok(lostResponse.clientRequestId); assert.ok(lostResponse.conversationId);
  assert.equal(lostResponse.runId, null); assert.equal(lostResponse.errorCode, 'SERVICE_UNREACHABLE_OR_REQUEST_RESULT_UNKNOWN');
  const lostRun = await waitUntil(async () => { const detail = await request(`/api/conversations/${lostResponse.conversationId}`); return detail.runs[0]?.status === 'completed' ? detail.runs[0] : null; }, 'LOST_RESPONSE_TASK');
  assert.equal((await request(`/api/runs/${lostRun.id}/executions`)).length, 1);
  const statistics = await request('/api/orchestration/entry-statistics');
  assert.ok(statistics.statistics.length > 0); assert.equal(statistics.containsRequestContent, false);
  const serialized = JSON.stringify(statistics);
  for (const value of ['O7:auto', 'o7-fixture-not-real', 'O7:failure']) assert.ok(!serialized.includes(value));
  assert.equal(environment.externalRequests, 0);
  checks.push('真实验收拒绝 fixture 和密钥参数；提交响应丢失保留房间/幂等 ID，不自动重发；统计与报告不保存敏感正文');
  const inventory = cleanupInventory(path.join(environment.root, 'demo.sqlite'));
  assert.equal(inventory.readOnly, true); assert.equal(inventory.traffic.available, true);
  assert.equal(inventory.cleanup.canRemoveCompatibility, false); assert.equal(inventory.cleanup.userConfirmationRecorded, false);
  assert.equal(inventory.cleanup.realAccountsVerifiedByThisCommand, false);
  checks.push('清理盘点只读且提供入口统计；迁移和本地测试通过不会代替用户确认或触发兼容分支删除');
  const result = { ok: true, scope: 'isolated_local_fixture', checks, backends, realProviderRequests: environment.externalRequests,
    realBackendAcceptance: { 'claude-sdk': 'not_run', 'codex-app-server': 'not_run' } };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await environment.close(); }
