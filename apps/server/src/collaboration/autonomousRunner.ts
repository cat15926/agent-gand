import {autonomousExecutionAvailable,autonomousDriverAllowed} from '../runtime/autonomousCapabilities.ts';
import {runAutonomousNativeTurn} from './autonomousNativeTurn.ts';
import {advanceAutonomousFlow,commitAutonomousFlowAction,assertFlowCompletion} from './autonomousFlows.ts';
import {flowForRun,flowJob,validateFlow} from '../runtime/autonomousFlowFacts.ts';
import {autonomousEntryEnabled,autonomousInstructionRefs,instructionRevision,pauseAutonomousAttempt,reconcileAutonomousPauses} from '../runtime/autonomousInstructions.ts';
import {intersectMessageAccess,type AgentDefinition,type AutonomousGrantBinding,type CollaborationDispatch,type MessageAccess,type RuntimeControlAction} from '@agent-gand/shared';
import {get,tx} from '../db/database.ts';
import {config} from '../config.ts';
import {getRun,setRunStatus,startSpan,endSpan} from '../runs/trace.ts';
import {post,updateRunUserMessageStatus} from '../messaging/inbox.ts';
import {subscribe} from '../messaging/bus.ts';
import {providerForAgent} from '../llm/router.ts';
import type {LlmMessage,LlmResponse} from '../llm/provider.ts';
import {budgetedChat,ModelAdmissionPausedError} from '../orchestration/executionBudget.ts';
import {executeToolOnce,toolExecutionKey} from '../tools/executions.ts';
import {enterMember} from '../execution/memberAdmission.ts';
import {assertAutonomousGrant,assertAutonomousGrantReady,bindAutonomousAttempt,loadAutonomousTaskGrant} from '../runtime/autonomousTasks.ts';
import {withAutonomousExecution,assertAutonomousUsageKnown as noUnknownCalls} from '../runtime/autonomousExecution.ts';
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
import {AUTONOMOUS_TOOLS,AUTONOMOUS_DELIVERY_TOOLS,AUTONOMOUS_FLOW_TOOLS,parseAutonomousControlCall,bindAutonomousToolSchemas} from './autonomousTools.ts';
import {getManagedArtifact} from '../artifacts/store.ts';
import {freezeAutonomousExposure,sealAutonomousResult} from '../runtime/autonomousResults.ts';
import {autonomousDeliveryEnabled,aggregateAutonomousResults,aggregateReturnInputs,emitAutonomousResult,requestAutonomousUser,reconcileAutonomousDecisions,prepareAutonomousFinal} from './autonomousDelivery.ts';
import {childWorks,commitAutonomousDelegation,previousWorkInputs,reconcileAutonomousGraph,workForDispatch,workState} from './autonomousGraph.ts';

function completeWork(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,dispatch:CollaborationDispatch,summary:string){
  const {grant,policy}=assertAutonomousGrant(binding,'complete'),work=workForDispatch(dispatch.id)!;
  if(childWorks(work.id).some(w=>workState(w)!=='completed'))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
  assertFlowCompletion(work.id,binding.runId);
  noUnknownCalls(binding.runId);
  const outputAccess:MessageAccess=work.parent_work_id?getScope(scope.scopeId).defaultOutputAccess:policy.outputAccess;
  const domain:RuntimeControlAction={version:2,type:'complete',summary};
  return commitCompleteActionCommand({runId:binding.runId,commandKey:`autonomous:complete:${dispatch.id}`,attemptId:binding.attemptId,dispatchId:dispatch.id,
    scope:{...scope,ledgerRevision:inputLedgerRevision(binding.attemptId),outputAccess},execute:()=>{
      assertAutonomousGrant(binding,'complete');noUnknownCalls(binding.runId);
      const exposure=autonomousDeliveryEnabled(binding.runId)?freezeAutonomousExposure(scope):null;
      const accepted=submitCompletionCandidate({runId:binding.runId,dispatchId:dispatch.id,attemptId:binding.attemptId,agentId:grant.agentId,action:domain,summary,
        evidenceRefs:[{kind:'attempt_output',id:binding.attemptId}],exitGuard:{status:'allow_candidate',reasons:['AUTONOMOUS_EXPLICIT_COMPLETE']},retryAllowed:false});
      if(accepted.evaluation.status!=='accepted')return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
      const message=post({runId:binding.runId,from:grant.agentId,to:'user',kind:'agent',messageType:'collaboration_contribution',body:summary,
        attemptId:binding.attemptId,...outputAccess,meta:{autonomousInternal:true}});
      finishAttempt({attemptId:binding.attemptId,dispatchId:dispatch.id,status:'completed',output:summary,action:domain,outputMessageId:message.id});
      if(exposure)sealAutonomousResult({runId:binding.runId,workId:work.id,grantId:grant.id,attemptId:binding.attemptId,candidateId:accepted.candidate.id,messageId:message.id,exposure});
      return {candidateId:accepted.candidate.id,outputMessageId:message.id};
    }});
}
const getScope=(id:string):{defaultOutputAccess:MessageAccess}=>JSON.parse(get<{record:string}>('SELECT record FROM runtime_execution_scopes WHERE id=?',id)!.record);

/** API executor with cold, whitelist-only contexts. No legacy agentStep/history or implicit completion. */
export async function executeAutonomousDispatch(dispatch:CollaborationDispatch,attemptId:string,agent:AgentDefinition):Promise<void>{
  const controller=new AbortController();let release:(()=>void)|undefined,span:ReturnType<typeof startSpan>|undefined;
  const unsubscribe=subscribe(()=>{if(!isActiveAttempt(attemptId,dispatch.id))controller.abort();});
  try{
    const work=workForDispatch(dispatch.id);if(!work||agent.execution?.kind==='external'&&loadRuntimeContract(dispatch.runId)?.features?.autonomousCollaboration?.nativeVersion!==1)return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
    const binding=bindAutonomousAttempt(work.grant_id,attemptId);
    await withAutonomousExecution(binding,async()=>{
      const {grant,policy}=assertAutonomousGrant(binding);
      const custody=get<{generation:number}>('SELECT generation FROM runtime_custody WHERE subject_id=?',grant.subjectId)!;
      const prior=previousWorkInputs(work.id);
      const delivery=autonomousDeliveryEnabled(binding.runId),entry=autonomousEntryEnabled(binding.runId),managedRuntime=loadRuntimeContract(binding.runId)?.features?.autonomousCollaboration?.rolloutVersion===1;
      if(delivery)prior.push(...aggregateReturnInputs(work));
      const wake=get<{result:string}>("SELECT result FROM runtime_action_commands WHERE run_id=? AND kind='wake' AND json_extract(result,'$.dispatchId')=?",binding.runId,dispatch.id);
      if(wake)prior.push(compileScopedSource(binding.runId,'message',JSON.parse(wake.result).sourceMessageId));
      // A coordinator sees opaque handles, not every source it is permitted to delegate.
      const initialInstructions=entry?autonomousInstructionRefs(binding.runId):[];
      const refs=[...prior,...initialInstructions,...(work.parent_work_id||entry?grant.inputs.filter(i=>i.readers.includes(agent.id)).map(i=>i.source):[]),compileScopedSource(binding.runId,'message',work.objective_message_id)];
      const access=intersectMessageAccess([grant.outputAccess,...refs.map(ref=>{
        const source=inspectScopedSource(binding.runId,ref.kind,ref.id);
        if(JSON.stringify(source.ref)!==JSON.stringify(ref))return fail('AUTONOMOUS_POLICY_DRIFT');return source.access;
      })]);
      const job=flowJob(work.id),flowId=flowForRun(binding.runId),flow=flowId?validateFlow(flowId):null;
      const flowDirective=policy.protocols?`\n可校验流程目录：${JSON.stringify(policy.protocols)}\n当前流程公开状态：${JSON.stringify(flow?{flowId,step:flow.latest.step,phase:flow.latest.state.phase,terminal:!!flow.latest.state.winner}:null)}。如果需求适合目录中的流程，用 agent.flow 启动；唤醒后继续推进至终局，终局回执后再完成。五人狼人杀可从现有成员中选择五位玩家（负责人也可在独立内容责任中担任玩家），不足则一次说明；不要改成口述模拟或要求用户发牌。秘密行动只能由各玩家实际调用 agent.flow_action；禁止用 aggregate 读取所有玩家身份，或用 emit 代替规则公告。`:'';
      const receipts=childWorks(work.id).map(w=>({key:w.work_key,state:workState(w)}));
      const catalog=grant.inputs.map(i=>({id:i.source.id,readers:i.readers,...(managedRuntime?{kind:i.source.kind,version:i.source.version,...(i.source.kind==='artifact'&&i.readers.includes(agent.id)?{path:getManagedArtifact(i.source.id,agent.id).path}:{})}:{})}));
      const directive=post({runId:binding.runId,from:'system',to:agent.id,kind:'system',...access,meta:{autonomousInternal:true},clientMessageId:`autonomous:directive:${attemptId}`,
        body:managedRuntime&&!job&&grant.participantIds.length===1&&!childWorks(work.id).length?`完成当前独立责任，使用本轮获准材料。请以 agent.complete 的 summary 提交实质结果、依据与局限；无需安排其他成员或汇总不存在的子结果。只有本轮提供的工具可用。\n角色定义（冻结）：${agent.systemPrompt}`:job?`你是当前阶段的独立行动者，只处理本人的 requiredAction。唯一可提交动作是 agent.flow_action，成功后平台自动完成责任。不要调用 agent.complete、委派、汇总、发布或替他人行动。严格按实际获准材料选择合法行动，不附加自由文字。\n角色定义（冻结）：${agent.systemPrompt}`:`你只处理当前责任，按实际需要选择不同成员及依赖，不要照抄固定计划。使用 agent.delegate 后本轮结束并持久等待；子任务结束会自动唤醒，无需轮询。追加任务必须使用新的 key，已提交任务不可改写。依赖只代表执行顺序，不自动转交结果正文。完成时调用 agent.complete。只有原授权范围内的文本可进入子任务；无权读取的输入只可通过句柄转交。仅使用本轮目录中已开放的成员与执行后端。已完成的工具效果和已验收子工作不要重复执行；用户补充只影响尚未执行的工作，确需重做时追加新工作并说明原因，仍使用根预算。${delivery?'可用 agent.aggregate 选择已完成子工作的 key，在新内容 Scope 中汇总，可选自己。结果权限由材料与任务范围共同限定，自动传入有权读取的汇总成员；无权的组织者只读固定状态。agent.emit 可提交合法阶段更新/最终候选，或 result_bundle 将确切结果直接交付给有权用户，task_status_v1 只允许服务端计数；final 在完成验收后发布。真正缺少业务信息时用 agent.request_user 一次合并问题，禁止例行询问是否继续。普通回答不等于权限批准。':''}\n角色定义（冻结）：${agent.systemPrompt}${flowDirective}\n可选成员：${JSON.stringify(policy.members.filter(m=>grant.participantIds.includes(m.agentId)&&autonomousDriverAllowed(policy,m.driver)).map(m=>({id:m.agentId,tools:m.allowedTools})))}\n输入句柄：${JSON.stringify(catalog)}\n已提交子工作固定状态：${JSON.stringify(receipts)}`});
      const turnTools=managedRuntime&&flow&&!job?[]:grant.allowedTools;
      const scope=createExecutionScope({runId:binding.runId,subjectId:grant.subjectId,agentId:agent.id,kind:work.parent_work_id?'content':'control',defaultOutputAccess:access,
        recoveryGeneration:custody.generation,objective:compileScopedSource(binding.runId,'message',work.objective_message_id),inputs:[...refs.filter(ref=>!(entry&&ref.kind==='message'&&ref.id===work.objective_message_id)),compileScopedSource(binding.runId,'message',directive.id)],allowedTools:turnTools});
      const scoped:ScopedAttemptBinding={runId:binding.runId,scopeId:scope.id,agentId:agent.id,attemptId};
      const context=assembleScopedContext(scoped,{artifactLabels:managedRuntime});setAttemptInputContext(attemptId,context);
      release=await enterMember({runId:binding.runId,agentId:agent.id,attemptId,scope:`collaboration:${dispatch.id}`,signal:controller.signal,
        authorized:()=>{try{assertAutonomousGrant(binding);return true;}catch{return false;}}});
      if(entry)updateRunUserMessageStatus(binding.runId,'processing');
      const messages:LlmMessage[]=[{role:'system',content:'执行服务端冻结的当前独立任务。任何完成或委派必须实际调用已提供的工具；不要输出平台凭据或伪造执行事实。'+(managedRuntime?` 当前执行者的精确 agentId 是 ${JSON.stringify(agent.id)}；选择自己也须填写这个 ID，不能使用 self、me 或角色昵称。`+' 本轮材料可能含历史指令和旧状态，以末尾的当前责任与状态为准。工作 key、输入句柄和状态回执都是平台标识，不是文件路径；fs.read/search.files 不能读取子任务结果。需要读取已完成子结果时，使用 agent.aggregate 的 resultKeys，在有权的新内容责任中汇总（可选自己）；只有实际提供的结果正文才是已读证据。若当前是独立叶子责任，只完成当前目标，不执行转交材料中属于上级的分工请求。 受控文件是带路径、版本及摘要的不可变快照；同一路径的旧版与新版可能同时存在。依赖结束不会把已授权的旧句柄替换为新版。复核修改必须通过 aggregate 读取写入任务的实际产物，并明确核对版本；读到旧版不能据此断言新版未保存。':'')},{role:'user',content:context}];
      let seenInstructionRevision=initialInstructions.length;
      let invalidFlowActions=0,invalidControlCalls=0;
      for(let round=0;round<8;round++){
        if(entry&&pauseAutonomousAttempt(binding,scoped))return;
        if(entry&&instructionRevision(binding.runId)>seenInstructionRevision){
          for(const ref of autonomousInstructionRefs(binding.runId)){if(get("SELECT 1 FROM runtime_input_provenance WHERE attempt_id=? AND json_extract(record,'$.source.id')=?",attemptId,ref.id))continue;messages.push({role:'user',content:`【用户补充要求】${exposeScopedInput(scoped,ref,'supplement').toString('utf8')}`});}
          seenInstructionRevision=instructionRevision(binding.runId);
        }
        assertAutonomousGrant(binding);assertScopedOutput({...scoped,ledgerRevision:inputLedgerRevision(attemptId),outputAccess:access});
        const roundFlow=managedRuntime&&flowId?validateFlow(flowId):null;
        let tools=[...[...(job?[]:AUTONOMOUS_TOOLS),...(delivery&&!job?AUTONOMOUS_DELIVERY_TOOLS:[]),...(policy.protocols?AUTONOMOUS_FLOW_TOOLS.filter(t=>job?t.name==='agent.flow_action':!work.parent_work_id&&t.name==='agent.flow'):[])].filter(t=>grant.actions.includes(t.name.slice('agent.'.length) as typeof grant.actions[number])
          &&(!managedRuntime||job||!roundFlow||t.name===(roundFlow.latest.state.winner?'agent.complete':'agent.flow'))
          &&(!managedRuntime||t.name!=='agent.aggregate'||childWorks(work.id).some(w=>workState(w)==='completed'))
          &&(t.name!=='agent.delegate'||grant.depth<policy.budget.maxDepth&&policy.members.some(m=>m.agentId!==agent.id&&grant.participantIds.includes(m.agentId)&&autonomousDriverAllowed(policy,m.driver)))),
          ...turnTools.map(name=>scopedFileTool(name)).filter(t=>!!t).map(t=>({name:t.name,description:t.description,parameters:t.inputSchema}))];
        if(managedRuntime)tools=bindAutonomousToolSchemas(tools,agent.id,policy.members.filter(m=>grant.participantIds.includes(m.agentId)&&autonomousDriverAllowed(policy,m.driver)).map(m=>m.agentId),grant.inputs.map(i=>i.source.id),roundFlow?{id:roundFlow.flow.id,step:roundFlow.latest.step}:undefined);
        span=startSpan(binding.runId,{spanKind:agent.execution?.kind==='external'?'agent':'llm',name:`autonomous:${agent.id}`,input:JSON.stringify(messages),attributes:{'agent.id':agent.id,'collaboration.attempt.id':attemptId,'collaboration.dispatch.id':dispatch.id}});
        let response:Pick<LlmResponse,'toolCalls'|'truncated'|'usage'>;
        try{response=agent.execution?.kind==='external'?{toolCalls:[await runAutonomousNativeTurn({binding:scoped,agent,messages,tools,parentSpanId:span.id,round,signal:controller.signal})],truncated:false,usage:{tokensIn:0,tokensOut:0,costUsd:0,outputKnown:false,costKnown:false}}:await budgetedChat(binding.runId,providerForAgent(agent,binding.runId),{model:agent.model,messages,tools,maxTokens:policy.budget.maxTokensPerCall,signal:controller.signal},undefined,agent.id,attemptId);}
        catch(error){if(error instanceof ModelAdmissionPausedError&&entry&&pauseAutonomousAttempt(binding,scoped)){endSpan(span,{output:'用户暂停；尚未发出的模型调用已停止准入。'});span=undefined;return;}throw error;}
        endSpan(span,{output:JSON.stringify(response.toolCalls),tokensIn:response.usage.tokensIn,tokensOut:response.usage.tokensOut,costUsd:response.usage.costUsd,usageKnown:response.usage.outputKnown!==false,costKnown:response.usage.costKnown!==false});span=undefined;
        assertAutonomousGrant(binding);
        if(entry&&pauseAutonomousAttempt(binding,scoped))return;
        if(entry&&instructionRevision(binding.runId)>seenInstructionRevision)continue; // Replan against new instructions before committing a stale tool action.
        if(response.truncated)return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');
        if(response.toolCalls.length!==1){if(invalidControlCalls++<(managedRuntime?2:0)){messages.push({role:'user',content:'本轮未提交动作。请只调用一个当前提供的工具，用完整参数提交实际结果或真实委派；完成当前责任使用 agent.complete，summary 应包含实质结果与依据。'});continue;}return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');}
        const call=response.toolCalls[0]!;
        if(job&&call.name!=='agent.flow_action'){if(invalidFlowActions++<2){messages.push({role:'user',content:'未提交行动。当前责任仅可调用 agent.flow_action，请按 requiredAction 提交本人行动，平台将自动完成责任。'});continue;}return fail('AUTONOMOUS_FLOW_ACTION_INVALID');}
        if(managedRuntime&&!tools.some(t=>t.name===call.name))return fail('AUTONOMOUS_ACCESS_DENIED');
        if(call.name.startsWith('agent.')){
          let action:ReturnType<typeof parseAutonomousControlCall>;
          try{action=parseAutonomousControlCall(call);}catch(error){if(error instanceof AutonomousTaskError&&['AUTONOMOUS_CONTRACT_INVALID','AUTONOMOUS_EXPLICIT_ACTION_REQUIRED'].includes(error.code)&&invalidControlCalls++<(managedRuntime?2:0)){messages.push({role:'user',content:'工具参数未通过格式校验，尚未提交任何动作。请严格使用当前工具 schema 中声明的字段，参数是一个完整 JSON 对象，不加 version/type 或说明文字。agent.complete 的 summary 至少16字符，应写出实际结果和依据。'});continue;}throw error;}
          if(action.type==='flow_action'){
            try{commitAutonomousFlowAction(binding,scoped,action.action,summary=>completeWork(binding,scoped,dispatch,summary));return;}
            catch(error){if(error instanceof AutonomousTaskError&&['AUTONOMOUS_FLOW_ACTION_INVALID','AUTONOMOUS_CONTRACT_INVALID'].includes(error.code)&&invalidFlowActions++<2){messages.push({role:'user',content:'行动未提交：字段、行动类型或目标不合法。严格按当前 requiredAction 重新作出你自己的决定。不可自选、选择死亡玩家、添加文字或其他字段。'});continue;}throw error;}
          }
          if(action.type==='flow'){
            const result=advanceAutonomousFlow(binding,scoped,action.intent);if(result.waiting)return;
            if(!('receiptId' in result)||typeof result.receiptId!=='string')return fail('AUTONOMOUS_AUTHORITY_INVALID');
            const bytes=exposeScopedInput(scoped,compileScopedSource(binding.runId,'message',result.receiptId),'supplement').toString('utf8');messages.push({role:'assistant',content:JSON.stringify(call)},{role:'user',content:`【流程终局回执】${bytes}\n请调用 agent.complete 完成本责任。`});continue;
          }
          if(action.type==='delegate'){commitAutonomousDelegation(binding,scoped,action.intent);return;}
          if(action.type==='complete'){completeWork(binding,scoped,dispatch,action.summary);return;}
          if(!delivery)return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
          const result=action.type==='aggregate'?aggregateAutonomousResults(binding,scoped,action.intent):action.type==='emit'?emitAutonomousResult(binding,scoped,action.intent):requestAutonomousUser(binding,scoped,action.intent);
          if(result.waiting)return;
          if(!('receiptId' in result)||typeof result.receiptId!=='string')return fail('AUTONOMOUS_AUTHORITY_INVALID');
          const bytes=exposeScopedInput(scoped,compileScopedSource(binding.runId,'message',result.receiptId),'supplement').toString('utf8');
          messages.push({role:'assistant',content:JSON.stringify(call)},{role:'user',content:`【任务工具回执】${bytes}`});continue;
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
  const status=getRun(runId)?.status;
  if(!autonomousExecutionAvailable(runId)||loadRuntimeContract(runId)?.features?.autonomousCollaboration?.delegationVersion!==1||!status||!['running','waiting_for_user'].includes(status))return;
  const terminate=(reason:string)=>commitRunTerminal({runId,status:'failed',disposition:'failed',source:'autonomous_delegation',closeExecution:()=>cancelCollaborationRun(runId),userMessageStatus:'failed',prepare:()=>({reasonCodes:[reason]})});
  try{
    const root=get<{grant_id:string}>('SELECT grant_id FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',runId);if(!root)return;
    assertAutonomousGrantReady(root.grant_id,{allowWaitingForUser:true});
    const rootState=get<{status:string}>('SELECT status FROM runtime_subjects WHERE id=?',loadAutonomousTaskGrant(root.grant_id).subjectId)!.status;
    if(rootState==='failed'||rootState==='cancelled'){terminate('AUTONOMOUS_ROOT_FAILED');return;}
    if(settleRequestedPause(runId))return;
    reconcileAutonomousPauses(runId);
    if(autonomousDeliveryEnabled(runId))reconcileAutonomousDecisions(runId);
    reconcileAutonomousGraph(runId);
    const grant=loadAutonomousTaskGrant(root.grant_id),state=get<{status:string}>('SELECT status FROM runtime_subjects WHERE id=?',grant.subjectId)!.status;
    if(state==='failed'||state==='cancelled'){terminate('AUTONOMOUS_ROOT_FAILED');return;}
    if(state!=='completed'){
      if(autonomousDeliveryEnabled(runId)&&get('SELECT 1 FROM collaboration_user_decisions WHERE run_id=? AND status=\'pending\'',runId)&&!get("SELECT 1 FROM collaboration_dispatches WHERE run_id=? AND status IN ('queued','running')",runId))setRunStatus(runId,'waiting_for_user');
      return;
    }
    noUnknownCalls(runId);
    const snapshot=loadCompletionSnapshot(runId);if(!snapshot)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    const evaluation=evaluateCompletion(snapshot.input);
    if(evaluation.status!=='accepted'){terminate('AUTONOMOUS_COMPLETION_REJECTED');return;}
    commitRunTerminal({runId,status:'completed',disposition:'accepted',source:'autonomous_delegation',userMessageStatus:'responded',prepare:()=>{
      const latest=loadCompletionSnapshot(runId)!;return {completion:{input:latest.input,evaluation:evaluateCompletion(latest.input)},...(autonomousDeliveryEnabled(runId)?{existingAutonomousReportId:prepareAutonomousFinal(runId).messageId}:{})};
    }});
  }catch(error){terminate(error instanceof AutonomousTaskError?error.code:'AUTONOMOUS_RECONCILIATION_FAILED');}
}
