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
import {all} from '../db/database.ts';
import {getManagedArtifact} from '../artifacts/store.ts';
import {SCOPED_FILE_TOOLS,scopedFileTool,runScopedFileTool} from '../runtime/scopedFileTools.ts';
import {executeToolOnce} from '../tools/executions.ts';
import {checkPermission} from '../tools/types.ts';
import {runScopedNativeTurn} from '../collaboration/scopedNativeTurn.ts';
import {parseScopedControlCall,scopedControlTool} from '../collaboration/scopedRunner.ts';

/** R7 has already selected the static DAG inputs. This adapter adds the common
 * immutable manifest/ledger and late-output fence without inventing new edges. */
export function createCoordinationScopedContext(input: {
  runId:string; plan:CoordinationPlan; step:CoordinationPlanStep; attemptId:string;
  agent:AgentDefinition; context:string; access:MessageAccess; sourceMessageIds:string[]; sourceAttemptIds?:string[];
}): { binding:ScopedAttemptBinding; context:string; assertOutput():void; commitOutput<T>(effect:()=>T):T } | undefined {
  const version=loadRuntimeContract(input.runId)?.features?.coordinationScopes;
  if(!version)return undefined;
  if(version===1&&(input.agent.execution?.kind==='external'||input.step.toolPolicy.allowedTools.length||input.step.expectedArtifacts?.length))throw new Error('COORDINATION_SCOPE_UNSUPPORTED');
  if(version===2&&(input.step.metadata.scopedFilesOnly!==true||input.step.toolPolicy.allowedTools.some(name=>!SCOPED_FILE_TOOLS.includes(name))))throw new Error('COORDINATION_SCOPE_UNSUPPORTED');
  const files=version===2?all<{id:string;attempt:string|null;author:string}>("SELECT id,json_extract(record,'$.attemptId') attempt,json_extract(record,'$.createdBy') author FROM managed_artifact_versions WHERE run_id=?",input.runId).filter(row=>row.attempt?(input.sourceAttemptIds??[]).includes(row.attempt):row.author==='user').flatMap(row=>{
    try {return [getManagedArtifact(row.id,input.agent.id,input.access)];}catch{return [];}
  }):[];
  const fileManifest=files.length?'\n\n本 Scope 可读取的受控文件版本：'+JSON.stringify(files.map(file=>({path:file.path,version:file.version,sha256:file.sha256}))):'';
  const link=get<{subject_id:string;generation:number}>(`SELECT s.subject_id,c.generation FROM runtime_coordination_subjects s JOIN runtime_custody c ON c.subject_id=s.subject_id WHERE s.plan_id=? AND s.revision=? AND s.step_id=?`,input.plan.id,input.plan.revision,input.step.id)!;
  const prompt=post({runId:input.runId,from:'system',to:input.agent.id,kind:'system',messageType:'collaboration_routing',body:input.context+fileManifest,
    ...input.access,attemptId:input.attemptId,meta:{scopedInternal:true},clientMessageId:'coord-scope:prompt:'+input.attemptId});
  const role=post({runId:input.runId,from:'system',to:input.agent.id,kind:'system',messageType:'collaboration_routing',body:input.agent.systemPrompt,
    ...input.access,attemptId:input.attemptId,meta:{scopedInternal:true},clientMessageId:'coord-scope:role:'+input.attemptId});
  const root=get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND kind='user' ORDER BY seq LIMIT 1",input.runId);
  const dynamicInputs=[...[...new Set([...input.sourceMessageIds,...(root?[root.id]:[])])].map(id=>compileScopedSource(input.runId,'message',id)),...files.map(file=>compileScopedSource(input.runId,'artifact',file.id))];
  const scope=createExecutionScope({runId:input.runId,subjectId:link.subject_id,agentId:input.agent.id,kind:'content',defaultOutputAccess:input.access,recoveryGeneration:link.generation,
    objective:compileScopedSource(input.runId,'message',prompt.id),inputs:[compileScopedSource(input.runId,'message',role.id)],dynamicInputs,allowedTools:input.step.toolPolicy.allowedTools.filter(name=>input.agent.tools.includes(name)&&checkPermission(input.agent,name)==='allow'&&(input.agent.execution?.kind!=='external'||input.agent.execution.platformTools?.includes(name)))});
  const binding={runId:input.runId,scopeId:scope.id,agentId:input.agent.id,attemptId:input.attemptId};
  const context=assembleScopedContext(binding);
  // The R7 prompt already contains these approved excerpts. Record their original
  // identities as possibly exposed before any model call; recheck ACL/hash at return.
  for(const ref of dynamicInputs)exposeScopedInput(binding,ref,'supplement');
  const output=()=>({...binding,ledgerRevision:inputLedgerRevision(input.attemptId),outputAccess:input.access});
  return {binding,context,assertOutput:()=>assertScopedOutput(output()),commitOutput:effect=>commitScopedOutput(output(),effect)};
}

export async function runCoordinationScopedTurn(input: { binding:ScopedAttemptBinding; context:string; agent:AgentDefinition; parentSpanId:string; maxTokens:number; signal:AbortSignal; assertOutput():void }): Promise<AgentTurnResult> {
  const authority=captureExecutionBinding(input.binding.runId,input.agent.id,input.binding.attemptId);
  const release=await enterMember({runId:input.binding.runId,agentId:input.agent.id,attemptId:input.binding.attemptId,scope:'coordination:'+input.binding.attemptId,signal:input.signal,authorized:()=>bindingAuthorized(authority)});
  const span=startSpan(input.binding.runId,{parentId:input.parentSpanId,spanKind:input.agent.execution?.kind==='external'?'agent':'llm',name:'coordination-scoped:'+input.agent.id,input:input.context,attributes:{'agent.id':input.agent.id,'coordination.attempt.id':input.binding.attemptId}});
  const usage={tokensIn:0,tokensOut:0,costUsd:0,usageKnown:true,costKnown:true};
  try {
    input.assertOutput();assertBindingAuthorized(authority);
    if(input.agent.execution?.kind==='external') {
      const expected={version:3 as const,type:'complete' as const,summary:''};
      const action=await runScopedNativeTurn({...input,parentSpanId:span.id,tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected)});
      input.assertOutput();const content='summary' in action?action.summary:'';endSpan(span,{output:content});
      return {content,toolRounds:0,emptyResponse:!content.trim(),controlAction:null};
    }
    const {scopedToolPolicy}=await import('../runtime/scopedCollaboration.ts');
    const tools=scopedToolPolicy(input.binding).tools.map(name=>scopedFileTool(name)!).filter(Boolean);
    const messages=[{role:'user' as const,content:input.context}];let used=0,calls=0;
    for(let round=0;round<8;round++) {
      const response=await budgetedChat(input.binding.runId,providerForAgent(input.agent,input.binding.runId),{model:input.agent.model,messages,maxTokens:Math.max(1,input.maxTokens-used),tools:tools.map(t=>({name:t.name,description:t.description,parameters:t.inputSchema})),signal:input.signal},undefined,input.agent.id,input.binding.attemptId);
      usage.tokensIn+=response.usage.tokensIn;usage.tokensOut+=response.usage.tokensOut;usage.costUsd+=response.usage.costUsd;
      usage.usageKnown&&=response.usage.inputKnown!==false&&response.usage.outputKnown!==false;usage.costKnown&&=response.usage.costKnown!==false;
      input.assertOutput();assertBindingAuthorized(authority);used+=response.usage.tokensOut;
      if(response.truncated)throw new Error('COORDINATION_SCOPE_OUTPUT_TRUNCATED');
      if(!response.toolCalls.length){endSpan(span,{output:response.content,...usage});return {content:response.content,toolRounds:round,emptyResponse:!response.content.trim(),truncated:false,controlAction:null};}
      if(used>=input.maxTokens)throw new Error('SCOPED_TOKEN_BUDGET_EXHAUSTED');
      messages.push({role:'user',content:response.content});
      for(const call of response.toolCalls) {
        if(++calls>6||!tools.some(tool=>tool.name===call.name))throw new Error('COORDINATION_SCOPE_TOOL_NOT_ALLOWED');
        const tool=tools.find(t=>t.name===call.name)!,toolSpan=startSpan(input.binding.runId,{parentId:span.id,spanKind:'tool',name:tool.name,input:call.input,attributes:{'agent.id':input.agent.id}});
        const key=`coord-scope:${input.binding.attemptId}:${round}:${calls}`;
        try {
          const result=await executeToolOnce({runId:input.binding.runId,agentId:input.agent.id,attemptId:input.binding.attemptId,toolName:tool.name,input:call.input,idempotencyKey:key,replayPolicy:tool.replayPolicy!,spanId:toolSpan.id,execute:()=>{if(input.signal.aborted)throw input.signal.reason;input.assertOutput();assertBindingAuthorized(authority);return runScopedFileTool(input.binding,tool.name,JSON.parse(call.input));}});
          input.assertOutput();assertBindingAuthorized(authority);
          const execution=get<{id:string}>('SELECT id FROM tool_executions WHERE idempotency_key=?',key)!;
          const output=exposeScopedInput(input.binding,compileScopedSource(input.binding.runId,'tool_execution',execution.id),'tool_result',tool.name).toString('utf8');
          messages.push({role:'user',content:`【工具结果】${tool.name}\n${output}`});endSpan(toolSpan,{output});
        } catch(error){endSpan(toolSpan,{status:'error',output:'SCOPED_TOOL_REJECTED'});throw error;}
      }
    }
    throw new Error('SCOPED_TOOL_LIMIT');
  } catch(error) {endSpan(span,{status:'error',output:'COORDINATION_SCOPED_EXECUTION_FAILED',...usage,usageKnown:false,costKnown:false});throw error;}
  finally {release();}
}
