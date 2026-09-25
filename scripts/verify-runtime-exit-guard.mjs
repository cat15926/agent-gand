import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-exit-guard-'));
process.env.DB_PATH = path.join(root, 'test.sqlite');

const db = await import('../apps/server/src/db/database.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { evaluateExitGuard, runtimeExitGuardPolicy } = await import('../apps/server/src/runtime/exitGuard.ts');

const policy = { version: 1, maxCorrections: 1, correctionMaxTokens: 1024 };
const base = (overrides = {}) => ({
  stopReason: 'normal',
  action: { version: 2, type: 'answer_candidate' },
  output: '完整结果',
  hasActiveCustody: true,
  holderMatches: true,
  openSuccessorObligations: 0,
  allowImplicitAnswer: false,
  protocolRequiresExplicit: true,
  evidenceCount: 0,
  correctionAttempt: 0,
  correctionBudgetAvailable: true,
  policy,
  ...overrides,
});

try {
  assert.equal(evaluateExitGuard(base({ allowImplicitAnswer: true, protocolRequiresExplicit: false })).status,
    'allow_candidate', '简单直答保留隐式答案快路径');
  assert.equal(evaluateExitGuard(base()).status, 'continue_same_turn', '动态步骤遗漏显式处置时应同轮纠偏');
  assert.equal(evaluateExitGuard(base({ correctionAttempt: 1 })).status, 'needs_attention',
    '纠偏次数耗尽后不得伪装成功');
  assert.equal(evaluateExitGuard(base({ correctionBudgetAvailable: false })).status, 'needs_attention',
    '预算不足时不得继续生成纠偏调用');

  const complete = { version: 2, type: 'complete', summary: '最终摘要' };
  assert.equal(evaluateExitGuard(base({ action: complete, output: '最终摘要' })).status, 'allow_candidate');
  assert.equal(evaluateExitGuard(base({ action: { version: 2, type: 'complete' }, output: '' })).status,
    'continue_same_turn');
  assert.equal(evaluateExitGuard(base({ action: { version: 2, type: 'complete' }, output: '', correctionAttempt: 1 })).status,
    'fail_attempt');
  assert.equal(evaluateExitGuard(base({ action: complete, openSuccessorObligations: 2 })).status,
    'continue_same_turn');
  assert.equal(evaluateExitGuard(base({ action: complete, openSuccessorObligations: 2, correctionAttempt: 1 })).status,
    'needs_attention');

  assert.equal(evaluateExitGuard(base({ action: { version: 2, type: 'handoff', targetAgentId: 'b', objective: '继续', reason: '能力匹配' } })).status,
    'allow_candidate');
  assert.equal(evaluateExitGuard(base({ action: { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt: '继续吗？' }, reason: '需要决定' } })).status,
    'wait');
  assert.equal(evaluateExitGuard(base({ action: { version: 2, type: 'cancel', reason: '模型请求取消' } })).status,
    'needs_attention');

  assert.equal(evaluateExitGuard(base({ stopReason: 'truncated' })).status, 'fail_attempt');
  assert.equal(evaluateExitGuard(base({ stopReason: 'empty' })).status, 'fail_attempt');
  assert.equal(evaluateExitGuard(base({ stopReason: 'approval_wait' })).status, 'wait');
  assert.equal(evaluateExitGuard(base({ stopReason: 'cancelled' })).status, 'fail_attempt');
  assert.equal(evaluateExitGuard(base({ hasActiveCustody: false })).status, 'needs_attention');
  assert.equal(evaluateExitGuard(base({ holderMatches: false })).status, 'needs_attention');
  assert.equal(evaluateExitGuard(base({ action: null })).status, 'continue_same_turn');
  assert.equal(evaluateExitGuard(base({ action: null, correctionAttempt: 1 })).status, 'fail_attempt');

  assert.equal(runtimeExitGuardPolicy('historical-run'), null, '历史 Run 缺失冻结字段时继续旧语义');
  const contract = {
    version: 1,
    runId: 'stage-2-run',
    objective: '阶段 2',
    participantIds: ['a'],
    requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required',
    partialFailurePolicy: 'needs_attention',
    features: { controlActionVersion: 2, exitGuard: policy },
  };
  freezeRuntimeContract(contract);
  assert.deepEqual(runtimeExitGuardPolicy('stage-2-run'), policy);
  freezeRuntimeContract({ ...contract, features: { controlActionVersion: 2,
    exitGuard: { version: 1, maxCorrections: 3, correctionMaxTokens: 4096 } } });
  assert.deepEqual(runtimeExitGuardPolicy('stage-2-run'), policy, 'ExitGuard 策略必须按 Run 永久冻结');

  console.log('Runtime ExitGuard 决策矩阵、纠偏边界和 Run 策略冻结验证通过');
} finally {
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
