import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-planner-eval-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
process.env.DB_PATH = path.join(root, 'evaluation.sqlite');
process.env.AGENTS_DIR = agentsDir;
process.env.COORDINATION_PLANNER_MODEL ||= 'mock:coordination-planner';

function agent(name, capabilities, model) {
  return `---\nname: ${name}\ndescription: ${name} evaluation fixture\nmodel: ${model}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${name} fixture`;
}
await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent('Planner', ['coordinate', 'execute'], 'mock:planner')),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent('Coder', ['execute'], 'mock:coder')),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agent('Reviewer', ['review'], 'mock:reviewer')),
]);

const samples = JSON.parse(await readFile(path.join(repo, 'scripts/fixtures/coordination-planner-eval.json'), 'utf8'));
const registry = await import('../apps/server/src/agents/registry.ts');
const { previewCoordination } = await import('../apps/server/src/coordination/service.ts');
const { evaluateCoordinationPlanning } = await import('../apps/server/src/coordination/evaluation.ts');
registry.syncFromFiles();

const records = [];
for (const sample of samples) {
  const preview = await previewCoordination({
    goal: sample.goal,
    agentIds: sample.agentIds,
    ...(sample.defaultReviewerId ? { defaultReviewerId: sample.defaultReviewerId } : {}),
  });
  records.push({
    id: sample.id,
    expectedProtocols: sample.expectedProtocols,
    expectedDecision: sample.expectedDecision,
    draft: preview.draft,
    plan: preview.plan,
    ...(sample.outcome ? { outcome: sample.outcome } : {}),
  });
}

const metrics = evaluateCoordinationPlanning(records);
assert.ok(metrics.selectionAccuracy >= 0.8, JSON.stringify(metrics));
assert.ok(metrics.decisionAccuracy >= 0.8, JSON.stringify(metrics));
assert.equal(metrics.hardConstraintCoverage, 1, JSON.stringify(metrics));
assert.equal(metrics.executablePlanRate, 1, JSON.stringify(metrics));
assert.equal(metrics.observedCompletionRate, 1, JSON.stringify(metrics));
assert.equal(metrics.observedHumanCorrectionRate, 0, JSON.stringify(metrics));
console.log(JSON.stringify({ model: process.env.COORDINATION_PLANNER_MODEL, metrics }, null, 2));
