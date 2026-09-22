import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-planner-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
process.env.DB_PATH = path.join(root, 'planner.sqlite');
process.env.AGENTS_DIR = agentsDir;
process.env.COORDINATION_PLANNER_MODEL = 'mock:coordination-planner';
process.env.COORDINATION_PLANNER_MAX_ATTEMPTS = '2';

function agent(name, capabilities, model = 'mock:agent') {
  return `---\nname: ${name}\ndescription: ${name} planner fixture\nmodel: ${model}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${name} fixture`;
}

await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent('Planner', ['coordinate', 'execute'], 'mock:planner')),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent('Coder', ['execute'], 'mock:coder')),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agent('Reviewer', ['review'], 'mock:reviewer')),
]);

const registry = await import('../apps/server/src/agents/registry.ts');
const { previewCoordination } = await import('../apps/server/src/coordination/service.ts');
const { getCoordinationDraft, listCoordinationEvents } = await import('../apps/server/src/coordination/store.ts');
registry.syncFromFiles();

const modeled = await previewCoordination({
  goal: '请把登录问题处理到可交付状态 [model:review]',
  agentIds: ['coder', 'reviewer'],
  defaultReviewerId: 'reviewer',
});
assert.deepEqual(modeled.draft.protocols.map((item) => item.protocol), ['review_revision']);
assert.equal(modeled.draft.planning.source, 'model');
assert.equal(modeled.draft.planning.model, 'mock:coordination-planner');
assert.equal(modeled.draft.planning.attempts, 1);
assert.ok(modeled.draft.planning.tokensIn > 0 && modeled.draft.planning.tokensOut > 0);
assert.equal(modeled.draft.modelConfidence, 0.94);
assert.equal(modeled.draft.decision, 'auto_start');
assert.deepEqual(modeled.draft.validationErrors, []);

const repaired = await previewCoordination({
  goal: '实现支付修复并交给 Reviewer 审查 [planner-invalid-once]',
  agentIds: ['coder', 'reviewer'],
  defaultReviewerId: 'reviewer',
});
assert.equal(repaired.draft.planning.source, 'model_repaired');
assert.equal(repaired.draft.planning.attempts, 2);
assert.deepEqual(repaired.draft.protocols.map((item) => item.protocol), ['review_revision']);
assert.deepEqual(repaired.draft.validationErrors, []);

const fallback = await previewCoordination({
  goal: '实现缓存修复并审查，有问题继续修改 [planner-fail]',
  agentIds: ['coder', 'reviewer'],
  defaultReviewerId: 'reviewer',
});
assert.equal(fallback.draft.planning.source, 'deterministic_fallback');
assert.equal(fallback.draft.planning.attempts, 2);
assert.ok(fallback.draft.planning.fallbackReason?.includes('mock planner unavailable'));
assert.deepEqual(fallback.draft.protocols.map((item) => item.protocol), ['review_revision']);
assert.ok(fallback.notices?.some((item) => item.includes('安全回退')));

const explicit = await previewCoordination({
  goal: '请讨论方案',
  agentIds: ['planner', 'coder'],
  requestedProtocol: 'parallel_fanout',
});
assert.equal(explicit.draft.planning.source, 'deterministic');
assert.equal(explicit.draft.planning.model, null);
assert.deepEqual(explicit.draft.protocols.map((item) => item.protocol), ['parallel_fanout']);

const risky = await previewCoordination({ goal: '发布并部署新版本', agentIds: ['coder'] });
assert.equal(risky.draft.risk, 'high');
assert.equal(risky.draft.decision, 'recommend');

const clarify = await previewCoordination({ goal: '比较两个认证方案 [model:clarify]', agentIds: ['planner', 'coder'] });
assert.equal(clarify.draft.decision, 'clarify');
assert.equal(clarify.draft.taskBrief.missingInformation.length, 1);
assert.ok(clarify.draft.clarificationQuestion);

const stored = getCoordinationDraft(modeled.draft.id);
assert.equal(stored?.planning.source, 'model');
const draftCreated = listCoordinationEvents({ draftId: modeled.draft.id }).find((event) => event.kind === 'draft_created');
assert.equal(draftCreated?.payload.planning?.source, 'model');

console.log('coordination planner verification passed: model proposal, repair, fallback, explicit override, risk confirmation, clarification, audit');
