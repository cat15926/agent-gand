import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-control-actions-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const actions = await import('../apps/server/src/runtime/controlAction.ts');
const { parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');

const normalized = (value, expectedVersion) => actions.normalizeRuntimeControlAction(value,
  expectedVersion ? { expectedVersion } : {});

try {
  assert.deepEqual(normalized({ type: 'finish' }).action,
    { version: 2, type: 'complete' });
  assert.deepEqual(normalized({ type: 'implicit_complete' }).action,
    { version: 2, type: 'answer_candidate' });
  assert.deepEqual(normalized({ type: 'handoff', targetAgentId: 'b', message: '继续完成', reason: '能力匹配' }).action,
    { version: 2, type: 'handoff', targetAgentId: 'b', objective: '继续完成', reason: '能力匹配' });
  assert.deepEqual(normalized({ type: 'ask_many', targetAgentIds: ['b', 'c'], question: '分别分析', reason: '并行' }).action,
    { version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: '分别分析', reason: '并行', join: 'all' });
  assert.equal(normalized({ type: 'wait_user', question: '是否继续？', reason: '需要决策' }).action.type, 'hold');
  assert.equal(normalized({ type: 'propose_task', title: '实施', goal: '完成实现', acceptanceCriteria: ['测试通过'],
    suggestedAssigneeIds: ['a'], reason: '需要正式流程' }).action.type, 'hold');

  const v2 = { version: 2, type: 'consult', targetAgentIds: ['b'], objective: '评审', reason: '交叉检查', join: 'all' };
  assert.deepEqual(normalized(v2, 2).action, v2);
  assert.equal(normalized(v2, 1).code, 'ACTION_VERSION_MISMATCH');
  assert.equal(normalized({ type: 'future_complete' }).code, 'INVALID_CONTROL_ACTION');
  assert.equal(normalized({ version: 2, type: 'complete', unexpected: 'value' }).action.type, 'complete');

  const answerV1 = actions.answerCandidateControlAction(1);
  assert.deepEqual(answerV1.storedAction, { type: 'implicit_complete' });
  assert.equal(answerV1.action.type, 'answer_candidate');
  const answerV2 = actions.answerCandidateControlAction(2);
  assert.deepEqual(answerV2.storedAction, answerV2.action);

  const call = { id: 'call-1', name: 'agent.send_message', input: JSON.stringify({ target: 'b', message: '接手', reason: '匹配' }) };
  assert.deepEqual(parseControlCall(call, ['a', 'b'], 'a', 1),
    { type: 'handoff', targetAgentId: 'b', message: '接手', reason: '匹配' });
  assert.deepEqual(parseControlCall(call, ['a', 'b'], 'a', 2),
    { version: 2, type: 'handoff', targetAgentId: 'b', objective: '接手', reason: '匹配' });
  assert.deepEqual(parseControlCall({ name: 'agent.complete', input: JSON.stringify({ summary: '最终结果' }) }, ['a', 'b'], 'a', 2),
    { version: 2, type: 'complete', summary: '最终结果' });
  assert.throws(() => parseControlCall({ name: 'agent.send_message', input: JSON.stringify({ target: 'missing', message: '接手', reason: '匹配' }) }, ['a', 'b'], 'a', 2),
    /不是当前聊天室启用成员/u);
  assert.throws(() => parseControlCall({ name: 'agent.send_message', input: JSON.stringify({ target: 'a', message: '接手', reason: '匹配' }) }, ['a', 'b'], 'a', 2),
    /不能把工作交给自己/u);

  const contract = { version: 1, runId: 'new-run', objective: '目标', participantIds: ['a'],
    requiredSubjectKeys: ['root:a'], completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
    features: { controlActionVersion: 2 } };
  actions.freezeRuntimeContract(contract);
  assert.equal(actions.runtimeControlActionVersion('new-run'), 2);
  actions.freezeRuntimeContract({ ...contract, features: { controlActionVersion: 1 } });
  assert.equal(actions.runtimeControlActionVersion('new-run'), 2, '已冻结 Run 不得被后续默认值覆盖');
  assert.equal(actions.runtimeControlActionVersion('historical-without-contract'), 1);
  db.run('INSERT INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)',
    'historical-contract', 1, JSON.stringify({ ...contract, runId: 'historical-contract', features: {} }), new Date().toISOString());
  assert.equal(actions.runtimeControlActionVersion('historical-contract'), 1, '无动作版本字段的存量 Contract 必须固定为 v1');

  console.log('Runtime ControlAction v2、Legacy Adapter、无效动作与版本冻结验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
