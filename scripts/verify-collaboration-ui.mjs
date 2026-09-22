import assert from 'node:assert/strict';
import { canStopCollaborationRun, collaborationAttemptTone, collaborationBatchProgress } from '../apps/web/src/collaborationView.ts';

const batch = { id: 'batch', targetAgentIds: ['a', 'b', 'c'] };
const dispatches = [
  { id: '1', batchId: 'batch', kind: 'fanout', status: 'completed' },
  { id: '2', batchId: 'batch', kind: 'fanout', status: 'blocked' },
  { id: '3', batchId: 'batch', kind: 'fanout', status: 'running' },
];
assert.deepEqual(collaborationBatchProgress(batch, dispatches), { terminal: 2, total: 3, percent: 67 });
assert.equal(collaborationAttemptTone({ status: 'completed' }), 'success');
assert.equal(collaborationAttemptTone({ status: 'running' }), 'active');
assert.equal(collaborationAttemptTone({ status: 'failed' }), 'danger');
assert.equal(collaborationAttemptTone({ status: 'interrupted' }), 'muted');
assert.equal(canStopCollaborationRun({ mode: 'collaboration', status: 'running' }), true);
assert.equal(canStopCollaborationRun({ mode: 'collaboration', status: 'waiting_for_user' }), true);
assert.equal(canStopCollaborationRun({ mode: 'collaboration', status: 'completed' }), false);
assert.equal(canStopCollaborationRun({ mode: 'pipeline', status: 'running' }), false);
console.log('collaboration UI view-model verification passed: batch, attempt, run stop');
