import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-review-obligations-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COORDINATION_RUNTIME_KERNEL = 'execute';
process.env.COORDINATION_RUNTIME_PROTOCOLS = 'single_agent,review_revision';

const db = await import('../apps/server/src/db/database.ts');
const adapter = await import('../apps/server/src/runtime/coordinationAdapter.ts');
const { listSuccessorObligations } = await import('../apps/server/src/runtime/obligations.ts');
const { workspaceRootDir } = await import('../apps/server/src/tools/builtin/index.ts');
const workspaceDirs = [];

function insertRun(id, agents = ['a', 'reviewer']) {
  const now = new Date().toISOString();
  db.run(`INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES (?,?,'collaboration','running',?,?)`,
    id, id, JSON.stringify(agents), now);
}

function step(id, protocol, type, agentId, dependsOn = [], metadata = {}, expectedArtifacts) {
  return { id, protocol, type, actorRole: type, actorCapability: type === 'review' ? 'review' : 'execute', agentId,
    dependsOn, completion: `${id} 完成`, maxAttempts: 3, tokenBudget: 1000, timeoutMs: 1000,
    onFailure: 'retry', toolPolicy: { allowedTools: [], requiresApproval: false }, metadata,
    ...(expectedArtifacts ? { expectedArtifacts } : {}) };
}

function plan(runId, id, protocol, steps, terminalSteps) {
  const now = new Date().toISOString();
  return { id, runId, draftId: `draft-${id}`, capabilitySnapshotId: 'snapshot', revision: 1, status: 'validated',
    protocols: [{ protocol, version: 1 }], protocolComposition: [{ protocol, version: 1 }], templateExpansions: [],
    runtimeMode: 'collaboration', actorBindings: {}, hardConstraintBindings: [], steps,
    completion: { requiredSteps: steps.map((item) => item.id), terminalSteps },
    budget: { maximumSteps: 8, maximumAttemptsPerStep: 3, maximumTokensPerStep: 1000 },
    validationIssues: [], createdAt: now, updatedAt: now };
}

function completeAttempt(runId, planId, stepId, attemptId, attemptNo, output) {
  const now = new Date().toISOString();
  db.run(`INSERT INTO coordination_step_attempts
    (id,plan_id,run_id,revision,step_id,attempt_no,status,idempotency_key,input,output,error,span_id,created_at,started_at,ended_at)
    VALUES (?,?,?,?,?,?,'completed',?,NULL,?,NULL,NULL,?,?,?)`, attemptId, planId, runId, 1, stepId, attemptNo,
  `test:${attemptId}`, output, now, now, now);
}

try {
  insertRun('run-review');
  const implement = step('implement', 'review_revision', 'agent_turn', 'a');
  const review = step('review', 'review_revision', 'review', 'reviewer', ['implement'], { reviewTargetStepIds: ['implement'] });
  const reviewPlan = plan('run-review', 'plan-review', 'review_revision', [implement, review], ['review']);
  db.tx(() => adapter.admitCoordinationKernelPlan(reviewPlan));

  adapter.observeCoordinationClaim(reviewPlan, implement, 'impl-1');
  completeAttempt(reviewPlan.runId, reviewPlan.id, implement.id, 'impl-1', 1, '第一版实现');
  adapter.observeCoordinationComplete(reviewPlan, implement, 'impl-1');
  adapter.observeCoordinationClaim(reviewPlan, review, 'review-1');
  completeAttempt(reviewPlan.runId, reviewPlan.id, review.id, 'review-1', 1, 'FAIL 1');
  adapter.observeCoordinationRevision(reviewPlan, review, 'review-1', ['implement']);
  assert.deepEqual(listSuccessorObligations(reviewPlan.runId).map((item) => [item.kind, item.generation, item.status]),
    [['review_revision', 1, 'open']]);

  adapter.observeCoordinationClaim(reviewPlan, implement, 'impl-2');
  completeAttempt(reviewPlan.runId, reviewPlan.id, implement.id, 'impl-2', 2, '第二版实现');
  adapter.observeCoordinationComplete(reviewPlan, implement, 'impl-2');
  adapter.observeCoordinationClaim(reviewPlan, review, 'review-2');
  completeAttempt(reviewPlan.runId, reviewPlan.id, review.id, 'review-2', 2, 'FAIL 2');
  adapter.observeCoordinationRevision(reviewPlan, review, 'review-2', ['implement']);
  assert.deepEqual(listSuccessorObligations(reviewPlan.runId).map((item) => [item.generation, item.status]),
    [[1, 'cancelled'], [2, 'open']], '新一轮 FAIL 必须推进 obligation generation');

  adapter.observeCoordinationClaim(reviewPlan, implement, 'impl-3');
  completeAttempt(reviewPlan.runId, reviewPlan.id, implement.id, 'impl-3', 3, '第三版实现');
  adapter.observeCoordinationComplete(reviewPlan, implement, 'impl-3');
  adapter.observeCoordinationClaim(reviewPlan, review, 'review-3');
  completeAttempt(reviewPlan.runId, reviewPlan.id, review.id, 'review-3', 3, 'PASS');
  assert.throws(() => adapter.observeCoordinationComplete(reviewPlan, review, 'review-2'),
    /失去当前责任代际/u, '旧 Reviewer PASS 不得关闭新一轮义务');
  adapter.observeCoordinationComplete(reviewPlan, review, 'review-3');
  assert.equal(listSuccessorObligations(reviewPlan.runId).at(-1)?.status, 'satisfied');

  insertRun('run-artifact', ['a']);
  const artifactStep = step('artifact', 'single_agent', 'agent_turn', 'a', [], {}, ['proof.md']);
  const artifactPlan = plan('run-artifact', 'plan-artifact', 'single_agent', [artifactStep], ['artifact']);
  db.tx(() => adapter.admitCoordinationKernelPlan(artifactPlan));
  assert.equal(listSuccessorObligations(artifactPlan.runId)[0]?.kind, 'artifact_commit');
  adapter.observeCoordinationClaim(artifactPlan, artifactStep, 'artifact-1');
  const workspace = workspaceRootDir({ runId: artifactPlan.runId }); workspaceDirs.push(workspace);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'proof.md'), '这是已经冻结并可验证的完整产物内容。');
  completeAttempt(artifactPlan.runId, artifactPlan.id, artifactStep.id, 'artifact-1', 1, '产物已完成');
  adapter.observeCoordinationComplete(artifactPlan, artifactStep, 'artifact-1');
  assert.equal(listSuccessorObligations(artifactPlan.runId)[0]?.status, 'satisfied');

  console.log('Review Revision generation、迟到 PASS 与 Artifact Commit 义务验证通过');
} finally {
  db.closeDatabase();
  for (const dir of workspaceDirs) await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
