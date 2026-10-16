import { assertReleaseInputs, releaseWorkflow, hasPublishedRelease, storeReleaseDraft, releaseHoldCondition } from './informationRelease.ts';
import { createDurableHold } from '../runtime/holds.ts';
import { setRunStatus } from '../runs/trace.ts';
import { createHash } from 'node:crypto';
import type { AgentDefinition, CollaborationDispatch, MessageAccess, RuntimeControlAction, ScopedControlActionV3 } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { getRun, startSpan, endSpan } from '../runs/trace.ts';
import { post } from '../messaging/inbox.ts';
import { subscribe } from '../messaging/bus.ts';
import { providerForAgent } from '../llm/router.ts';
import type { LlmToolCall, LlmToolSchema } from '../llm/provider.ts';
import { budgetedChat } from '../orchestration/executionBudget.ts';
import { enterMember } from '../execution/memberAdmission.ts';
import { captureExecutionBinding, assertBindingAuthorized, bindingAuthorized } from '../execution/authority.ts';
import { createExecutionScope, assembleScopedContext, compileScopedSource, inputLedgerRevision,
  assertScopedSourceForRecipient, assertScopedOutput, ScopedCollaborationError, type ScopedAttemptBinding } from '../runtime/scopedCollaboration.ts';
import { commitCompleteActionCommand, commitConsultAllActionCommand, commitConsultAnyActionCommand, commitWakeActionCommand, commitHoldActionCommand } from '../runtime/actionCommands.ts';
import { observeAction, observeAggregateLink, observeTechnicalBlock } from '../runtime/shadow.ts';
import { submitCompletionCandidate } from '../runtime/subjectCompletion.ts';
import { settleConsultAnyJoin } from '../runtime/obligations.ts';
import { isAcknowledgementOutput } from '../runtime/exitGuard.ts';
import { createBatch, selectAnyBatchWinner, createDispatch, getBatch, updateBatch, listDispatches, finishAttempt, isActiveAttempt, setAttemptInputContext } from './store.ts';
import { getDeliveryPlan, type DeliveryItem, type DeliveryPlan } from './scopedDelivery.ts';
import { runScopedNativeTurn } from './scopedNativeTurn.ts';

const access = (id:string):MessageAccess => ({visibility:'private',audience:['user',id].sort()});
export class ScopedDeliveryExecutionError extends Error {
  constructor(readonly code:string){super(code);}
}
const fail=(code:string):never=>{throw new ScopedDeliveryExecutionError(code);};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const plannedBatchAction=(items:DeliveryItem[],join:DeliveryPlan['join']='all'):Extract<ScopedControlActionV3,{type:'consult_batch'}>=>({
  version:3,type:'consult_batch',items:items.map(({key,target,payloadRef,expectation})=>({key,target,payloadRef,expectation})),join,returnProfile:'status-only-v1',
});
/** Strict v3 parser. No v2 fallback and no user/model-authored source references. */
export function parseScopedControlCall(call:LlmToolCall, expected:ScopedControlActionV3):ScopedControlActionV3 {
  let value:Record<string,unknown>;
  try {value=JSON.parse(call.input);} catch {return fail('SCOPED_ACTION_INVALID');}
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('SCOPED_ACTION_INVALID');
  const keys=(allowed:string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))fail('SCOPED_ACTION_INVALID');};
  if(expected.type==='consult_batch') {
    keys(['items','join','returnProfile']);
    if(call.name!=='agent.consult_batch'||value.join!==expected.join||value.returnProfile!=='status-only-v1'
      ||!Array.isArray(value.items)||value.items.length!==expected.items.length) return fail('SCOPED_PLAN_MISMATCH');
    const items=value.items.map(i=>{
      if(!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).some(k=>!['key','target','payloadRef','expectation'].includes(k)))return fail('SCOPED_PLAN_MISMATCH');
      return {key:i.key,target:i.target,payloadRef:i.payloadRef,expectation:i.expectation};
    });
    if(!same(items,expected.items))return fail('SCOPED_PLAN_MISMATCH');
    return expected;
  }
  if(expected.type==='acknowledge') {
    keys(['envelopeId']);
    if(call.name!=='agent.acknowledge'||value.envelopeId!==expected.envelopeId)return fail('SCOPED_ACK_MISMATCH');
    return expected;
  }
  keys(['summary']);
  if(call.name!==(expected.type==='request_release'?'agent.request_release':'agent.complete')||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>24_000||isAcknowledgementOutput(value.summary))return fail('SCOPED_RESULT_REQUIRED');
  return {version:3,type:expected.type==='request_release'?'request_release':'complete',summary:value.summary.trim()};
}
export function scopedControlTool(expected:ScopedControlActionV3):LlmToolSchema {
  if(expected.type==='consult_batch')return {name:'agent.consult_batch',description:'按已冻结计划投递这一批独立材料；只能原样提交下面指定的 items、join 和 returnProfile。',parameters:{type:'object',additionalProperties:false,required:['items','join','returnProfile'],properties:{items:{type:'array',minItems:expected.items.length,maxItems:expected.items.length,items:{type:'object',additionalProperties:false,required:['key','target','payloadRef','expectation'],properties:{key:{type:'string'},target:{type:'string'},payloadRef:{type:'string'},expectation:{type:'string',enum:['material','acknowledged','result']}}}},join:{type:'string',enum:[expected.join]},returnProfile:{type:'string',enum:['status-only-v1']}}}};
  if(expected.type==='acknowledge')return {name:'agent.acknowledge',description:'仅确认已接收本信封中的材料，不代表提交业务结果。',parameters:{type:'object',additionalProperties:false,required:['envelopeId'],properties:{envelopeId:{type:'string',enum:[expected.envelopeId]}}}};
  return {name:expected.type==='request_release'?'agent.request_release':'agent.complete',description:expected.type==='request_release'?'提交仅 Owner 与汇总者可见的确切发布草稿，等待专用授权；不会立即发布。':'提交本事项的实质结果；仅回复收到不能完成事项。',parameters:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}}};
}
function batches(plan:DeliveryPlan) {
  return all<{ordinal:number;batch_id:string}>('SELECT ordinal,batch_id FROM scoped_delivery_batches WHERE run_id=? ORDER BY ordinal',plan.runId);
}
function nextItems(plan:DeliveryPlan):DeliveryItem[] {
  const prior=batches(plan);
  if(prior.some(b=>getBatch(b.batch_id)?.status!=='completed'))return fail('SCOPED_PREVIOUS_BATCH_NOT_COMPLETED');
  return plan.items.filter(i=>i.batch===prior.length+1);
}
/** Atomically creates envelope, Batch, Subject obligations and the command receipt. No I/O inside. */
export function commitScopedBatch(input:{plan:DeliveryPlan;dispatch:CollaborationDispatch;attemptId:string;scope:ScopedAttemptBinding & {ledgerRevision:number;outputAccess:MessageAccess};action:Extract<ScopedControlActionV3,{type:'consult_batch'}>}) {
  const {plan,dispatch,attemptId,scope,action}=input;
  return (plan.join==='any'?commitConsultAnyActionCommand:commitConsultAllActionCommand)({runId:plan.runId,commandKey:`scoped:consult:${dispatch.id}`,attemptId,dispatchId:dispatch.id,scope,intentFingerprint:createHash('sha256').update(JSON.stringify(action)).digest('hex'),execute:()=>{
    const items=nextItems(plan);
    if(!items.length||items.length>plan.maxBatchItems||!same(action,plannedBatchAction(items,plan.join)))return fail('SCOPED_PLAN_MISMATCH');
    if(listDispatches(plan.runId).length+items.length+1>plan.maxDispatches)return fail('SCOPED_DISPATCH_LIMIT');
    // Validate ALL references before any effect. Transaction rollback also covers later failures.
    for(const i of items) assertScopedSourceForRecipient(plan.runId,i.source,i.target);
    const batch=createBatch({runId:plan.runId,conversationId:dispatch.conversationId,initiatorAgentId:plan.coordinatorId,
      sourceDispatchId:dispatch.id,question:'已授权独立材料；仅回传固定状态',targetAgentIds:items.map(i=>i.target),joinPolicy:plan.join});
    run('INSERT INTO scoped_delivery_batches VALUES (?,?,?)',plan.runId,items[0]!.batch,batch.id);
    const children=items.map(item=>{
      const child=createDispatch({runId:plan.runId,conversationId:dispatch.conversationId,sourceMessageId:item.source.id,parentDispatchId:dispatch.id,batchId:batch.id,
        kind:'fanout',from:plan.coordinatorId,targetAgentId:item.target,depth:1,idempotencyKey:`scoped:item:${item.key}`});
      run('INSERT INTO scoped_delivery_envelopes VALUES (?,?,?,?)',plan.runId,item.key,child.id,JSON.stringify({version:1,...item,returnProfile:plan.returnProfile,budgetRunId:plan.runId}));
      return child;
    });
    // Explicit domain adapter: wire v3 is validated above. The shared responsibility engine still uses its v2 domain union.
    const domain:RuntimeControlAction={version:2,type:'consult',targetAgentIds:items.map(i=>i.target),objective:'完成信封中指定的交付义务',reason:'Owner 确认的独立投递',join:plan.join};
    observeAction({dispatchId:dispatch.id,attemptId,agentId:plan.coordinatorId,action:domain,childDispatchIds:children.map(c=>c.id),batchId:batch.id});
    finishAttempt({attemptId,dispatchId:dispatch.id,status:'completed',action:domain,output:'已提交当前批次。'});
    return {action,batchId:batch.id,childDispatchIds:children.map(c=>c.id),budgetRunId:plan.runId};
  }});
}
/** The ONLY declassification in G2: exact owner-approved key + fixed state. Never reads child output/error. */
export function reconcileScopedBatch(batchId:string):boolean {
  const batch=getBatch(batchId); if(!batch)return false;
  const plan=getDeliveryPlan(batch.runId); if(!plan)return false;
  tx(()=>{
    const batch=getBatch(batchId)!;
    if(batch.resultDispatchId||batch.status==='cancelled'||getRun(batch.runId)?.status!=='running')return;
    const children=listDispatches(batch.runId).filter(d=>d.batchId===batchId&&d.kind==='fanout');
    if(!children.length||children.some(d=>['queued','running'].includes(d.status)))return;
    commitWakeActionCommand({runId:batch.runId,commandKey:`scoped:wake:${batchId}`,projection:{batchId,planFingerprint:plan.fingerprint},execute:()=>{
      const receipts=children.map(d=>{
        const row=get<{item_key:string}>('SELECT item_key FROM scoped_delivery_envelopes WHERE dispatch_id=? AND run_id=?',d.id,batch.runId);
        const item=plan.items.find(i=>i.key===row?.item_key); if(!item)return fail('SCOPED_ENVELOPE_MISSING');
        const state=d.status==='completed'?item.expectation==='material'?'delivered':item.expectation==='acknowledged'?'acknowledged':'completed':d.status==='cancelled'?'cancelled':'failed';
        return {key:item.key,state};
      });
      const source=post({runId:batch.runId,from:'system',to:plan.coordinatorId,kind:'system',messageType:'collaboration_routing',...access(plan.coordinatorId),
        body:JSON.stringify({version:1,returnProfile:plan.returnProfile,receipts}),meta:{scopedInternal:true},clientMessageId:`scoped:return:${batchId}`});
      const resume=createDispatch({runId:batch.runId,conversationId:batch.conversationId,sourceMessageId:source.id,parentDispatchId:batch.sourceDispatchId,batchId,kind:'aggregate',from:'system',targetAgentId:plan.coordinatorId,depth:0,idempotencyKey:`aggregate:${batchId}`});
      const success=batch.joinPolicy==='any'?!!batch.winnerDispatchId&&children.some(c=>c.id===batch.winnerDispatchId&&c.status==='completed'):children.every(c=>c.status==='completed');
      if(batch.joinPolicy==='any'&&!success)settleConsultAnyJoin({runId:batch.runId,batchId,status:'failed',resolutionSourceId:`scoped-any-exhausted:${batchId}`,resolution:{reason:'all_candidates_failed'}});
      updateBatch(batchId,success?'completed':'failed',resume.id);
      observeAggregateLink(batch.sourceDispatchId,resume.id);
      return {dispatchId:resume.id,receipts};
    }});
  });
  return true;
}
export async function executeScopedDispatch(dispatch:CollaborationDispatch,attemptId:string,agent:AgentDefinition):Promise<string|null> {
  const plan=getDeliveryPlan(dispatch.runId)!;
  let release:(()=>void)|undefined;
  let span:ReturnType<typeof startSpan>|undefined;
  const controller=new AbortController();
  const unsubscribe=subscribe(()=>{if(!isActiveAttempt(attemptId,dispatch.id))controller.abort();});
  try {
    assertReleaseInputs(plan.runId);
    const releaseTask=releaseWorkflow(plan.runId);
    if(agent.execution?.kind==='external'&&!['claude-sdk','codex-app-server'].includes(agent.execution.driver))fail('BACKEND_SCOPE_UNSUPPORTED');
    const binding=captureExecutionBinding(plan.runId,agent.id,attemptId);
    const row=get<{subject_id:string;generation:number}>('SELECT s.subject_id,c.generation FROM runtime_dispatch_subjects s JOIN runtime_custody c ON c.subject_id=s.subject_id WHERE s.dispatch_id=?',dispatch.id)!;
    const envelope=get<{record:string}>('SELECT record FROM scoped_delivery_envelopes WHERE dispatch_id=?',dispatch.id);
    const item:DeliveryItem|null=envelope?JSON.parse(envelope.record):null;
    if(item && (item.target!==agent.id||item.source.id!==dispatch.sourceMessageId))fail('SCOPED_ENVELOPE_MISMATCH');
    if(!item&&agent.id!==plan.coordinatorId)fail('SCOPED_PLAN_MISMATCH');
    const next=item?[]:nextItems(plan);
    const expected:ScopedControlActionV3=item?.expectation==='acknowledged'?{version:3,type:'acknowledge',envelopeId:item.payloadRef}
      :!item&&next.length?plannedBatchAction(next,plan.join):{version:3,type:item&&releaseTask?'request_release':'complete',summary:''};
    const instruction=item?`这是一个独立事项，仅使用本上下文中的材料。交付要求：${item.expectation}。${item.expectation==='acknowledged'?`请调用 agent.acknowledge，envelopeId=${item.payloadRef}`:releaseTask?'请以 agent.request_release 提交完整私密汇总草稿，等待 Owner 授权。':'请以 agent.complete 提交完整结果。'}`
      :`你是独立材料组织者，只能按确认的计划推进。不得请求或推测私密正文。${next.length?'本轮唯一允许的动作（工具参数不含 version/type）：'+JSON.stringify(expected):'所有已授权批次完成。请调用 agent.complete，说明固定状态核对完成。'}`;
    const directive=post({runId:plan.runId,from:'system',to:agent.id,kind:'system',body:instruction,meta:{scopedInternal:true},...access(agent.id),clientMessageId:`scoped:instruction:${attemptId}`});
    const scope=createExecutionScope({runId:plan.runId,subjectId:row.subject_id,agentId:agent.id,kind:item?'content':'control',defaultOutputAccess:access(agent.id),recoveryGeneration:row.generation,
      objective:item?.source??compileScopedSource(plan.runId,'message',dispatch.sourceMessageId),inputs:[plan.roleSources[agent.id]!,compileScopedSource(plan.runId,'message',directive.id)]});
    const scoped={runId:plan.runId,scopeId:scope.id,attemptId,agentId:agent.id};
    const context=assembleScopedContext(scoped);
    setAttemptInputContext(attemptId,context);
    const outputBinding={...scoped,ledgerRevision:inputLedgerRevision(attemptId),outputAccess:access(agent.id)};
    if(!item && !next.length && releaseTask && !hasPublishedRelease(plan.runId)) {
      const domain:RuntimeControlAction={version:2,type:'hold',wake:{kind:'user_decision',decisionKind:'agent_question',prompt:'请在专用发布卡中批准并发布，普通回答不会授权。'},reason:'等待专用发布授权'};
      commitHoldActionCommand({runId:plan.runId,commandKey:`release:hold:${dispatch.id}`,attemptId,dispatchId:dispatch.id,scope:outputBinding,execute:()=>{
        assertReleaseInputs(plan.runId);
        observeAction({dispatchId:dispatch.id,attemptId,agentId:agent.id,action:domain,childDispatchIds:[],batchId:null});
        createDurableHold({runId:plan.runId,sourceDispatchId:dispatch.id,sourceAttemptId:attemptId,holderAgentId:agent.id,
          condition:releaseHoldCondition(plan.runId),timeoutAt:plan.deadlineAt,onTimeout:{kind:'fail',reason:'发布等待已超过任务时限'},
          recoveryPolicy:{kind:'resume_dispatch',targetAgentId:agent.id,sourceMessageId:directive.id,parentDispatchId:dispatch.id,depth:0,reason:'专用授权发布已完成'},idempotencyKey:`release:hold:${plan.runId}`});
        finishAttempt({attemptId,dispatchId:dispatch.id,status:'completed',action:domain,output:'等待 Owner 在专用发布卡操作。'});
        setRunStatus(plan.runId,'waiting_for_user');
        return {waitingFor:'information-release-v1'};
      }});
      return null;
    }
    let action:ScopedControlActionV3;
    if(!item&&!next.length&&plan.join==='any')action={version:3,type:'complete',summary:'只读批次已选出有效结果，固定状态核对完成。'};
    else if(item?.expectation==='material')action={version:3,type:'complete',summary:'材料已投递至该事项的独立上下文。'};
    else {
      release=await enterMember({runId:plan.runId,agentId:agent.id,attemptId,scope:`collaboration:${dispatch.id}`,signal:controller.signal,authorized:()=>bindingAuthorized(binding)});
      assertBindingAuthorized(binding); assertScopedOutput(outputBinding);
      span=startSpan(plan.runId,{spanKind:'llm',name:`scoped:${agent.id}`,input:context,attributes:{'agent.id':agent.id,'collaboration.attempt.id':attemptId,'collaboration.dispatch.id':dispatch.id}});
      if(agent.execution?.kind==='external') {
        action=await runScopedNativeTurn({binding:scoped,agent,context,parentSpanId:span.id,tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected),signal:controller.signal});
        endSpan(span,{output:'范围动作候选已校验',usageKnown:false,costKnown:false});span=undefined;
      } else {
      const response=await budgetedChat(plan.runId,providerForAgent(agent,plan.runId),{model:agent.model,messages:[{role:'system',content:'严格遵循本事项的独立材料边界。使用所提供的唯一控制工具结束本轮。'},{role:'user',content:context}],tools:[scopedControlTool(expected)],maxTokens:Math.min(4096,plan.maxTokens),signal:controller.signal},undefined,agent.id,attemptId);
      endSpan(span,{tokensIn:response.usage.tokensIn,tokensOut:response.usage.tokensOut,costUsd:response.usage.costUsd,usageKnown:response.usage.outputKnown!==false,costKnown:response.usage.costKnown!==false});span=undefined;
      assertBindingAuthorized(binding);
      if(response.truncated||response.toolCalls.length!==1)fail('SCOPED_EXPLICIT_ACTION_REQUIRED');
      action=parseScopedControlCall(response.toolCalls[0]!,expected);
      }
    }
    assertBindingAuthorized(binding);
    if(action.type==='consult_batch')return commitScopedBatch({plan,dispatch,attemptId,scope:outputBinding,action}).result.batchId;
    const summary=item? action.type==='acknowledge'?'已确认收到本信封材料。':action.summary:'所有已授权事项的交付状态已核对完成。';
    const domain:RuntimeControlAction={version:2,type:'complete',summary};
    commitCompleteActionCommand({runId:plan.runId,commandKey:`scoped:complete:${dispatch.id}`,attemptId,dispatchId:dispatch.id,scope:outputBinding,intentFingerprint:createHash('sha256').update(JSON.stringify(action)).digest('hex'),execute:()=>{
      assertReleaseInputs(plan.runId);
      if(item && releaseTask) {if(action.type!=='request_release')fail('SCOPED_RELEASE_REQUIRED');storeReleaseDraft(plan.runId,attemptId,summary);}
      const result=submitCompletionCandidate({runId:plan.runId,dispatchId:dispatch.id,attemptId,agentId:agent.id,action:domain,summary,evidenceRefs:[{kind:'attempt_output',id:attemptId}],exitGuard:{status:'allow_candidate',reasons:[item?.expectation==='material'?'DELIVERY_MATERIAL_VALIDATED':action.type==='acknowledge'?'DELIVERY_ACK_VALIDATED':'EXPLICIT_COMPLETE']},retryAllowed:false});
      if(result.evaluation.status!=='accepted')return fail('SCOPED_COMPLETION_REJECTED');
      if(dispatch.kind==='fanout'&&dispatch.batchId&&plan.join==='any') {
        const batch=getBatch(dispatch.batchId)!;
        if(plan.recoveryVersion!==1||!selectAnyBatchWinner({batchId:batch.id,dispatchId:dispatch.id,expectedGeneration:batch.generation,candidateId:result.candidate.id}).selected)fail('SCOPED_ANY_NOT_SELECTED');
      }
      const message=post({runId:plan.runId,from:agent.id,to:'user',kind:'agent',messageType:'collaboration_contribution',body:summary,attemptId,...access(agent.id)});
      finishAttempt({attemptId,dispatchId:dispatch.id,status:'completed',action:domain,output:summary,outputMessageId:message.id});
      return {action:action.type==='complete'||action.type==='request_release'?{version:3,type:action.type}:action,candidateId:result.candidate.id,outputMessageId:message.id};
    }});
    return null;
  } catch(error) {
    // Private provider errors and model text never enter the parent receipt or general diagnostics.
    const code=error instanceof ScopedDeliveryExecutionError||error instanceof ScopedCollaborationError?error.code:'SCOPED_EXECUTION_FAILED';
    if(span)endSpan(span,{status:'error',output:code,usageKnown:false,costKnown:false});
    if(isActiveAttempt(attemptId,dispatch.id))tx(()=>{
      observeTechnicalBlock(dispatch.id,attemptId,agent.id);
      finishAttempt({attemptId,dispatchId:dispatch.id,status:'failed',dispatchStatus:'blocked',error:code});
    });
    return null;
  } finally {unsubscribe();release?.();}
}
