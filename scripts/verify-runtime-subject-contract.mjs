import assert from 'node:assert/strict';
import { planCollaborationAdmission, subjectRelationForDispatch, evaluateRequiredSubjects } from '../apps/server/src/runtime/subjectContract.ts';

const planned = planCollaborationAdmission({ runId: 'run-1', objective: '并行分析', participantIds: ['a', 'b', 'c'], targetAgentIds: ['a', 'b', 'a'] });
assert.deepEqual(planned.contract.requiredSubjectKeys, ['root:a', 'root:b']);
assert.deepEqual(planned.subjects.map((subject) => subject.initialHolderAgentId), ['a', 'b']);
assert.equal(planned.contract.completionPolicy, 'all_required');
assert.throws(() => planCollaborationAdmission({ runId: 'run-2', objective: '非法', participantIds: ['a'], targetAgentIds: ['b'] }));
assert.equal(subjectRelationForDispatch('handoff'), 'same');
assert.equal(subjectRelationForDispatch('resume'), 'same');
assert.equal(subjectRelationForDispatch('fanout'), 'consultation_child');
assert.equal(subjectRelationForDispatch('aggregate'), 'consultation_parent');
assert.equal(evaluateRequiredSubjects(planned.contract, new Map([['root:a', 'completed'], ['root:b', 'active']])).status, 'active');
assert.equal(evaluateRequiredSubjects(planned.contract, new Map([['root:a', 'completed'], ['root:b', 'failed']])).status, 'needs_attention');
assert.equal(evaluateRequiredSubjects(planned.contract, new Map([['root:a', 'completed'], ['root:b', 'completed']])).status, 'completed');
console.log('Runtime Subject 与并行完成契约验证通过');
