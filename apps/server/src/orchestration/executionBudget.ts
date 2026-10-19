import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_COORDINATION_STEP_TOKENS } from '@agent-gand/shared';
import { reconcileModelCallReservations } from './modelCallRecovery.ts';
import { queueModelCall, startModelCall, finishModelCall, modelCallWaiting } from './modelCalls.ts';
import { get, run, tx } from '../db/database.ts';
import type { LlmRequest, LlmResponse, DeltaHandler, LLMProvider } from '../llm/provider.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { withActivityTimeout } from '../execution/activityTimeout.ts';
import { ExecutionError } from '../execution/errors.ts';
import { assertBusinessStageDeadline, businessStageContext } from './businessStageExecution.ts';
import { reserveCost, settleCost, type CostReservationRow } from './costBudget.ts';
import {loadAutonomousTaskPolicy} from '../runtime/autonomousPolicy.ts';
import {assertAutonomousModelAdmission} from '../runtime/autonomousExecution.ts';
import { acquireLegacyModelCall, runWithLegacyProviderEvidence } from '../execution/resources/legacy.ts';
const modelCallContext=new AsyncLocalStorage<string>();
const modelCallHooks=new AsyncLocalStorage<{onStarted?:()=>void;onFinished?:()=>void;onWaiting?:()=>void}>();
export class ModelAdmissionPausedError extends Error {constructor(){super('用户请求暂停，尚未发出的模型请求保留在队列。');}}
function throwIfStopped(runId:string,signal?:AbortSignal):void {
  if(signal?.aborted)throw signal.reason??new Error('执行已停止');
  const status=get<{status:string}>('SELECT status FROM runs WHERE id=?',runId)?.status;
  if(status&&['completed','failed','cancelled'].includes(status))throw new Error('任务已结束，停止后续模型调用');
  if(get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_extract(payload,'$.features.autonomousCollaboration.rolloutVersion')=1",runId)&&get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND pause_requested=1',runId))throw new ModelAdmissionPausedError();
  if(executionPolicy(runId)?.request.businessContract?.version===3&&get("SELECT 1 FROM coordination_plans WHERE run_id=? AND status='pause_requested'",runId))throw new ModelAdmissionPausedError();
  assertExecutionDeadline(runId);assertBusinessStageDeadline();
}
export async function reserveCostWhenReady(runId:string,agentId:string,model:string,backend:string,request?:LlmRequest,signal?:AbortSignal,callId?:string,onWaiting?:()=>void):Promise<CostReservationRow|null> {
  for(;;){throwIfStopped(runId,signal);try{return reserveCost(runId,agentId,model,backend,request,callId);}catch(error){if((error as {code?:string}).code!=='COST_BUDGET_RESERVED'||(executionPolicy(runId)?.request.businessContract?.version!==3&&!loadAutonomousTaskPolicy(runId)&&!get('SELECT 1 FROM scoped_delivery_plans WHERE run_id=?',runId)))throw error;if(callId)modelCallWaiting(callId,'cost');(onWaiting??modelCallHooks.getStore()?.onWaiting)?.();await new Promise(resolve=>setTimeout(resolve,25));}}
}

export function executionPolicy(runId: string) {
  const frozen = getRunOrchestrationSnapshot(runId);
  return frozen?.executionAuthority === 'orchestration' ? frozen : null;
}
export function assertExecutionDeadline(runId: string): void {
  const deadline = loadAutonomousTaskPolicy(runId)?.budget.deadlineAt ?? executionPolicy(runId)?.execution?.deadlineAt ?? get<{deadline:string}>("SELECT json_extract(record,'$.deadlineAt') deadline FROM scoped_delivery_plans WHERE run_id=?",runId)?.deadline;
  if (deadline && Date.now() >= Date.parse(deadline)) throw new ExecutionError('timeout', '本轮任务已超过截止时间', { phase: 'deadline', timeoutKind: 'total' });
}

async function modelChat(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler): Promise<LlmResponse> {
  const policy = executionPolicy(runId);
  const stageSignal = businessStageContext()?.signal;
  const signal = request.signal && stageSignal ? AbortSignal.any([request.signal, stageSignal]) : request.signal ?? stageSignal;
  const modelActivity: { firstResponseAt?: string; lastActivityAt?: string } = {};
  const trustedActivity = () => {
    const at = new Date().toISOString();
    modelActivity.firstResponseAt ??= at; modelActivity.lastActivityAt = at;
  };
  const scopedLimits=get<{limits:string}>("SELECT json_extract(record,'$.requestLimits') limits FROM scoped_delivery_plans WHERE run_id=?",runId);
  const autonomous=loadAutonomousTaskPolicy(runId);
  const callId = modelCallContext.getStore();
  if (!callId) throw new Error('MODEL_CALL_RESOURCE_CONTEXT_REQUIRED');
  const resource = await acquireLegacyModelCall(callId, signal);
  let invoked = false;
  try { return await withActivityTimeout({ ...(scopedLimits ? JSON.parse(scopedLimits.limits) : {}), ...policy?.request.constraints,
    ...(autonomous?{firstResponseTimeoutMs:autonomous.budget.firstResponseTimeoutMs,idleTimeoutMs:autonomous.budget.idleTimeoutMs}:{}),signal, deadlineAt:autonomous?.budget.deadlineAt ?? policy?.execution?.deadlineAt ?? get<{deadline:string}>("SELECT json_extract(record,'$.deadlineAt') deadline FROM scoped_delivery_plans WHERE run_id=?",runId)?.deadline },
    (signal, activity) => {throwIfStopped(runId,signal);return runWithLegacyProviderEvidence(resource, callId, () => {
      throwIfStopped(runId,signal);startModelCall(callId);modelCallHooks.getStore()?.onStarted?.();return provider.chat({ ...request, signal, onActivity: kind => {
      if (!signal.aborted) { trustedActivity(); activity(); request.onActivity?.(kind); }
    } }, text => { if (!signal.aborted && text) { trustedActivity(); activity(); delta?.(text); } }); }, () => { invoked = true; });}); }
  catch (error) {
    if (invoked) resource.unknown();
    if (error instanceof ExecutionError) throw new ExecutionError(error.code, error.message, { ...error.details, modelActivity });
    throw error;
  } finally { if (!invoked) resource.release({ reason: 'not_started', sideEffects: 'none' }); }
}

/** Reserve before I/O so concurrent branches cannot spend the same allowance. Unknown calls retain their reservation. */
export async function budgetedChat(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler, agentId = '',attemptId?:string,hooks?:{onStarted?:()=>void;onFinished?:()=>void;onWaiting?:()=>void}): Promise<LlmResponse> {
  if (!agentId) {
    const saved = get<{ agent_ids: string }>('SELECT agent_ids FROM runs WHERE id=?', runId);
    const agents: unknown = saved ? JSON.parse(saved.agent_ids) : null;
    if (!Array.isArray(agents) || agents.length !== 1 || typeof agents[0] !== 'string') throw new Error('MODEL_CALL_AGENT_REQUIRED');
    agentId = agents[0];
  }
  const autonomous=assertAutonomousModelAdmission(runId,agentId,attemptId,request.model,'builtin-llm');
  // Revoked authority cannot stream late content. Let the request finish accounting
  // for known supplier usage, then reject the result under the current authority.
  const guardedDelta:DeltaHandler|undefined=autonomous&&delta?text=>{
    try{assertAutonomousModelAdmission(runId,agentId,attemptId,request.model,'builtin-llm');}catch{return;}
    delta(text);
  }:delta;
  const id=queueModelCall(runId,agentId,request.model,'builtin-llm',attemptId);
  try{
    const response=await modelCallHooks.run(hooks??{},()=>modelCallContext.run(id,()=>budgetedChatImpl(runId,provider,request,guardedDelta,agentId)));
    finishModelCall(id,true);
    if(autonomous)assertAutonomousModelAdmission(runId,agentId,attemptId,request.model,'builtin-llm',{allowPause:true});
    return response;
  }catch(error){reconcileModelCallReservations(id);finishModelCall(id,false);throw error;}finally{hooks?.onFinished?.();}
}
async function budgetedChatImpl(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler, agentId = ''): Promise<LlmResponse> {
  const autonomous=loadAutonomousTaskPolicy(runId);
  if(autonomous)request={...request,maxTokens:Math.min(request.maxTokens??autonomous.budget.maxTokensPerCall,autonomous.budget.maxTokensPerCall)};
  const limit = autonomous?.budget.maxOutputTokens ?? executionPolicy(runId)?.request.constraints.maxTokens
    ?? get<{ max_tokens: number }>('SELECT max_tokens FROM scoped_delivery_plans WHERE run_id=?',runId)?.max_tokens;
  const stage = businessStageContext();
  if (stage && stage.runId !== runId) throw new Error('阶段预算与 Run 不一致');
  assertExecutionDeadline(runId); assertBusinessStageDeadline();
  const scopes = [
    ...(limit ? [{ table: 'orchestration_token_reservations', limit, where: 'run_id=?', params: [runId], label: '本轮' }] : []),
    ...(stage?.maxTokens ? [{ table: 'business_stage_token_reservations', limit: stage.maxTokens, where: 'run_id=? AND stage_id=?', params: [runId, stage.stageId], label: '当前阶段' }] : []),
  ];
  if (!scopes.length) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('执行已停止');
    const cost = await reserveCostWhenReady(runId, agentId, request.model, 'builtin-llm', request,request.signal,modelCallContext.getStore());
    try { const response = await modelChat(runId, provider, request, delta); settleCost(cost, response.usage); return response; }
    catch (error) { reconcileModelCallReservations(modelCallContext.getStore()!); throw error; }
  }
  const desired = Math.max(1, Math.min(...scopes.map(s => s.limit), request.maxTokens ?? DEFAULT_COORDINATION_STEP_TOKENS));
  let reservation: { id: string; tokens: number; cost: CostReservationRow | null } | undefined;
  while (!reservation) {
    throwIfStopped(runId,request.signal);
    if(autonomous){const call=get<{attempt_id:string}>('SELECT attempt_id FROM orchestration_model_calls WHERE id=?',modelCallContext.getStore()!);assertAutonomousModelAdmission(runId,agentId,call?.attempt_id,request.model);}
    try{reservation = tx(() => {
      let available = desired;
      let waiting = false;
      for (const scope of scopes) {
        const budget = get<{ charged: number; pending: number; unknown: number }>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknown
          FROM ${scope.table} WHERE ${scope.where}`, ...scope.params)!;
        if (budget.unknown) throw new Error(`${scope.label}模型调用消耗未知，预算已保留；不能自动重发`);
        const remaining = scope.limit - budget.charged;
        if (remaining <= 0) { if (budget.pending) waiting = true; else throw new Error(`${scope.label}输出 Token 预算已耗尽`); }
        available = Math.min(available, remaining);
      }
      if (waiting) {const id=modelCallContext.getStore();if(id)modelCallWaiting(id,'tokens');modelCallHooks.getStore()?.onWaiting?.();return undefined;}
      const id = modelCallContext.getStore()!, tokens = available, now = new Date().toISOString();
      for (const scope of scopes) {
        if (scope.table === 'business_stage_token_reservations') run('INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,?,?,?)', id, runId, stage!.stageId, tokens, 'pending', now);
        else run('INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,?,?)', id, runId, tokens, 'pending', now);
      }
      const cost = reserveCost(runId, agentId, request.model, 'builtin-llm', { ...request, maxTokens: tokens }, id);
      return { id, tokens, cost };
    });}catch(error){if((error as {code?:string}).code!=='COST_BUDGET_RESERVED'||(executionPolicy(runId)?.request.businessContract?.version!==3&&!loadAutonomousTaskPolicy(runId)&&!get('SELECT 1 FROM scoped_delivery_plans WHERE run_id=?',runId)))throw error;const id=modelCallContext.getStore();if(id)modelCallWaiting(id,'cost');modelCallHooks.getStore()?.onWaiting?.();}
    if (!reservation) await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    const response = await modelChat(runId, provider, { ...request, maxTokens: reservation.tokens }, delta);

    const count = response.usage?.tokensOut;
    // Missing usage conservatively consumes the whole reservation.
    const usageKnown = response.usage.outputKnown !== false && Number.isFinite(count) && count >= 0;
    const used = usageKnown ? Math.ceil(count) : reservation.tokens;
    tx(() => { settleCost(reservation!.cost, response.usage); for (const scope of scopes) run(`UPDATE ${scope.table} SET used=?,status=? WHERE id=? AND status='pending'`, used, usageKnown ? 'settled' : 'unknown', reservation!.id); });
    if (used > reservation.tokens) throw new Error('模型服务超过所请求的输出预算，停止后续调用');
    return response;
  } catch (error) {
    reconcileModelCallReservations(reservation.id);
    throw error;
  }
}
