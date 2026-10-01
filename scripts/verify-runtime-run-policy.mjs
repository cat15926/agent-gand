import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-run-policy-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const actions = await import('../apps/server/src/runtime/controlAction.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const {
  RuntimePolicyError,
  assertExecutableCollaborationPolicy,
  executionPolicyForProfile,
  loadRuntimeContract,
  resolveRunPolicy,
} = await import('../apps/server/src/runtime/runPolicy.ts');

function contract(runId, profile) {
  const executionPolicy = executionPolicyForProfile(profile);
  return planCollaborationAdmission({
    runId,
    objective: `policy:${profile}`,
    participantIds: ['a'],
    targetAgentIds: ['a'],
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
      durableHoldVersion: 1,
    } : {}),
  }).contract;
}

function insertRawContract(runId, payload) {
  db.run('INSERT INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)',
    runId, 1, typeof payload === 'string' ? payload : JSON.stringify(payload), new Date().toISOString());
}

function baseHistorical(runId, features) {
  return {
    version: 1,
    runId,
    objective: runId,
    participantIds: ['a'],
    requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required',
    partialFailurePolicy: 'needs_attention',
    features,
  };
}

function configProfile(env, expectFailure = false) {
  const loader = path.resolve('apps/server/node_modules/tsx/dist/loader.mjs');
  const configUrl = pathToFileURL(path.resolve('apps/server/src/config.ts')).href;
  const code = `const { config } = await import(${JSON.stringify(configUrl)}); process.stdout.write(config.collaboration.runtimeAdmissionProfile);`;
  const clean = { ...process.env };
  for (const key of ['COLLAB_RUNTIME_MODE', 'COLLAB_RUNTIME_SHADOW', 'COLLAB_RUNTIME_ATOMIC', 'COLLAB_COMPLETION_ENGINE']) delete clean[key];
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '--eval', code], {
    cwd: process.cwd(), env: { ...clean, ...env }, encoding: 'utf8', timeout: 10_000,
  });
  if (expectFailure) { assert.notEqual(result.status, 0); return result.stderr; }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  for (const profile of ['legacy', 'shadow', 'atomic_compat', 'execute']) {
    actions.freezeRuntimeContract(contract(`run-${profile}`, profile));
    assert.deepEqual(resolveRunPolicy(`run-${profile}`), executionPolicyForProfile(profile));
  }
  const v1Execute = contract('run-v1-execute', 'execute');
  v1Execute.executionPolicy = executionPolicyForProfile('execute', { toolApiVersion: 1 });
  actions.freezeRuntimeContract(v1Execute);
  assert.equal(resolveRunPolicy('run-v1-execute').toolApiVersion, 1, '历史 Tool API v1 保留只读解释');
  assert.throws(() => assertExecutableCollaborationPolicy('run-v1-execute'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_POLICY_RETIRED');

  process.env.COLLAB_RUNTIME_MODE = 'legacy';
  assert.equal(resolveRunPolicy('run-execute').profile, 'execute', '环境变化不得改写已冻结 execute Run');
  process.env.COLLAB_RUNTIME_MODE = 'execute';
  assert.equal(resolveRunPolicy('run-legacy').profile, 'legacy', '新默认不得升级历史 legacy Run');

  assert.equal(resolveRunPolicy('historical-without-contract').profile, 'legacy');
  insertRawContract('historical-execute', baseHistorical('historical-execute', {
    completionEngine: true, controlActionVersion: 2, completionCandidateVersion: 1,
  }));
  assert.equal(resolveRunPolicy('historical-execute').profile, 'execute');
  insertRawContract('historical-coordination-shadow', baseHistorical('historical-coordination-shadow', {
    coordinationKernel: 'shadow', controlActionVersion: 2,
  }));
  assert.equal(resolveRunPolicy('historical-coordination-shadow').profile, 'shadow');

  insertRawContract('historical-ambiguous', baseHistorical('historical-ambiguous', {
    controlActionVersion: 2, successorObligationVersion: 1, durableHoldVersion: 1,
  }));
  assert.throws(() => resolveRunPolicy('historical-ambiguous'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_POLICY_AMBIGUOUS_HISTORY');
  insertRawContract('corrupt-contract', '{not-json');
  assert.throws(() => loadRuntimeContract('corrupt-contract'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_CONTRACT_CORRUPT');
  insertRawContract('corrupt-contract-shape', 'null');
  assert.throws(() => loadRuntimeContract('corrupt-contract-shape'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_CONTRACT_CORRUPT');
  insertRawContract('incomplete-execute', {
    ...baseHistorical('incomplete-execute', { completionEngine: true, controlActionVersion: 2 }),
    executionPolicy: executionPolicyForProfile('execute'),
  });
  assert.throws(() => resolveRunPolicy('incomplete-execute'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_POLICY_INVALID');
  insertRawContract('unknown-policy', {
    ...baseHistorical('unknown-policy', { controlActionVersion: 2 }),
    executionPolicy: { ...executionPolicyForProfile('execute'), policyVersion: 99 },
  });
  assert.throws(() => resolveRunPolicy('unknown-policy'),
    (error) => error instanceof RuntimePolicyError && error.code === 'RUNTIME_POLICY_UNKNOWN_VERSION');

  const now = new Date().toISOString();
  db.run('INSERT INTO conversations (id,title,mode,agent_ids,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    'ambiguous-room', 'ambiguous', 'collaboration', '["a"]', now, now);
  db.run('INSERT INTO runs (id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES (?,?,?,?,?,?,?,?)',
    'historical-ambiguous', 'ambiguous', 'collaboration', 'ambiguous-room', 1, 'running', '["a"]', now);
  const dispatch = store.createDispatch({ runId: 'historical-ambiguous', conversationId: 'ambiguous-room',
    sourceMessageId: 'source', kind: 'initial', from: 'user', targetAgentId: 'a', depth: 0,
    idempotencyKey: 'ambiguous:initial' });
  assert.equal(store.claimNextDispatch('ambiguous-room', 'worker'), null);
  assert.equal(store.getDispatch(dispatch.id)?.status, 'blocked');
  assert.match(store.getDispatch(dispatch.id)?.error ?? '', /RUNTIME_POLICY_AMBIGUOUS_HISTORY/u);

  assert.equal(configProfile({}), 'execute');
  assert.match(configProfile({ COLLAB_RUNTIME_SHADOW: 'true' }, true), /已弃用/u);
  assert.match(configProfile({ COLLAB_RUNTIME_ATOMIC: 'true' }, true), /已弃用/u);
  assert.equal(configProfile({ COLLAB_COMPLETION_ENGINE: 'true' }), 'execute');
  assert.match(configProfile({ COLLAB_RUNTIME_MODE: 'shadow' }, true), /仅支持 execute/u);

  const forbidden = /config\.collaboration\.(?:runtimeAtomic|runtimeShadow|completionEngine)/u;
  for (const file of [
    'apps/server/src/collaboration/scheduler.ts',
    'apps/server/src/collaboration/store.ts',
    'apps/server/src/collaboration/decisions.ts',
    'apps/server/src/runs/recovery.ts',
  ]) {
    assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, `${file} 不得在执行阶段读取旧语义开关`);
  }

  console.log('Runtime 冻结策略、历史只读解释、退役执行阻断与 execute 独占入场验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
