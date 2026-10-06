import { appendFileSync } from 'node:fs';
const { mockProvider } = await import('../../apps/server/src/llm/provider.ts');
const trace = await import('../../apps/server/src/runs/trace.ts');
const { pipelineOrchestrator } = await import('../../apps/server/src/orchestration/pipeline.ts');
const { runAdmittedTurn } = await import('../../apps/server/src/orchestration/admittedTurn.ts');
const item = trace.getRun(process.env.O3_RUN_ID);
mockProvider.chat = async () => {
  appendFileSync(process.env.O3_LOG, JSON.stringify({ runId: item.id, event: 'start', time: Date.now(), pid: process.pid }) + '\n');
  await new Promise(resolve => setTimeout(resolve, Number(process.env.O3_DELAY ?? 100)));
  appendFileSync(process.env.O3_LOG, JSON.stringify({ runId: item.id, event: 'end', time: Date.now(), pid: process.pid }) + '\n');
  const content = process.env.O3_MODE === 'planning_only'
    ? JSON.stringify({ tasks: [{ title: '恢复已确认的规划任务', body: item.goal, assignee: 'aa', reviewRequired: false, acceptanceCriteria: ['提供完整结果'] }] })
    : `可信结果 ${item.goal}`;
  return { content, toolCalls: [], stopReason: 'end_turn', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } };
};
const agents = trace.listRunAgentSnapshots(item.id);
if (['turn_only','planning_only'].includes(process.env.O3_MODE)) {
  trace.setRunStatus(item.id, 'running');
  const span = trace.startSpan(item.id, { spanKind: 'agent', name: 'persisted turn' });
  await runAdmittedTurn({ run: item, agent: agents[0], parentSpanId: span.id,
    messages: [{ role: 'user', content: item.goal }], executionScopeId: process.env.O3_MODE === 'planning_only' ? 'supervisor:planning' : `pipeline:0:${agents[0].id}` });
} else await pipelineOrchestrator.start(item, agents, item.goal);
process.stdout.write('done\n');
