import { claimRuntimeHost, registerNativeProcess, releaseRuntimeHost } from '../../apps/server/src/execution/host.ts';
import { acquireDurableLease } from '../../apps/server/src/execution/leases.ts';
const mode = process.argv[2];
if (mode === 'host') {
  try { claimRuntimeHost(); console.log('claimed'); } catch { console.log('blocked'); } process.exit(0);
}
if (mode === 'lease') { acquireDurableLease(process.env.TEST_D_RESOURCE, 'child-holder', false); console.log('held'); setInterval(() => {}, 1000); }
else {
  claimRuntimeHost();
  const { getRun, listRunAgentSnapshots, startSpan, finishRun } = await import('../../apps/server/src/runs/trace.ts');
  const { runAgentTurn } = await import('../../apps/server/src/orchestration/agentStep.ts');
  const run = getRun(process.env.TEST_D_RUN); const agent = listRunAgentSnapshots(run.id)[0];
  if (mode === 'startup') {
    const { ensureIsolatedWorkspace } = await import('../../apps/server/src/workspaces/isolated.ts');
    const { createExecution } = await import('../../apps/server/src/execution/store.ts');
    const { spawnOwnedProcess } = await import('../../apps/server/src/execution/ownedProcess.ts');
    const binding = await ensureIsolatedWorkspace(run);
    const execution = createExecution({ runId: run.id, agentId: agent.id, agentVersion: agent.version, scopeId: 'fault', driver: agent.execution.driver, cwd: binding.cwd });
    await spawnOwnedProcess({ command: process.env.EXTERNAL_CLAUDE_SDK_WORKER_COMMAND, args: [], cwd: binding.cwd, env: process.env, signal: new AbortController().signal,
      onProcess: (owner) => { registerNativeProcess(execution.id, owner); process.kill(process.pid, 'SIGKILL'); } });
  }
  await runAgentTurn({ run, agent, parentSpanId: startSpan(run.id, { spanKind: 'agent', name: 'fault' }).id, executionScopeId: 'fault', messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'user', content: 'D_CONTENT=crash evidence' }] });
  if (mode === 'resume') { finishRun(run.id, 'completed'); releaseRuntimeHost(); console.log('resumed'); process.exit(0); }
  process.kill(process.pid, 'SIGKILL'); // Terminal saved, orchestration commit not yet made.
}
