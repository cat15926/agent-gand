import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-compat-retirement-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');
process.env.COLLAB_RUNTIME_MODE = 'execute';

const db = await import('../apps/server/src/db/database.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { inspectRuntimeCompatibilityInventory } = await import('../apps/server/src/runtime/compatibility.ts');
const { executionPolicyForProfile } = await import('../apps/server/src/runtime/runPolicy.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');

const now = new Date().toISOString();
function addRun(status, withContract = false) {
  const id = randomUUID();
  db.run('INSERT INTO runs (id,goal,mode,status,agent_ids,created_at) VALUES (?,?,?,?,?,?)',
    id, id, 'collaboration', status, '["a"]', now);
  if (withContract) {
    freezeRuntimeContract(planCollaborationAdmission({ runId: id, objective: id, participantIds: ['a'], targetAgentIds: ['a'],
      executionPolicy: executionPolicyForProfile('execute'), completionEngine: true, controlActionVersion: 2,
      exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 }, completionCandidateVersion: 1,
      successorObligationVersion: 1, evidenceBundleVersion: 1, evidenceLoopGuardVersion: 1,
      contextContributorVersion: 1, durableHoldVersion: 2, progressDigestVersion: 1 }).contract);
  }
  return id;
}

try {
  const legacy = addRun('waiting_for_user');
  const corrupt = addRun('running');
  db.run('INSERT INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)', corrupt, 1, '{bad-json', now);
  addRun('running', true);
  addRun('completed');
  db.run(`INSERT INTO run_checkpoints (id,run_id,seq,kind,status,phase,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), legacy, 1, 'agent_turn', 'waiting', 'tool_calls_ready',
  JSON.stringify({ toolCalls: [{ name: 'agent.ask_many' }] }), now, now);
  const blocked = inspectRuntimeCompatibilityInventory();
  assert.equal(blocked.readyForCompatibilityRemoval, false);
  assert.equal(blocked.activeProfiles.unknown, 2);
  assert.equal(blocked.activeProfiles.execute, 1);
  assert.equal(blocked.legacyAliasCheckpointCount, 1);
  assert.ok(blocked.blockers.some((item) => item.kind === 'missing_contract'));
  assert.ok(blocked.blockers.some((item) => item.runId === corrupt && item.kind === 'ambiguous_or_invalid_policy'));
  assert.ok(blocked.blockers.some((item) => item.kind === 'legacy_alias_checkpoint'));

  db.run("UPDATE runs SET status='cancelled',finished_at=? WHERE id=?", now, legacy);
  db.run("UPDATE runs SET status='failed',finished_at=? WHERE id=?", now, corrupt);
  const ready = inspectRuntimeCompatibilityInventory();
  assert.equal(ready.readyForCompatibilityRemoval, true);
  assert.equal(ready.legacyAliasCheckpointCount, 0, '终态历史 checkpoint 只读保留，不应阻止执行分支清理');
  console.log('Runtime 兼容库存门禁、旧 Alias checkpoint 与终态历史读取隔离验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
