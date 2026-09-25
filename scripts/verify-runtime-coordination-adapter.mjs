import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-coordination-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COORDINATION_RUNTIME_KERNEL = 'execute';
process.env.COORDINATION_RUNTIME_PROTOCOLS = 'single_agent';

const db = await import('../apps/server/src/db/database.ts');
const adapter = await import('../apps/server/src/runtime/coordinationAdapter.ts');

function insertRun(id) {
  const now = new Date().toISOString();
  db.run(`INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES (?,?,'collaboration','running','["a"]',?)`, id, id, now);
}

function plan(runId, id, revision, protocol = 'single_agent') {
  const stepId = revision === 1 ? 'work-v1' : 'work-v2';
  const now = new Date().toISOString();
  return {
    id, runId, draftId: `draft-${id}-${revision}`, capabilitySnapshotId: 'snapshot', revision, status: 'validated',
    protocols: [{ protocol, version: 1 }], protocolComposition: [{ protocol, version: 1 }], templateExpansions: [],
    runtimeMode: 'collaboration', actorBindings: { worker: 'a' }, hardConstraintBindings: [],
    steps: [
      { id: stepId, protocol, type: 'agent_turn', actorRole: 'worker', actorCapability: 'execute', agentId: 'a',
        dependsOn: [], completion: '完成', maxAttempts: 2, tokenBudget: 1000, timeoutMs: 1000, onFailure: 'retry',
        toolPolicy: { allowedTools: [], requiresApproval: false }, metadata: {} },
      { id: 'complete', protocol, type: 'completion_gate', actorRole: 'completion', actorCapability: 'coordinate', agentId: null,
        dependsOn: [stepId], completion: '终局', maxAttempts: 1, tokenBudget: 1000, timeoutMs: 1000, onFailure: 'fail_plan',
        toolPolicy: { allowedTools: [], requiresApproval: false }, metadata: {} },
    ],
    completion: { requiredSteps: [stepId, 'complete'], terminalSteps: ['complete'] },
    budget: { maximumSteps: 4, maximumAttemptsPerStep: 2, maximumTokensPerStep: 1000 },
    validationIssues: [], createdAt: now, updatedAt: now,
  };
}

try {
  insertRun('run-execute');
  const initial = plan('run-execute', 'plan-execute', 1);
  db.tx(() => adapter.admitCoordinationKernelPlan(initial));
  assert.equal(adapter.getCoordinationKernelStatus('run-execute').mode, 'execute');
  assert.equal(adapter.getCoordinationKernelStatus('run-execute').subjects[0].stepId, 'work-v1');

  const revised = plan('run-execute', 'plan-execute', 2);
  db.tx(() => adapter.admitCoordinationKernelPlan(revised));
  const current = adapter.getCoordinationKernelStatus('run-execute');
  assert.equal(current.runtimeRevision, 2);
  assert.equal(current.subjects[0].stepId, 'work-v2');
  assert.equal(db.get("SELECT c.state FROM runtime_coordination_subjects m JOIN runtime_custody c ON c.subject_id=m.subject_id WHERE m.plan_id=? AND m.revision=1", 'plan-execute').state, 'cancelled');
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_contract_revisions WHERE run_id=?', 'run-execute').n, 2);

  adapter.closeCoordinationKernelPlan(revised, [{ planId: revised.id, runId: revised.runId, revision: 2, stepId: 'work-v2',
    status: 'ready', attemptNo: 0, output: null, error: null, startedAt: null, completedAt: null, updatedAt: revised.updatedAt }], true);
  assert.equal(adapter.getCoordinationKernelStatus('run-execute').subjects[0].custodyState, 'cancelled');
  assert.throws(() => adapter.observeCoordinationClaim(revised, revised.steps[0], 'late-attempt'),
    /非法责任迁移/, '终态 Subject 不得被迟到 claim 重新打开');

  insertRun('run-retry');
  const retrying = plan('run-retry', 'plan-retry', 1);
  db.tx(() => adapter.admitCoordinationKernelPlan(retrying));
  adapter.observeCoordinationClaim(retrying, retrying.steps[0], 'attempt-1');
  adapter.observeCoordinationFailure(retrying, retrying.steps[0], 'attempt-1', true);
  assert.equal(adapter.getCoordinationKernelStatus('run-retry').subjects[0].custodyState, 'waiting');
  adapter.observeCoordinationClaim(retrying, retrying.steps[0], 'attempt-2');
  assert.equal(adapter.getCoordinationKernelStatus('run-retry').subjects[0].custodyState, 'owned');
  adapter.observeCoordinationPause(retrying, retrying.steps[0], 'attempt-2');
  adapter.observeCoordinationClaim(retrying, retrying.steps[0], 'attempt-2');
  assert.equal(adapter.getCoordinationKernelStatus('run-retry').subjects[0].custodyState, 'owned',
    '暂停恢复复用同一 Attempt 时必须重新取得责任');

  insertRun('run-shadow');
  const unlisted = plan('run-shadow', 'plan-shadow', 1, 'debate');
  db.tx(() => adapter.admitCoordinationKernelPlan(unlisted));
  assert.equal(adapter.getCoordinationKernelStatus('run-shadow').mode, 'shadow', '未放量协议必须自动降为 Shadow');
  console.log('Coordination Step Adapter、Revision、关闭语义与协议灰度验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
