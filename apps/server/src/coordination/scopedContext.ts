import type { AgentTurnResult } from '../orchestration/agentStep.ts';
import type { AgentDefinition, CoordinationPlan, CoordinationPlanStep, MessageAccess } from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { post } from '../messaging/inbox.ts';
import { loadRuntimeContract } from '../runtime/runPolicy.ts';
import { assembleScopedContext, assertScopedOutput, commitScopedOutput, compileScopedSource, createExecutionScope, exposeScopedInput, inputLedgerRevision, type ScopedAttemptBinding } from '../runtime/scopedCollaboration.ts';
import { captureExecutionBinding, assertBindingAuthorized, bindingAuthorized } from '../execution/authority.ts';
import { enterMember } from '../execution/memberAdmission.ts';
import { budgetedChat } from '../orchestration/executionBudget.ts';
import { providerForAgent } from '../llm/router.ts';
import { startSpan, endSpan } from '../runs/trace.ts';

/** R7 has already selected the static DAG inputs. This adapter adds the common
 * immutable manifest/ledger and late-output fence without inventing new edges. */
export function createCoordinationScopedContext(input: {
  runId:string; plan:CoordinationPlan; step:CoordinationPlanStep; attemptId:string;
  agent:AgentDefinition; context:string; access:MessageAccess; sourceMessageIds:string[];
}): { binding:ScopedAttemptBinding; context:string; assertOutput():void; commitOutput<T>(effect:()=>T):T } | undefined {
  if(loadRuntimeContract(input.runId)?.features?.coordinationScopes!==1)return undefined;
  if(input.agent.execution?.kind==='external'||input.step.toolPolicy.allowedTools.length||input.step.expectedArtifacts?.length)throw new Error('COORDINATION_SCOPE_UNSUPPORTED');
  const link=get<{subject_id:string;generation:number}>(`SELECT s.subject_id,c.generation FROM runtime_coordination_subjects s JOIN runtime_custody c ON c.subject_id=s.subject_id WHERE s.plan_id=? AND s.revision=? AND s.step_id=?`,input.plan.id,input.plan.revision,input.step.id)!;
  const prompt=post({runId:input.runId,from:'system',to:input.agent.id,kind:'system',messageType:'collaboration_routing',body:input.context,
    ...input.access,attemptId:input.attemptId,meta:{scopedInternal:true},clientMessageId:'coord-scope:prompt:'+input.attemptId});
  const role=post({runId:input.runId,from:'system',to:input.agent.id,kind:'system',messageType:'collaboration_routing',body:input.agent.systemPrompt,
    ...input.access,attemptId:input.attemptId,meta:{scopedInternal:true},clientMessageId:'coord-scope:role:'+input.attemptId});
  const root=get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND kind='user' ORDER BY seq LIMIT 1",input.runId);
  const dynamicInputs=[...new Set([...input.sourceMessageIds,...(root?[root.id]:[])])].map(id=>compileScopedSource(input.runId,'message',id));
  const scope=createExecutionScope({runId:input.runId,subjectId:link.subject_id,agentId:input.agent.id,kind:'content',defaultOutputAccess:input.access,recoveryGeneration:link.generation,
    objective:compileScopedSource(input.runId,'message',prompt.id),inputs:[compileScopedSource(input.runId,'message',role.id)],dynamicInputs});
  const binding={runId:input.runId,scopeId:scope.id,agentId:input.agent.id,attemptId:input.attemptId};
  const context=assembleScopedContext(binding);
  // The R7 prompt already contains these approved excerpts. Record their original
  // identities as possibly exposed before any model call; recheck ACL/hash at return.
  for(const ref of dynamicInputs)exposeScopedInput(binding,ref,'supplement');
  const revision=inputLedgerRevision(input.attemptId);
  const output={...binding,ledgerRevision:revision,outputAccess:input.access};
  return {binding,context,assertOutput:()=>assertScopedOutput(output),commitOutput:effect=>commitScopedOutput(output,effect)};
}

export async function runCoordinationScopedTurn(input: { binding:ScopedAttemptBinding; context:string; agent:AgentDefinition; parentSpanId:string; maxTokens:number; signal:AbortSignal; assertOutput():void }): Promise<AgentTurnResult> {
  const authority=captureExecutionBinding(input.binding.runId,input.agent.id,input.binding.attemptId);
  const release=await enterMember({runId:input.binding.runId,agentId:input.agent.id,attemptId:input.binding.attemptId,scope:'coordination:'+input.binding.attemptId,signal:input.signal,authorized:()=>bindingAuthorized(authority)});
  const span=startSpan(input.binding.runId,{parentId:input.parentSpanId,spanKind:'llm',name:'coordination-scoped:'+input.agent.id,input:input.context,attributes:{'agent.id':input.agent.id,'coordination.attempt.id':input.binding.attemptId}});
  try {
    input.assertOutput();assertBindingAuthorized(authority);
    const response=await budgetedChat(input.binding.runId,providerForAgent(input.agent,input.binding.runId),{model:input.agent.model,messages:[{role:'user',content:input.context}],maxTokens:input.maxTokens,tools:[],signal:input.signal},undefined,input.agent.id,input.binding.attemptId);
    input.assertOutput();assertBindingAuthorized(authority);
    if(response.toolCalls.length)throw new Error('COORDINATION_SCOPE_TOOL_NOT_ALLOWED');
    endSpan(span,{output:response.content,tokensIn:response.usage.tokensIn,tokensOut:response.usage.tokensOut,costUsd:response.usage.costUsd,usageKnown:response.usage.outputKnown!==false,costKnown:response.usage.costKnown!==false});
    return {content:response.content,toolRounds:0,emptyResponse:!response.content.trim(),truncated:response.truncated,controlAction:null};
  } catch(error) {endSpan(span,{status:'error',output:'COORDINATION_SCOPED_EXECUTION_FAILED',usageKnown:false,costKnown:false});throw error;}
  finally {release();}
}
