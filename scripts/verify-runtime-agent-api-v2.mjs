import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-agent-api-v2-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const {
  collaborationControlTools,
  parseControlCall,
} = await import('../apps/server/src/collaboration/controlTools.ts');

const names = (version) => collaborationControlTools(version).map((tool) => tool.name);

try {
  assert.throws(() => names(1), /已退役/u);
  assert.deepEqual(names(2), [
    'agent.complete', 'agent.handoff', 'agent.consult', 'agent.hold', 'agent.propose_supervisor_task',
  ]);
  assert.doesNotMatch(JSON.stringify(collaborationControlTools(2)),
    /subjectId|generation|obligationId|claimToken|commandKey/u,
    '模型工具参数不得暴露 Runtime 内部责任或幂等标识');

  assert.deepEqual(parseControlCall({ name: 'agent.handoff', input: JSON.stringify({
    target: 'b', objective: '继续实现', reason: '能力匹配',
  }) }, ['a', 'b', 'c'], 'a', 2), {
    version: 2, type: 'handoff', targetAgentId: 'b', objective: '继续实现', reason: '能力匹配',
  });
  assert.deepEqual(parseControlCall({ name: 'agent.consult', input: JSON.stringify({
    targets: ['b', 'c'], objective: '分别复核', reason: '交叉验证',
  }) }, ['a', 'b', 'c'], 'a', 2), {
    version: 2, type: 'consult', targetAgentIds: ['b', 'c'], objective: '分别复核', reason: '交叉验证', join: 'all',
  });
  assert.deepEqual(parseControlCall({ name: 'agent.hold', input: JSON.stringify({
    question: '是否继续？', reason: '需要用户选择',
  }) }, ['a', 'b'], 'a', 2), {
    version: 2, type: 'hold', wake: {
      kind: 'user_decision', decisionKind: 'agent_question', prompt: '是否继续？',
    }, reason: '需要用户选择',
  });

  // 旧动作仍可做历史解释，但没有旧 schema 或 Alias 下发给模型。
  assert.throws(() => parseControlCall({ name: 'agent.send_message', input: '{}' }, ['a', 'b'], 'a', 2), /已退役/u);
  assert.deepEqual(parseControlCall({ name: 'agent.send_message', input: JSON.stringify({
    target: 'b', message: '旧调用继续执行', reason: 'checkpoint replay',
  }) }, ['a', 'b'], 'a', 2, { historicalAlias: true }), {
    version: 2, type: 'handoff', targetAgentId: 'b', objective: '旧调用继续执行', reason: 'checkpoint replay',
  });
  assert.deepEqual(parseControlCall({ name: 'agent.ask_many', input: JSON.stringify({
    targets: ['b'], question: '旧咨询', reason: 'checkpoint replay',
  }) }, ['a', 'b'], 'a', 1), {
    type: 'ask_many', targetAgentIds: ['b'], question: '旧咨询', reason: 'checkpoint replay',
  });

  console.log('Agent API v2 工具独占暴露与历史动作只读解析验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
