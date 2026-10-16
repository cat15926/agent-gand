import type { AgentDefinition, ScopedControlActionV3 } from '@agent-gand/shared';
import type { LlmToolCall, LlmToolSchema } from '../llm/provider.ts';
import { getRun } from '../runs/trace.ts';
import { captureExecutionBinding } from '../execution/authority.ts';
import { createScopedNativeEnvironment } from '../execution/scopedNative.ts';
import { runExternalAgentTurn } from '../execution/runner.ts';
import type { ScopedAttemptBinding } from '../runtime/scopedCollaboration.ts';

/** Transport adapter only: v3 stays private until the owning scoped scheduler commits.
 * The v2 marker satisfies native transport lifecycle; it is never a Runtime command. */
export async function runScopedNativeTurn(input: {
  binding: ScopedAttemptBinding; agent: AgentDefinition; context: string; parentSpanId: string;
  tool: LlmToolSchema; parse(call: LlmToolCall): ScopedControlActionV3; signal: AbortSignal;
}): Promise<ScopedControlActionV3> {
  const isolation = await createScopedNativeEnvironment(input.binding);
  let action: ScopedControlActionV3 | null = null;
  try {
    await runExternalAgentTurn({ run: getRun(input.binding.runId)!, agent: input.agent,
      parentSpanId: input.parentSpanId, attemptId: input.binding.attemptId,
      executionScopeId: input.binding.scopeId, executionBinding: captureExecutionBinding(input.binding.runId,input.agent.id,input.binding.attemptId),
      messages: [{ role:'user',content:input.context }], controlTools:[input.tool],
      handleControlCalls(calls) {
        isolation.assertAuthorized();
        if (calls.length !== 1 || action) throw new Error('SCOPED_EXPLICIT_ACTION_REQUIRED');
        action = input.parse(calls[0]!);
        return { version:2,type:'complete',summary:'范围动作候选已接收；等待范围调度器校验。' };
      }, scopedNative:isolation, executionSignal:input.signal });
    isolation.assertAuthorized();
    if (!action) throw new Error('SCOPED_EXPLICIT_ACTION_REQUIRED');
    return action;
  } finally { await isolation.close(); }
}
