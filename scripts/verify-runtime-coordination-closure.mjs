import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-runtime-coordination-closure-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COORDINATION_RUNTIME_KERNEL = 'execute';
process.env.COORDINATION_RUNTIME_PROTOCOLS = 'single_agent';

const db = await import('../apps/server/src/db/database.ts');
const adapter = await import('../apps/server/src/runtime/coordinationAdapter.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');
const candidates = await import('../apps/server/src/runtime/subjectCompletion.ts');

function insertRun(id) {
  const now = new Date().toISOString();
  db.run(`INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES (?,?,'collaboration','running','["a"]',?)`, id, id, now);
}

function plan(runId, id, protocol = 'single_agent') {
  const now = new Date().toISOString();
  return {
    id, runId, draftId: `draft-${id}`, capabilitySnapshotId: 'snapshot', revision: 1, status: 'validated',
    protocols: [{ protocol, version: 1 }], protocolComposition: [{ protocol, version: 1 }], templateExpansions: [],
    runtimeMode: 'collaboration', actorBindings: { worker: 'a' }, hardConstraintBindings: [],
    steps: [
      { id: 'work', protocol, type: 'agent_turn', actorRole: 'worker', actorCapability: 'execute', agentId: 'a',
        dependsOn: [], completion: '完成', maxAttempts: 2, tokenBudget: 1000, timeoutMs: 1000, onFailure: 'retry',
        toolPolicy: { allowedTools: [], requiresApproval: false }, metadata: {} },
      { id: 'complete', protocol, type: 'completion_gate', actorRole: 'completion', actorCapability: 'coordinate', agentId: null,
        dependsOn: ['work'], completion: '终局', maxAttempts: 1, tokenBudget: 1000, timeoutMs: 1000, onFailure: 'fail_plan',
        toolPolicy: { allowedTools: [], requiresApproval: false }, metadata: {} },
    ],
    completion: { requiredSteps: ['work', 'complete'], terminalSteps: ['complete'] },
    budget: { maximumSteps: 4, maximumAttemptsPerStep: 2, maximumTokensPerStep: 1000 },
    validationIssues: [], createdAt: now, updatedAt: now,
  };
}

function admit(value) {
  adapter.admitCoordinationKernelPlan(value);
  const now = new Date().toISOString();
  for (const step of value.steps) {
    db.run(`INSERT INTO coordination_step_states
      (plan_id,run_id,revision,step_id,status,attempt_no,output,error,started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,0,NULL,NULL,NULL,NULL,?)`, value.id, value.runId, value.revision, step.id,
    step.dependsOn.length === 0 ? 'ready' : 'pending', now);
  }
}

try {
  insertRun('run-accepted');
  const acceptedPlan = plan('run-accepted', 'plan-accepted');
  admit(acceptedPlan);
  const work = acceptedPlan.steps[0];
  const claimed = store.claimCoordinationStep(acceptedPlan, work, 'input');
  assert.ok(claimed);
  const committed = store.completeCoordinationStep(acceptedPlan, 'work', claimed.attempt.id, '可交付结果',
    { version: 2, type: 'complete', summary: '可交付结果' });
  assert.equal(committed.accepted, true);
  assert.equal(committed.state.status, 'completed');
  const storedAttempt = store.listCoordinationStepAttempts(acceptedPlan.id)[0];
  assert.equal(storedAttempt.controlAction.type, 'complete');
  assert.equal(storedAttempt.exitGuard.status, 'allow_candidate');
  assert.equal(candidates.listCompletionCandidates('run-accepted').length, 1);
  assert.equal(candidates.listCompletionCandidates('run-accepted')[0].status, 'accepted');
  assert.equal(adapter.finalizeCoordinationKernelPlan(acceptedPlan, store.listCoordinationStepStates(acceptedPlan.id)).status,
    'rejected', '终局 Gate 之前公共 Completion Engine 必须拒绝完成');

  store.prepareCoordinationReadySteps(acceptedPlan);
  const gate = store.claimCoordinationStep(acceptedPlan, acceptedPlan.steps[1], 'gate');
  assert.ok(gate);
  assert.equal(store.completeCoordinationStep(acceptedPlan, 'complete', gate.attempt.id, 'completion gate passed',
    { version: 2, type: 'complete', summary: 'completion gate passed' }).accepted, true);
  assert.equal(adapter.finalizeCoordinationKernelPlan(acceptedPlan, store.listCoordinationStepStates(acceptedPlan.id)).status,
    'accepted');
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_completion_candidates WHERE run_id=?', 'run-accepted').n, 1,
    '无 Subject 的 Completion Gate 不得生成第二个 Candidate');

  insertRun('run-held');
  const heldPlan = plan('run-held', 'plan-held');
  admit(heldPlan);
  const heldClaim = store.claimCoordinationStep(heldPlan, heldPlan.steps[0], 'input');
  assert.ok(heldClaim);
  const subjectId = db.get(`SELECT subject_id FROM runtime_coordination_subjects
    WHERE plan_id=? AND revision=1 AND step_id='work'`, heldPlan.id).subject_id;
  holds.createDurableHold({ runId: heldPlan.runId, subjectId, sourceAttemptId: heldClaim.attempt.id,
    holderAgentId: 'a', condition: { kind: 'event', eventKey: 'fixture:event' },
    recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: 'fixture:held' });
  const rejected = store.completeCoordinationStep(heldPlan, 'work', heldClaim.attempt.id, '被等待阻断的结果',
    { version: 2, type: 'complete', summary: '被等待阻断的结果' });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.state.status, 'ready');
  assert.deepEqual(candidates.listCompletionCandidates('run-held')[0].reasons, ['OPEN_HOLD_OR_TRANSFER']);

  insertRun('run-shadow');
  const shadowPlan = plan('run-shadow', 'plan-shadow', 'debate');
  adapter.admitCoordinationKernelPlan(shadowPlan);
  assert.equal(adapter.getCoordinationKernelStatus('run-shadow').mode, 'shadow');
  const shadowContract = JSON.parse(db.get('SELECT payload FROM runtime_contracts WHERE run_id=?', 'run-shadow').payload);
  assert.equal(shadowContract.features.completionCandidateVersion, undefined,
    '尚未进入 allowlist 的协议必须保留冻结 Run 的兼容路径');

  console.log('Coordination Stage 7 的规范动作、ExitGuard、Candidate、Hold 门禁与公共终局验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
