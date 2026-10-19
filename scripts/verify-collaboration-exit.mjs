import assert from 'node:assert/strict';
import { classifyCollaborationTurnExit, isTechnicalInterruption } from '../apps/server/src/collaboration/turnExit.ts';
import { turnDisplayKind } from '../apps/server/src/orchestration/turnDisplay.ts';

const turn = (overrides = {}) => ({ content: '完整答复', toolRounds: 0, emptyResponse: false, controlAction: null, ...overrides });
assert.equal(classifyCollaborationTurnExit(turn()).kind, 'answer_candidate');
assert.equal(classifyCollaborationTurnExit(turn({ controlAction: { type: 'finish' } })).kind, 'control_action');
assert.equal(classifyCollaborationTurnExit(turn({ truncated: true, controlAction: { type: 'finish' } })).kind, 'truncated');
assert.equal(classifyCollaborationTurnExit(turn({ approvalStarved: true, content: '' })).kind, 'approval_wait');
assert.equal(classifyCollaborationTurnExit(turn({ emptyResponse: true })).kind, 'empty');
assert.equal(classifyCollaborationTurnExit(turn({ content: '  ' })).kind, 'empty');
assert.equal(isTechnicalInterruption('AGENT_TURN_TRUNCATED: cut'), true);
assert.equal(isTechnicalInterruption('普通协作路由错误'), false);
// Only control-capable prose is temporary; old ordinary replies still stream.
assert.equal(turnDisplayKind({}), 'message');
assert.equal(turnDisplayKind({ controlTools: [] }), 'message');
assert.equal(turnDisplayKind({ displayKind: 'message', controlTools: [{ name: 'agent.complete' }] }), 'control_draft');
assert.equal(turnDisplayKind({ controlTools: [{ name: 'agent.flow_action' }] }), 'control_draft');
assert.equal(turnDisplayKind({ displayKind: 'review_protocol', controlTools: [{ name: 'agent.complete' }] }), 'review_protocol');
assert.equal(turnDisplayKind({ displayKind: 'control_draft' }), 'control_draft');
console.log('Collaboration 回合退出分类与控制草稿/普通流式/审查展示边界验证通过');
