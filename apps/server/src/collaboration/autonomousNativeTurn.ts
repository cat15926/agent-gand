import type {AgentDefinition} from '@agent-gand/shared';
import type {LlmMessage,LlmToolCall,LlmToolSchema} from '../llm/provider.ts';
import {getRun} from '../runs/trace.ts';
import {captureExecutionBinding} from '../execution/authority.ts';
import {createScopedNativeEnvironment} from '../execution/scopedNative.ts';
import {runExternalAgentTurn} from '../execution/runner.ts';
import type {ScopedAttemptBinding} from '../runtime/scopedCollaboration.ts';
import {scopedNativeAgentSupported} from '../runtime/scopedCapabilities.ts';
import {autonomousFail as fail} from '../runtime/autonomousPolicy.ts';
import {parseAutonomousControlCall} from './autonomousTools.ts';

/** Transport only: capture one actual v4 tool candidate, settle usage and quiesce before Runtime commits. */
export async function runAutonomousNativeTurn(input:{binding:ScopedAttemptBinding;agent:AgentDefinition;messages:LlmMessage[];tools:LlmToolSchema[];parentSpanId:string;round:number;signal:AbortSignal}):Promise<LlmToolCall>{
 if(input.agent.execution?.kind!=='external'||input.agent.execution.driver!=='claude-sdk'||!scopedNativeAgentSupported(input.agent,false))return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
 const isolation=await createScopedNativeEnvironment(input.binding);let candidate:LlmToolCall|null=null;
 try{
  await runExternalAgentTurn({run:getRun(input.binding.runId)!,agent:input.agent,parentSpanId:input.parentSpanId,attemptId:input.binding.attemptId,
   // Launch identity is server derived; actual input authority remains the one bound Scope/Attempt.
   executionScopeId:`${input.binding.scopeId}:autonomous:${input.round}`,executionBinding:captureExecutionBinding(input.binding.runId,input.agent.id,input.binding.attemptId),
   messages:input.messages,controlTools:input.tools.filter(t=>t.name.startsWith('agent.')),scopedNative:isolation,executionSignal:input.signal,
   handleControlCalls(calls){isolation.assertAuthorized();if(candidate||calls.length!==1)return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');parseAutonomousControlCall(calls[0]!);candidate=calls[0]!;
    return {version:2,type:'complete',summary:'自主动作候选已接收；仅传输收敛标记，等待执行器校验并提交。'};
   }});
  isolation.assertAuthorized();if(!candidate)return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');return candidate;
 }finally{await isolation.close();}
}
