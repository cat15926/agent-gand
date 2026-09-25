import assert from 'node:assert/strict';
import { evaluateCompletion } from '../apps/server/src/runtime/completion.ts';

const contract = { version: 1, runId: 'r1', objective: '完成', participantIds: ['a', 'b'],
  requiredSubjectKeys: ['root:a', 'root:b'], completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention' };
const subject = (key, overrides = {}) => ({ key, required: key.startsWith('root:'), status: 'completed',
  custodyState: 'completed', holderAgentId: key.endsWith('a') ? 'a' : 'b', pendingHolderAgentId: null,
  generation: 2, hasOutput: true, evidenceValid: true, ...overrides });
const complete = (overrides = {}) => ({ contract, subjects: [subject('root:a'), subject('root:b')],
  dispatches: [{ id: 'a', status: 'completed', error: null }, { id: 'b', status: 'completed', error: null }],
  pendingDecisions: 0, batchStatuses: [], hasAnyOutput: true, dependenciesSatisfied: true,
  requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true, ...overrides });

assert.deepEqual(evaluateCompletion(complete()), { status: 'accepted', reasons: [], disposition: 'normal' });
assert.deepEqual(evaluateCompletion(complete({ pendingDecisions: 1 })), { status: 'waiting', reasons: ['PENDING_USER_DECISION'] });
assert.deepEqual(evaluateCompletion(complete({ dispatches: [{ id: 'a', status: 'running', error: null }] })), { status: 'waiting', reasons: ['OPEN_DISPATCH'] });
assert.equal(evaluateCompletion(complete({ dispatches: [
  { id: 'a', status: 'failed', error: 'boom' }, { id: 'b', status: 'running', error: null },
] })).status, 'failed', '终态失败不能被仍在运行的 Dispatch 掩盖');
assert.equal(evaluateCompletion(complete({ subjects: [subject('root:a')] })).status, 'failed');
assert.equal(evaluateCompletion(complete({ subjects: [subject('root:a'), subject('root:b', { pendingHolderAgentId: 'a' })] })).status, 'rejected');
assert.equal(evaluateCompletion(complete({ subjects: [subject('root:a'), subject('root:b'), subject('consult:c', { required: false, status: 'active', custodyState: 'owned' })] })).status, 'rejected');
assert.equal(evaluateCompletion(complete({ subjects: [subject('root:a'), subject('root:b', { evidenceValid: false })] })).status, 'rejected');
assert.equal(evaluateCompletion(complete({ batchStatuses: ['partial'] })).status, 'failed');
assert.ok(evaluateCompletion(complete({ requiredArtifactsSatisfied: false })).reasons.includes('REQUIRED_ARTIFACTS_MISSING'));
assert.ok(evaluateCompletion(complete({ dependenciesSatisfied: false })).reasons.includes('DEPENDENCIES_NOT_SATISFIED'));
assert.ok(evaluateCompletion(complete({ reviewAccepted: false })).reasons.includes('REVIEW_NOT_ACCEPTED'));
assert.ok(evaluateCompletion(complete({ protocolTerminal: false })).reasons.includes('PROTOCOL_NOT_TERMINAL'));
assert.deepEqual(evaluateCompletion(complete({ disposition: 'partial_user_accepted' })), {
  status: 'accepted', reasons: ['USER_ACCEPTED_PARTIAL_RESULT'], disposition: 'partial_user_accepted',
});
assert.equal(evaluateCompletion(complete({ disposition: 'partial_user_accepted', hasAnyOutput: false })).status, 'rejected');
assert.deepEqual(evaluateCompletion(complete({ disposition: 'delegated', hasAnyOutput: false })), {
  status: 'accepted', reasons: ['USER_APPROVED_DELEGATION'], disposition: 'delegated',
});
console.log('Completion Engine 状态矩阵验证通过');
