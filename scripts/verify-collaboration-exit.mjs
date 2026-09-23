import assert from 'node:assert/strict';
import { classifyCollaborationTurnExit, isTechnicalInterruption } from '../apps/server/src/collaboration/turnExit.ts';

const turn = (overrides = {}) => ({ content: '完整答复', toolRounds: 0, emptyResponse: false, controlAction: null, ...overrides });
assert.equal(classifyCollaborationTurnExit(turn()).kind, 'answer_candidate');
assert.equal(classifyCollaborationTurnExit(turn({ controlAction: { type: 'finish' } })).kind, 'control_action');
assert.equal(classifyCollaborationTurnExit(turn({ truncated: true, controlAction: { type: 'finish' } })).kind, 'truncated');
assert.equal(classifyCollaborationTurnExit(turn({ approvalStarved: true, content: '' })).kind, 'approval_wait');
assert.equal(classifyCollaborationTurnExit(turn({ emptyResponse: true })).kind, 'empty');
assert.equal(classifyCollaborationTurnExit(turn({ content: '  ' })).kind, 'empty');
assert.equal(isTechnicalInterruption('AGENT_TURN_TRUNCATED: cut'), true);
assert.equal(isTechnicalInterruption('普通协作路由错误'), false);
console.log('Collaboration 回合退出分类验证通过');
