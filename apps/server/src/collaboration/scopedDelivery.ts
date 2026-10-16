import { createHash, randomUUID } from 'node:crypto';
import type { ScopedDeliveryDraft, ScopedDeliveryPreview, ScopedDeliveryStatus, ScopedSourceRef, CollaborationBudgetLimits, CostPolicy } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { config } from '../config.ts';
import { getConversation, nextTurnNo, touchConversation } from '../conversations/service.ts';
import { getAgent } from '../agents/registry.ts';
import { createRun, getRun, listRunAgentSnapshots, setRunStatus } from '../runs/trace.ts';
import { sealManagedContent, openManagedContent } from '../accounts/credentials.ts';
import { object, assertFields } from '../accounts/validation.ts';
import { AccountError } from '../accounts/errors.ts';
import { normalizeCostPolicy } from '../orchestration/costPolicy.ts';
import { costBudgetState } from '../orchestration/costBudget.ts';
import { resolveAccount } from '../accounts/resolver.ts';
import { post } from '../messaging/inbox.ts';
import { compileScopedSource } from '../runtime/scopedCollaboration.ts';
import { planCollaborationAdmission } from '../runtime/subjectContract.ts';
import { executionPolicyForProfile } from '../runtime/runPolicy.ts';
import { freezeRuntimeContract } from '../runtime/controlAction.ts';
import { observeAdmission } from '../runtime/shadow.ts';
import { createDispatch } from './store.ts';

export interface DeliveryItem extends Omit<ScopedDeliveryDraft['items'][number], 'material'> {
  payloadRef: string; source: ScopedSourceRef;
}
export interface DeliveryPlan {
  version: 1; runId: string; coordinatorId: string; fingerprint: string; goal: string;
  costPolicy: CostPolicy | null;
  requestLimits: { firstResponseTimeoutMs?: number; idleTimeoutMs?: number };
  limits: CollaborationBudgetLimits; deadlineAt: string;
  maxTokens: number; maxBatchItems: number; maxDispatches: number; items: DeliveryItem[];
  roleSources: Record<string, ScopedSourceRef>;
  returnProfile: 'status-only-v1'; join: 'all' | 'any';
  recoveryVersion?: 1;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new AccountError(400, message); };
const text = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(`${label}不能为空且最多 ${max} 字符`);
  return value.trim();
};
function roomCostPolicy(conversationId:string):CostPolicy|null {
  const raw=getConversation(conversationId)?.preferences?.constraints.costPolicy;
  if(!raw)return null;
  try{return normalizeCostPolicy(raw);}catch{throw new AccountError(400,'房间费用政策无效，请先修正房间默认设置');}
}
export function validateDeliveryDraft(value: unknown): ScopedDeliveryDraft {
  if(config.orchestrationRollout.entryMode==='closed'||!config.orchestrationRollout.enabledDrivers.includes('builtin-llm')) throw new AccountError(503,'独立材料协作入口当前未开放');
  const v = object(value);
  assertFields(v, ['conversationId','coordinatorId','goal','join','returnProfile','maxTokens','items']);
  if (!['all','any'].includes(String(v.join)) || v.returnProfile !== 'status-only-v1') invalid('仅支持 all / 只读 any 和已授权的固定状态返回');
  const conversationId = text(v.conversationId, 100, '聊天室'), coordinatorId = text(v.coordinatorId, 100, '组织者');
  const room = getConversation(conversationId);
  if (!room || room.archivedAt) invalid('聊天室不存在或已归档');
  if (room!.preferencesIssue) invalid('房间默认偏好损坏，请先修正；不能跳过其中的预算限制');
  if (!Array.isArray(v.items) || !v.items.length || v.items.length > 6) invalid('请提供 1–6 份独立材料');
  const items = (v.items as unknown[]).map(item => {
    const i = object(item); assertFields(i, ['key','target','batch','material','expectation']);
    const key = text(i.key, 40, '材料编号');
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) invalid('材料编号仅允许字母、数字、横线和下划线');
    if (![1,2].includes(Number(i.batch)) || !Number.isInteger(i.batch)) invalid('批次必须为 1 或 2');
    if (!['material','acknowledged','result'].includes(String(i.expectation))) invalid('请选择有效的交付要求');
    return { key, target: text(i.target, 100, '接收者'), batch: Number(i.batch), material: text(i.material, 12_000, '独立材料'), expectation: i.expectation as DeliveryItem['expectation'] };
  });
  if (v.join === 'any' && items.some(i => i.batch !== 1)) invalid('只读 any 当前支持单批次，其他批次请使用全部满足');
  if (v.join === 'any' && items.some(i => i.expectation !== 'result')) invalid('只读 any 的每个事项都必须提交实际结果');
  if (new Set(items.map(i => i.key)).size !== items.length) invalid('材料编号不能重复');
  const max = Math.min(3, config.collaboration.maxTargets);
  if (!items.some(i => i.batch === 1)) invalid('计划必须从第一批开始');
  for (const b of [1,2]) {
    const group = items.filter(i => i.batch === b);
    if (group.length > max || new Set(group.map(i => i.target)).size !== group.length) invalid(`每批最多 ${max} 项，同批每位接收者只能有一个事项`);
  }
  const dispatches = items.length + new Set(items.map(i => i.batch)).size + 1;
  if (dispatches > config.collaboration.maxDispatches) invalid('计划超出派发上限');
  if (!Number.isSafeInteger(v.maxTokens) || Number(v.maxTokens) < 256 || Number(v.maxTokens) > config.collaboration.maxTokens) invalid(`输出 Token 预算须在 256–${config.collaboration.maxTokens} 之间`);
  for (const id of new Set([coordinatorId, ...items.map(i => i.target)])) {
    const agent = getAgent(id);
    if (!room!.agentIds.includes(id) || !agent?.enabled) invalid('选择的成员不在当前聊天室或已停用');
    if ((agent!.execution?.kind ?? 'builtin-llm') !== 'builtin-llm') invalid('当前独立材料协作仅开放模型 API；Claude SDK / Codex 的 G5 隔离验收尚未完成，不能仅凭账户连接测试放行');
    if (agent!.systemPrompt.length > 6_000) invalid('角色提示词超过独立上下文限制（6000 字符）');
    resolveAccount(agent!); // validate configuration without making a model request
  }
  const cost=roomCostPolicy(conversationId);
  if(cost?.mode==='strict')invalid('当前模型 API 不能保证供应商账单硬上限，严格费用政策下禁止派发');
  if(cost?.unknownAction==='stop')for(const id of new Set([coordinatorId,...items.filter(i=>i.expectation!=='material').map(i=>i.target)])) {
    const price=cost.prices.find(p=>p.agentId===id&&p.model===getAgent(id)!.model);
    if(!price||price.otherCharges!=='none')invalid('房间费用政策要求已知价格，请先为所有实际调用成员配置完整的模型价格');
  }
  return { conversationId, coordinatorId, goal: text(v.goal, 2000, '组织目标'), join: v.join as 'all' | 'any', returnProfile: 'status-only-v1', maxTokens: Number(v.maxTokens), items };
}
function fingerprint(draft: ScopedDeliveryDraft) {
  const roles = [...new Set([draft.coordinatorId,...draft.items.map(i => i.target)])].sort().map(id => {
    const agent = getAgent(id)!;
    return [agent, agent.accountRef ? get('SELECT version,config_version,credential_version,enabled,archived FROM accounts WHERE id=?', agent.accountRef) : null];
  });
  return digest({ draft, costPolicy:roomCostPolicy(draft.conversationId), membersVersion: getConversation(draft.conversationId)!.membersVersion, roles,
    maxBatchItems: config.collaboration.maxTargets, maxDispatches: config.collaboration.maxDispatches });
}
export function previewScopedDelivery(value: unknown, owner: string): ScopedDeliveryPreview {
  const draft = validateDeliveryDraft(value), id = randomUUID(), fp = fingerprint(draft);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  run('INSERT INTO scoped_delivery_previews(id,owner,fingerprint,payload,expires_at) VALUES (?,?,?,?,?)',
    id, owner, fp, sealManagedContent(Buffer.from(JSON.stringify(draft)), `scoped-preview:${id}:${fp}`), expiresAt);
  return { id, fingerprint: fp, expiresAt, draft, costPolicy:roomCostPolicy(draft.conversationId), maxBatchItems: Math.min(3,config.collaboration.maxTargets),
    maxDispatches: draft.items.length + new Set(draft.items.map(i => i.batch)).size + 1,
    disclosure: (draft.join==='any'?'每批首个通过验收的结果胜出，其他项停止；已发出的请求仍可能计费。所有事项仅调用文本模型，不开放工具。':'每批全部满足后继续。') + '组织者只收到已授权的事项编号与固定状态（delivered、acknowledged、completed、failed、cancelled）。各项材料和结果仅 Owner 与该接收者可见；按确认的批次完成条件推进，无法满足时停止。仅处理表单文字，不读取房间历史、文件或原生会话。' };
}
/** Confirm is pure durable admission. The route kicks the existing scheduler AFTER this commits. */
export function confirmScopedDelivery(value: unknown, owner: string, releaseVersion?: 1): string {
  const v = object(value); assertFields(v, ['previewId','fingerprint','clientKey']);
  const id = text(v.previewId,100,'预览'), fp = text(v.fingerprint,64,'指纹'), key = text(v.clientKey,100,'提交编号');
  return tx(() => {
    const row = get<{ owner: string; fingerprint: string; payload: string; expires_at: string; run_id: string | null; client_key: string | null }>('SELECT * FROM scoped_delivery_previews WHERE id=?', id);
    if (!row || row.owner !== owner || row.fingerprint !== fp) throw new AccountError(409,'预览不存在、已改变或不属于当前管理会话，请重新预览');
    if (row.run_id) { if (row.client_key !== key) throw new AccountError(409,'该预览已提交，不能更换提交编号'); return row.run_id; }
    if (get('SELECT 1 FROM scoped_delivery_previews WHERE client_key=?',key)) throw new AccountError(409,'提交编号已用于其他预览');
    if(config.orchestrationRollout.entryMode!=='execute') throw new AccountError(503,'入口当前仅允许预览');
    if (Date.parse(row.expires_at) <= Date.now()) throw new AccountError(409,'预览已过期，请重新预览');
    const draft = validateDeliveryDraft(JSON.parse(openManagedContent(row.payload,`scoped-preview:${id}:${fp}`).toString()));
    if (fingerprint(draft) !== fp) throw new AccountError(409,'成员、账户或配置已改变，请重新预览');
    if(releaseVersion && draft.items.length+new Set(draft.items.map(i=>i.batch)).size+2>config.collaboration.maxDispatches) throw new AccountError(400,'私密汇总与发布恢复超出派发上限');
    const agentIds = [...new Set([draft.coordinatorId,...draft.items.map(i => i.target)])];
    const task = createRun(draft.goal, 'collaboration', agentIds, null, null, draft.conversationId, nextTurnNo(draft.conversationId));
    setRunStatus(task.id,'running');
    const planned = planCollaborationAdmission({ runId:task.id,objective:'按已授权计划逐项交付并核对状态',participantIds:agentIds,
      targetAgentIds:[draft.coordinatorId],completionEngine:true,completionCandidateVersion:1,successorObligationVersion:1,messageVisibilityVersion:1,
      evidenceBundleVersion:1,contextContributorVersion:1,durableHoldVersion:2,...(draft.join==='any'?{consultAnyVersion:1 as const}:{}),exitGuard:{version:1,maxCorrections:0,correctionMaxTokens:512},
      executionPolicy:{...executionPolicyForProfile('execute'),toolApiVersion:3,implicitAnswerPolicy:'explicit_only'} });
    planned.contract.features!.controlActionVersion=3;
    planned.contract.features!.scopedCollaboration={boundaryVersion:2,manifestVersion:1,provenanceVersion:1,policyRevision:1,capabilityPackage:releaseVersion?'scoped-release-v1':'scoped-control-v1',deliveryVersion:1,recoveryVersion:1,...(releaseVersion?{releaseVersion}: {})};
    freezeRuntimeContract(planned.contract);
    post({runId:task.id,from:'user',to:'all',kind:'user',body:'独立材料协作：按已确认计划逐批交付。',visibility:'private',audience:['user',...agentIds],deliveryStatus:'processing'});
    const source = post({runId:task.id,from:'user',to:draft.coordinatorId,kind:'system',body:draft.goal,visibility:'private',audience:['user',draft.coordinatorId]});
    const roleSources: Record<string,ScopedSourceRef> = {};
    for(const agent of listRunAgentSnapshots(task.id)) {
      const role=post({runId:task.id,from:'system',to:agent.id,kind:'system',body:agent.systemPrompt,meta:{scopedInternal:true},visibility:'private',audience:['user',agent.id]});
      roleSources[agent.id]=compileScopedSource(task.id,'message',role.id);
    }
    const items = draft.items.map(i => {
      const {material,...rest}=i;
      const source = post({runId:task.id,from:'user',to:i.target,kind:'system',body:material,visibility:'private',audience:['user',i.target]});
      return {...rest,payloadRef:randomUUID(),source:compileScopedSource(task.id,'message',source.id)};
    });
    const constraints=getConversation(draft.conversationId)!.preferences?.constraints;
    const duration=Math.min(constraints?.deadlineMs??config.collaboration.runTimeoutMs,config.collaboration.runTimeoutMs);
    const plan: DeliveryPlan={requestLimits:{firstResponseTimeoutMs:constraints?.firstResponseTimeoutMs,idleTimeoutMs:constraints?.idleTimeoutMs},costPolicy:roomCostPolicy(draft.conversationId),limits:{maxDispatches:config.collaboration.maxDispatches,maxTokens:config.collaboration.maxTokens,maxCostUsd:config.collaboration.maxCostUsd,maxDurationMs:duration},deadlineAt:new Date(Date.now()+duration).toISOString(),version:1,runId:task.id,coordinatorId:draft.coordinatorId,fingerprint:fp,goal:draft.goal,maxTokens:draft.maxTokens,
      maxBatchItems:Math.min(3,config.collaboration.maxTargets),maxDispatches:items.length+new Set(items.map(i=>i.batch)).size+1+(releaseVersion?1:0),
      items,roleSources,returnProfile:'status-only-v1',join:draft.join,recoveryVersion:1};
    run('INSERT INTO scoped_delivery_plans VALUES (?,?,?,?)',task.id,fp,JSON.stringify(plan),draft.maxTokens);
    const dispatch=createDispatch({runId:task.id,conversationId:task.conversationId,sourceMessageId:source.id,kind:'initial',from:'user',targetAgentId:draft.coordinatorId,depth:0,idempotencyKey:`scoped:initial:${id}`});
    observeAdmission(planned.contract,planned.subjects,[dispatch.id]);
    run('UPDATE scoped_delivery_previews SET run_id=?,client_key=? WHERE id=?',task.id,key,id);
    afterCommit(()=>touchConversation(task.conversationId));
    return task.id;
  });
}
export function getDeliveryPlan(runId: string): DeliveryPlan | null {
  const row=get<{record:string}>('SELECT record FROM scoped_delivery_plans WHERE run_id=?',runId);
  return row ? JSON.parse(row.record) : null;
}
export function scopedDeliveryStatus(runId: string): ScopedDeliveryStatus {
  const p=getDeliveryPlan(runId), task=getRun(runId);
  if(!p||!task) throw new AccountError(404,'独立材料任务不存在');
  const budget=get<{charged:number;unknown:number}>("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged, COALESCE(SUM(status='unknown'),0) unknown FROM orchestration_token_reservations WHERE run_id=?",runId)!;
  return {runId,costBudget:costBudgetState(runId),goal:p.goal,status:task.status,maxTokens:p.maxTokens,chargedTokens:budget.charged,unknownCalls:budget.unknown,
    items:p.items.map(i=>{
      const row=get<{status:string;body:string|null}>(`SELECT d.status,m.body FROM scoped_delivery_envelopes e JOIN collaboration_dispatches d ON d.id=e.dispatch_id
        LEFT JOIN messages m ON m.id=d.output_message_id WHERE e.run_id=? AND e.item_key=?`,runId,i.key);
      return {key:i.key,target:i.target,batch:i.batch,expectation:i.expectation,status:row?.status==='completed'?i.expectation==='material'?'delivered':i.expectation==='acknowledged'?'acknowledged':'completed':row?.status??'pending',output:row?.body??null};
    })};
}
export function roomScopedDeliveries(conversationId:string):ScopedDeliveryStatus[] {
  return all<{run_id:string}>('SELECT p.run_id FROM scoped_delivery_plans p JOIN runs r ON r.id=p.run_id WHERE r.conversation_id=? ORDER BY r.created_at DESC LIMIT 20',conversationId).map(r=>scopedDeliveryStatus(r.run_id));
}
