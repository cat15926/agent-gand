import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-default-takeover-'));
const dbPath = path.join(root, 'test.sqlite');
process.env.DB_PATH = dbPath;

const db = await import('../apps/server/src/db/database.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { executionPolicyForProfile } = await import('../apps/server/src/runtime/runPolicy.ts');
const {
  classifyRuntimeShadowComparison,
  listRuntimeShadowComparisons,
  recordRuntimeShadowComparison,
} = await import('../apps/server/src/runtime/shadowComparison.ts');

function contract(runId, profile) {
  const executionPolicy = executionPolicyForProfile(profile);
  return planCollaborationAdmission({
    runId,
    objective: `mixed-version:${profile}`,
    participantIds: ['agent-a'],
    targetAgentIds: ['agent-a'],
    executionPolicy,
    completionEngine: executionPolicy.authority === 'runtime',
    controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
    ...(executionPolicy.runtimeStateMode !== 'off' ? {
      completionCandidateVersion: 1,
      successorObligationVersion: 1,
      evidenceBundleVersion: 1,
      evidenceLoopGuardVersion: 1,
      contextContributorVersion: 1,
      durableHoldVersion: 2,
    } : {}),
  }).contract;
}

function inspectWithWorker(admissionMode) {
  const loader = path.resolve('apps/server/node_modules/tsx/dist/loader.mjs');
  const configUrl = pathToFileURL(path.resolve('apps/server/src/config.ts')).href;
  const policyUrl = pathToFileURL(path.resolve('apps/server/src/runtime/runPolicy.ts')).href;
  const databaseUrl = pathToFileURL(path.resolve('apps/server/src/db/database.ts')).href;
  const code = `
    const { config } = await import(${JSON.stringify(configUrl)});
    const { resolveRunPolicy } = await import(${JSON.stringify(policyUrl)});
    const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
    const result = {
      admission: config.collaboration.runtimeAdmissionProfile,
      frozen: Object.fromEntries(${JSON.stringify(['legacy', 'shadow', 'atomic_compat', 'execute'])}.map((profile) =>
        [profile, resolveRunPolicy('mixed-' + profile).profile])),
    };
    closeDatabase();
    process.stdout.write(JSON.stringify(result));
  `;
  const env = { ...process.env, DB_PATH: dbPath };
  for (const key of ['COLLAB_RUNTIME_MODE', 'COLLAB_RUNTIME_SHADOW', 'COLLAB_RUNTIME_ATOMIC', 'COLLAB_COMPLETION_ENGINE']) delete env[key];
  if (admissionMode) env.COLLAB_RUNTIME_MODE = admissionMode;
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', code], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function count(table) {
  return db.get(`SELECT COUNT(*) n FROM ${table}`).n;
}

try {
  for (const profile of ['legacy', 'shadow', 'atomic_compat', 'execute']) {
    freezeRuntimeContract(contract(`mixed-${profile}`, profile));
  }

  const defaultWorker = inspectWithWorker();
  assert.equal(defaultWorker.admission, 'execute', '没有显式配置时，新 Run 必须默认 execute');
  assert.deepEqual(defaultWorker.frozen, {
    legacy: 'legacy', shadow: 'shadow', atomic_compat: 'atomic_compat', execute: 'execute',
  }, '混合版本 worker 必须服从每个 Run 的冻结策略');

  const rollbackWorker = inspectWithWorker('legacy');
  assert.equal(rollbackWorker.admission, 'legacy', '显式回退只改变新 Run 入场');
  assert.deepEqual(rollbackWorker.frozen, defaultWorker.frozen,
    '回退进程不得把存量 execute/shadow/atomic Run 改写为 legacy');

  const accepted = { status: 'accepted', reasons: [], retryable: false, feedback: null };
  assert.equal(classifyRuntimeShadowComparison({ legacyOutcome: 'applied', actionType: 'complete',
    observation: { ok: true, error: null }, runtimeEvaluation: accepted }).classification, 'match');
  assert.equal(classifyRuntimeShadowComparison({ legacyOutcome: 'applied', actionType: 'complete',
    observation: { ok: true, error: null }, runtimeEvaluation: {
      status: 'rejected', reasons: ['REQUIRED_OBLIGATION_PENDING'], retryable: true, feedback: '等待后继工作',
    } }).classification, 'runtime_stricter');
  assert.equal(classifyRuntimeShadowComparison({ legacyOutcome: 'blocked', actionType: 'complete',
    observation: { ok: true, error: null }, runtimeEvaluation: accepted }).classification, 'runtime_looser');
  assert.equal(classifyRuntimeShadowComparison({ legacyOutcome: 'applied', actionType: 'handoff',
    observation: { ok: true, error: null }, runtimeEvaluation: null }).classification, 'projection_only');
  assert.equal(classifyRuntimeShadowComparison({ legacyOutcome: 'applied', actionType: 'complete',
    observation: { ok: false, error: 'fault injection' }, runtimeEvaluation: null }).classification, 'observer_error');

  const snapshot = {
    runId: 'mixed-shadow', contractRevision: null, subjectId: 'subject-1', subjectKey: 'root:agent-a',
    subjectStatus: 'active',
    custody: { state: 'owned', holderAgentId: 'agent-a', pendingHolderAgentId: null, generation: 3, rowVersion: 3 },
    attempt: { id: 'attempt-1', actorId: 'agent-a', generation: 3, status: 'completed', leaseValid: true },
    requiredObligations: [], openHoldIds: [], completionBlockers: [],
  };
  const untouchedBefore = Object.fromEntries(['collaboration_dispatches', 'messages', 'tool_executions']
    .map((table) => [table, count(table)]));
  const first = recordRuntimeShadowComparison({
    runId: 'mixed-shadow', dispatchId: 'dispatch-1', attemptId: 'attempt-1', actionType: 'complete',
    legacyOutcome: 'applied', output: 'same generated output', responsibilitySnapshot: snapshot,
    observation: { ok: true, error: null }, runtimeEvaluation: accepted,
  });
  const replay = recordRuntimeShadowComparison({
    runId: 'mixed-shadow', dispatchId: 'dispatch-1', attemptId: 'attempt-1', actionType: 'complete',
    legacyOutcome: 'applied', output: 'same generated output', responsibilitySnapshot: snapshot,
    observation: { ok: true, error: null }, runtimeEvaluation: accepted,
  });
  assert.equal(replay.id, first.id);
  assert.equal(listRuntimeShadowComparisons('mixed-shadow').length, 1);
  assert.equal(first.classification, 'match');
  assert.equal(first.generation, 3);
  assert.match(first.outputSha256, /^[a-f0-9]{64}$/u);
  assert.match(first.snapshotFingerprint ?? '', /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.fromEntries(['collaboration_dispatches', 'messages', 'tool_executions']
    .map((table) => [table, count(table)])), untouchedBefore,
  'Shadow Comparison 只能写审计账本，不能创建 Dispatch、消息或工具执行');

  console.log('Collaboration 默认 execute、混合版本冻结、回退隔离与 Shadow 纯对比验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
