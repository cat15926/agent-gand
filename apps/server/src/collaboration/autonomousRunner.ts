import {intersectMessageAccess,type AgentDefinition,type AutonomousGrantBinding,type CollaborationDispatch,type MessageAccess,type RuntimeControlAction} from '@agent-gand/shared';
import {get,tx} from '../db/database.ts';
import {config} from '../config.ts';
import {getRun,startSpan,endSpan} from '../runs/trace.ts';
import {post} from '../messaging/inbox.ts';
import {subscribe} from '../messaging/bus.ts';
import {providerForAgent} from '../llm/router.ts';
import type {LlmMessage} from '../llm/provider.ts';
import {budgetedChat} from '../orchestration/executionBudget.ts';
import {executeToolOnce,toolExecutionKey} from '../tools/executions.ts';
import {enterMember} from '../execution/memberAdmission.ts';
import {assertAutonomousGrant,assertAutonomousGrantReady,bindAutonomousAttempt,loadAutonomousTaskGrant} from '../runtime/autonomousTasks.ts';
import {withAutonomousExecution} from '../runtime/autonomousExecution.ts';
import {AutonomousTaskError,autonomousFail as fail} from '../runtime/autonomousPolicy.ts';
import {loadRuntimeContract} from '../runtime/runPolicy.ts';
import {createExecutionScope,assembleScopedContext,compileScopedSource,inspectScopedSource,inputLedgerRevision,assertScopedOutput,
  exposeScopedInput,ScopedCollaborationError,type ScopedAttemptBinding} from '../runtime/scopedCollaboration.ts';
import {scopedFileTool,runScopedFileTool} from '../runtime/scopedFileTools.ts';
import {commitCompleteActionCommand} from '../runtime/actionCommands.ts';
import {submitCompletionCandidate} from '../runtime/subjectCompletion.ts';
import {observeTechnicalBlock} from '../runtime/shadow.ts';
import {loadCompletionSnapshot} from '../runtime/completionStore.ts';
import {evaluateCompletion} from '../runtime/completion.ts';
import {commitRunTerminal} from '../runtime/terminal.ts';
import {settleRequestedPause} from '../runtime/runControls.ts';
import {cancelCollaborationRun,finishAttempt,isActiveAttempt,setAttemptInputContext} from './store.ts';
import {AUTONOMOUS_TOOLS,parseAutonomousControlCall} from './autonomousTools.ts';
import {childWorks,commitAutonomousDelegation,previousWorkInputs,reconcileAutonomousGraph,workForDispatch,workState} from './autonomousGraph.ts';

function noUnknownCalls(runId:string):void {
  if(get(`SELECT 1 FROM orchestration_model_calls c WHERE c.run_id=? AND (c.status='unknown'
    OR EXISTS(SELECT 1 FROM orchestration_token_reservations t WHERE t.id=c.id AND t.status='unknown')
    OR EXISTS(SELECT 1 FROM execution_cost_reservations money WHERE money.id=c.id AND money.status='unknown'))`,runId))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
}
function completeWork(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,dispatch:CollaborationDispatch,summary:string){
  const {grant,policy}=assertAutonomousGrant(binding,'complete'),work=workForDispatch(dispatch.id)!;
  if(childWorks(work.id).some(w=>workState(w)!=='completed'))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
  noUnknownCalls(binding.runId);
  const outputAccess:MessageAccess=work.parent_work_id?getScope(scope.scopeId).defaultOutputAccess:policy.outputAccess;
  const domain:RuntimeControlAction={version:2,type:'complete',summary};
  return commitCompleteActionCommand({runId:binding.runId,commandKey:`autonomous:complete:${dispatch.id}`,attemptId:binding.attemptId,dispatchId:dispatch.id,
    scope:{...scope,ledgerRevision:inputLedgerRevision(binding.attemptId),outputAccess},execute:()=>{
      assertAutonomousGrant(binding,'complete');noUnknownCalls(binding.runId);
      const accepted=submitCompletionCandidate({runId:binding.runId,dispatchId:dispatch.id,attemptId:binding.attemptId,agentId:grant.agentId,action:domain,summary,
        evidenceRefs:[{kind:'attempt_output',id:binding.attemptId}],exitGuard:{status:'allow_candidate',reasons:['AUTONOMOUS_EXPLICIT_COMPLETE']},retryAllowed:false});
      if(accepted.evaluation.status!=='accepted')return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
      const message=post({runId:binding.runId,from:grant.agentId,to:'user',kind:'agent',messageType:'collaboration_contribution',body:summary,
        attemptId:binding.attemptId,...outputAccess,meta:{autonomousInternal:true}});
      finishAttempt({attemptId:binding.attemptId,dispatchId:dispatch.id,status:'completed',output:summary,action:domain,outputMessageId:message.id});
      return {candidateId:accepted.candidate.id,outputMessageId:message.id};
    }});
}
const getScope=(id:string):{defaultOutputAccess:MessageAccess}=>JSON.parse(get<{record:string}>('SELECT record FROM runtime_execution_scopes WHERE id=?',id)!.record);

/** API executor with cold, whitelist-only contexts. No legacy agentStep/history or implicit completion. */
export async function executeAutonomousDispatch(dispatch:CollaborationDispatch,attemptId:string,agent:AgentDefinition):Promise<void>{
  const controller=new AbortController();let release:(()=>void)|undefined,span:ReturnType<typeof startSpan>|undefined;
  const unsubscribe=subscribe(()=>{if(!isActiveAttempt(attemptId,dispatch.id))controller.abort();});
  try{
    const work=workForDispatch(dispatch.id);if(!work||agent.execution?.kind==='external')return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
    const binding=bindAutonomousAttempt(work.grant_id,attemptId);
    await withAutonomousExecution(binding,async()=>{
      const {grant,policy}=assertAutonomousGrant(binding);
      const custody=get<{generation:number}>('SELECT generation FROM runtime_custody WHERE subject_id=?',grant.subjectId)!;
      const prior=previousWorkInputs(work.id);
      const wake=get<{result:string}>("SELECT result FROM runtime_action_commands WHERE run_id=? AND kind='wake' AND json_extract(result,'$.dispatchId')=?",binding.runId,dispatch.id);
      if(wake)prior.push(compileScopedSource(binding.runId,'message',JSON.parse(wake.result).sourceMessageId));
      // A coordinator sees opaque handles, not every source it is permitted to delegate.
      const refs=[...prior,...(work.parent_work_id?grant.inputs.map(i=>i.source):[]),compileScopedSource(binding.runId,'message',work.objective_message_id)];
      const access=intersectMessageAccess([grant.outputAccess,...refs.map(ref=>{
        const source=inspectScopedSource(binding.runId,ref.kind,ref.id);
        if(JSON.stringify(source.ref)!==JSON.stringify(ref))return fail('AUTONOMOUS_POLICY_DRIFT');return source.access;
      })]);
      const receipts=childWorks(work.id).map(w=>({key:w.work_key,state:workState(w)}));
      const catalog=grant.inputs.map(i=>({id:i.source.id,readers:i.readers}));
      const directive=post({runId:binding.runId,from:'system',to:agent.id,kind:'system',...access,meta:{autonomousInternal:true},clientMessageId:`autonomous:directive:${attemptId}`,
        body:`你只处理当前责任，按实际需要选择不同成员及依赖，不要照抄固定计划。使用 agent.delegate 后本轮结束并持久等待；子任务结束会自动唤醒，无需轮询。追加任务必须使用新的 key，已提交任务不可改写。依赖只代表执行顺序，不自动转交结果正文。完成时调用 agent.complete。只有原授权范围内的文本可进入子任务；无权读取的输入只可通过句柄转交。当前仅模型 API 可执行。\n角色定义（冻结）：${agent.systemPrompt}\n可选成员：${JSON.stringify(policy.members.filter(m=>grant.participantIds.includes(m.agentId)&&m.driver==='builtin-llm').map(m=>({id:m.agentId,tools:m.allowedTools})))}\n输入句柄：${JSON.stringify(catalog)}\n已提交子工作固定状态：${JSON.stringify(receipts)}`});
      const scope=createExecutionScope({runId:binding.runId,subjectId:grant.subjectId,agentId:agent.id,kind:work.parent_work_id?'content':'control',defaultOutputAccess:access,
        recoveryGeneration:custody.generation,objective:compileScopedSource(binding.runId,'message',work.objective_message_id),inputs:[...refs,compileScopedSource(binding.runId,'message',directive.id)],allowedTools:grant.allowedTools});
      const scoped:ScopedAttemptBinding={runId:binding.runId,scopeId:scope.id,agentId:agent.id,attemptId};
      const context=assembleScopedContext(scoped);setAttemptInputContext(attemptId,context);
      release=await enterMember({runId:binding.runId,agentId:agent.id,attemptId,scope:`collaboration:${dispatch.id}`,signal:controller.signal,
        authorized:()=>{try{assertAutonomousGrant(binding);return true;}catch{return false;}}});
      const messages:LlmMessage[]=[{role:'system',content:'执行服务端冻结的当前独立任务。任何完成或委派必须实际调用已提供的工具；不要输出平台凭据或伪造执行事实。'},{role:'user',content:context}];
      const tools=[...AUTONOMOUS_TOOLS.filter(t=>grant.actions.includes(t.name==='agent.delegate'?'delegate':'complete')
        &&(t.name!=='agent.delegate'||grant.depth<policy.budget.maxDepth&&policy.members.some(m=>m.agentId!==agent.id&&grant.participantIds.includes(m.agentId)&&m.driver==='builtin-llm'))),
        ...grant.allowedTools.map(name=>scopedFileTool(name)).filter(t=>!!t).map(t=>({name:t.name,description:t.description,parameters:t.inputSchema}))];
      for(let round=0;round<8;round++){
        assertAutonomousGrant(binding);assertScopedOutput({...scoped,ledgerRevision:inputLedgerRevision(attemptId),outputAccess:access});
        span=startSpan(binding.runId,{spanKind:'llm',name:`autonomous:${agent.id}`,input:JSON.stringify(messages),attributes:{'agent.id':agent.id,'collaboration.attempt.id':attemptId,'collaboration.dispatch.id':dispatch.id}});
        const response=await budgetedChat(binding.runId,providerForAgent(agent,binding.runId),{model:agent.model,messages,tools,maxTokens:policy.budget.maxTokensPerCall,signal:controller.signal},undefined,agent.id,attemptId);
        endSpan(span,{tokensIn:response.usage.tokensIn,tokensOut:response.usage.tokensOut,costUsd:response.usage.costUsd,usageKnown:response.usage.outputKnown!==false,costKnown:response.usage.costKnown!==false});span=undefined;
        assertAutonomousGrant(binding);
        if(response.truncated||response.toolCalls.length!==1)return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');
        const call=response.toolCalls[0]!;
        if(call.name.startsWith('agent.')){
          const action=parseAutonomousControlCall(call);
          if(action.type==='delegate')commitAutonomousDelegation(binding,scoped,action.intent);else completeWork(binding,scoped,dispatch,action.summary);
          return;
        }
        if(!grant.allowedTools.includes(call.name))return fail('AUTONOMOUS_ACCESS_DENIED');
        const tool=scopedFileTool(call.name);if(!tool)return fail('AUTONOMOUS_ACCESS_DENIED');
        const toolSpan=startSpan(binding.runId,{spanKind:'tool',name:`tool:${call.name}`,input:call.input,attributes:{'agent.id':agent.id,'collaboration.attempt.id':attemptId}});
        try{
          const executionKey=toolExecutionKey({runId:binding.runId,scope:attemptId,round,index:0,toolName:call.name,input:call.input});
          const result=await executeToolOnce({runId:binding.runId,agentId:agent.id,attemptId,toolName:call.name,input:call.input,idempotencyKey:executionKey,replayPolicy:tool.replayPolicy??'manual',spanId:toolSpan.id,
            execute:()=>runScopedFileTool(scoped,call.name,JSON.parse(call.input))});
          assertAutonomousGrant(binding);
          const execution=get<{id:string}>('SELECT id FROM tool_executions WHERE idempotency_key=?',executionKey)!;
          const bytes=exposeScopedInput(scoped,compileScopedSource(binding.runId,'tool_execution',execution.id),'tool_result',call.name).toString('utf8');
          endSpan(toolSpan,{output:result.output});messages.push({role:'assistant',content:JSON.stringify(call)},{role:'user',content:`【工具结果】${call.name}\n${bytes}`});
        }catch(error){endSpan(toolSpan,{status:'error',output:'AUTONOMOUS_TOOL_FAILED'});throw error;}
      }
      fail('AUTONOMOUS_LIMIT_EXCEEDED');
    });
  }catch(error){
    const code=error instanceof AutonomousTaskError||error instanceof ScopedCollaborationError?error.code:'AUTONOMOUS_EXECUTION_FAILED';
    if(span)endSpan(span,{status:'error',output:code,usageKnown:false,costKnown:false});
    if(isActiveAttempt(attemptId,dispatch.id))tx(()=>{observeTechnicalBlock(dispatch.id,attemptId,agent.id);finishAttempt({attemptId,dispatchId:dispatch.id,status:'failed',dispatchStatus:'blocked',error:code});});
  }finally{unsubscribe();release?.();}
}

/** AC2 completes internal responsibility only. Automatic result aggregation/publication is AC3. */
export function settleAutonomousRun(runId:string):void {
  if(config.autonomousCollaborationMode!=='execute'||loadRuntimeContract(runId)?.features?.autonomousCollaboration?.delegationVersion!==1||getRun(runId)?.status!=='running'||settleRequestedPause(runId))return;
  const terminate=(reason:string)=>commitRunTerminal({runId,status:'failed',disposition:'failed',source:'autonomous_delegation',closeExecution:()=>cancelCollaborationRun(runId),userMessageStatus:'failed',prepare:()=>({reasonCodes:[reason]})});
  try{
    const root=get<{grant_id:string}>('SELECT grant_id FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',runId);if(!root)return;
    assertAutonomousGrantReady(root.grant_id);reconcileAutonomousGraph(runId);
    const grant=loadAutonomousTaskGrant(root.grant_id),state=get<{status:string}>('SELECT status FROM runtime_subjects WHERE id=?',grant.subjectId)!.status;
    if(state==='failed'||state==='cancelled'){terminate('AUTONOMOUS_ROOT_FAILED');return;}
    if(state!=='completed')return;
    noUnknownCalls(runId);
    const snapshot=loadCompletionSnapshot(runId);if(!snapshot)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    const evaluation=evaluateCompletion(snapshot.input);
    if(evaluation.status!=='accepted'){terminate('AUTONOMOUS_COMPLETION_REJECTED');return;}
    commitRunTerminal({runId,status:'completed',disposition:'accepted',source:'autonomous_delegation',userMessageStatus:'responded',prepare:()=>{
      const latest=loadCompletionSnapshot(runId)!;return {completion:{input:latest.input,evaluation:evaluateCompletion(latest.input)}};
    }});
  }catch(error){terminate(error instanceof AutonomousTaskError?error.code:'AUTONOMOUS_RECONCILIATION_FAILED');}
}
