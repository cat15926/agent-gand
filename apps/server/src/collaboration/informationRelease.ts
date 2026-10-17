import { createHash, randomUUID } from 'node:crypto';
import type { InformationReleasePreview, InformationReleaseState, MessageAccess, PrivateAggregateDraft, PrivateAggregatePreview, PrivateAggregateSource, ScopedSourceRef } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { AccountError } from '../accounts/errors.ts';
import { object, assertFields } from '../accounts/validation.ts';
import { sealManagedContent, openManagedContent } from '../accounts/credentials.ts';
import { getConversation } from '../conversations/service.ts';
import { getRun } from '../runs/trace.ts';
import { post } from '../messaging/inbox.ts';
import { compileScopedSource } from '../runtime/scopedCollaboration.ts';
import { loadRuntimeContract } from '../runtime/runPolicy.ts';
import { registerRuntimeExternalEventReceiver, registeredRuntimeExternalEventCondition, recordRegisteredRuntimeExternalEvent } from '../runtime/holds.ts';
import { confirmScopedDelivery, getDeliveryPlan, previewScopedDelivery } from './scopedDelivery.ts';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class InformationReleaseError extends AccountError {
  readonly retryable=false;
  readonly allowedRecovery=['review_release_state'];
  constructor(readonly code:string,message:string){super(409,`${code}：${message}`);}
}
const fail = (code: string, message: string): never => { throw new InformationReleaseError(code,message); };
const text = (v: unknown, max: number) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AccountError(400, `请填写 1–${max} 字符的文字`); return v.trim(); };
const now = () => new Date().toISOString();
interface SourceSnapshot { key: string; ref: ScopedSourceRef; attemptId: string; ledger: string; inputs: ScopedSourceRef[]; }
interface Intake { draft: PrivateAggregateDraft; sources: SourceSnapshot[]; membersVersion: number; owner: string; }
interface Workflow { run_id: string; source_run_id: string; aggregator_id: string; intake: string; }
interface DraftRow { revision: number; body: string; attempt_id: string; inputs: string; }
interface PreviewRow { id: string; owner: string; kind: string; fingerprint: string; payload: string; expires_at: string; result: string | null; client_key: string | null; }
interface GrantRecord extends InformationReleasePreview { policyVersion: number; inputs: string; membersVersion: number; owner: string; commandKey: string; }
interface GrantRow { id: string; run_id: string; policy_id: string; status: string; record: string; }

registerRuntimeExternalEventReceiver({ id:'information-release-v1', payloadSchemaVersion:1,
  validatePayload: p => Object.keys(p).length === 1 && typeof p.releaseId === 'string' });
export const releaseHoldCondition = (runId: string) => registeredRuntimeExternalEventCondition({receiverId:'information-release-v1',correlationId:runId,generation:1});
export function releaseWorkflow(runId: string): Workflow | undefined { return get<Workflow>('SELECT * FROM information_release_workflows WHERE run_id=?',runId); }
export function hasPublishedRelease(runId: string): boolean { return Boolean(get('SELECT 1 FROM information_release_records WHERE run_id=?',runId)); }
function latestDraft(runId: string) { return get<DraftRow>('SELECT * FROM information_release_drafts WHERE run_id=? ORDER BY revision DESC LIMIT 1',runId); }
function ledger(attemptId: string) { return all<{record:string}>('SELECT record FROM runtime_input_provenance WHERE attempt_id=? ORDER BY sequence',attemptId).map(r=>JSON.parse(r.record)); }
function ledgerSnapshot(attemptId: string) { const entries=ledger(attemptId); return {ledger:hash(entries),inputs:entries.map(e=>e.source as ScopedSourceRef)}; }
/** The same authoritative result selection is used by discovery, intake and projection. */
function aggregateResult(runId:string,key:string): {source:SourceSnapshot;target:string} {
  const task=getRun(runId),plan=getDeliveryPlan(runId);
  const coordination=[1,2].includes(loadRuntimeContract(runId)?.features?.coordinationScopes??0);
  if(!task||task.deletedAt||task.status!=='completed'||(!plan&&!coordination)||releaseWorkflow(runId))return fail('RELEASE_SOURCE_INVALID','请选择已完成且具有输入账本的独立材料或 Coordination 任务');
  let candidate: {id:string;message_id:string;agent_id:string}|undefined;
  if(coordination)candidate=get(`SELECT a.id,m.id message_id,m.from_agent agent_id FROM coordination_step_attempts a
    JOIN coordination_plans p ON p.id=a.plan_id AND p.revision=a.revision
    JOIN json_each(p.payload,'$.steps') step ON json_extract(step.value,'$.id')=a.step_id
    JOIN coordination_step_states s ON s.plan_id=a.plan_id AND s.revision=a.revision AND s.step_id=a.step_id AND s.attempt_no=a.attempt_no
    JOIN messages m ON m.run_id=a.run_id AND m.client_message_id=a.idempotency_key AND m.kind='agent' AND m.from_agent=json_extract(step.value,'$.agentId')
    JOIN runtime_scope_attempts b ON b.attempt_id=a.id
    WHERE a.run_id=? AND a.step_id=? AND a.status='completed' AND s.status='completed'`,runId,key);
  else {
    if(!plan!.items.some(i=>i.key===key&&i.expectation==='result'))return fail('RELEASE_SOURCE_INVALID','只能选择提交结果的事项');
    candidate=get(`SELECT a.id,d.output_message_id message_id,a.agent_id FROM scoped_delivery_envelopes e
      JOIN collaboration_dispatches d ON d.id=e.dispatch_id AND d.status='completed'
      JOIN collaboration_attempts a ON a.dispatch_id=d.id AND a.status='completed'
      JOIN runtime_scope_attempts b ON b.attempt_id=a.id
      WHERE e.run_id=? AND e.item_key=? AND d.output_message_id IS NOT NULL ORDER BY a.rowid DESC LIMIT 1`,runId,key);
  }
  if(!candidate)return fail('RELEASE_SOURCE_INVALID','结果尚未完成或缺少范围输入账本');
  const snapshot=ledgerSnapshot(candidate.id);
  if(!snapshot.inputs.length)return fail('RELEASE_SOURCE_INVALID','结果缺少可验证的输入来源');
  return {target:candidate.agent_id,source:{key,ref:compileScopedSource(runId,'message',candidate.message_id),attemptId:candidate.id,...snapshot}};
}
export function roomAggregateSources(roomId:string): PrivateAggregateSource[] {
  const room=getConversation(roomId);if(!room||room.archivedAt)throw new AccountError(404,'聊天室不存在或已归档');
  return all<{id:string;goal:string}>(`SELECT r.id,r.goal FROM runs r JOIN runtime_contracts c ON c.run_id=r.id
    WHERE r.conversation_id=? AND r.status='completed' AND r.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM information_release_workflows w WHERE w.run_id=r.id)
      AND (json_extract(c.payload,'$.features.coordinationScopes') IN (1,2) OR EXISTS (SELECT 1 FROM scoped_delivery_plans d WHERE d.run_id=r.id))
    ORDER BY r.created_at DESC,r.id DESC`,roomId).flatMap(task=>{
      const coordination=[1,2].includes(loadRuntimeContract(task.id)?.features?.coordinationScopes??0);
      const keys=coordination?all<{step_id:string}>('SELECT DISTINCT step_id FROM coordination_step_attempts WHERE run_id=? ORDER BY step_id',task.id).map(s=>s.step_id)
        :getDeliveryPlan(task.id)!.items.filter(i=>i.expectation==='result').map(i=>i.key);
      const items=keys.flatMap(key=>{try{return [{key,target:aggregateResult(task.id,key).target}];}catch(error){if(error instanceof AccountError)return [];throw error;}});
      return items.length?[{runId:task.id,goal:task.goal,engine:coordination?'coordination' as const:'independent-material' as const,items}]:[];
    });
}
function currentRef(runId:string,ref:ScopedSourceRef) { try{return compileScopedSource(runId,ref.kind,ref.id);}catch{return fail('RELEASE_STALE','来源已删除、变更或不可读取');} }
function validateSources(runId: string, sources: SourceSnapshot[]) {
  const task=getRun(runId);
  if(!task||task.deletedAt||task.status !== 'completed') fail('RELEASE_STALE','原始任务已删除或不再处于已完成状态');
  for(const s of sources) {
    const selected=aggregateResult(runId,s.key).source;
    if(selected.attemptId!==s.attemptId||hash(selected.ref)!==hash(s.ref))fail('RELEASE_STALE','原始完成结果已改变');
    if(hash(currentRef(runId,s.ref))!==hash(s.ref) || ledgerSnapshot(s.attemptId).ledger!==s.ledger) fail('RELEASE_STALE','来源或完整输入账本已改变');
    for(const ref of s.inputs) if(hash(currentRef(runId,ref))!==hash(ref)) fail('RELEASE_STALE','来源上下文已改变');
  }
}
export function assertReleaseInputs(runId: string): void {
  const w=releaseWorkflow(runId); if(!w)return;
  const intake=JSON.parse(w.intake) as Intake;
  validateSources(w.source_run_id,intake.sources);
}
function active(runId: string) {
  const task=getRun(runId),plan=getDeliveryPlan(runId);
  if(!task || !['running','waiting_for_user'].includes(task.status) || !plan || Date.parse(plan.deadlineAt)<=Date.now()) fail('RELEASE_STOPPED','任务已停止、结束或超过时限');
  if(get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1',runId))fail('RELEASE_STOPPED','任务处于恢复核对状态');
  if(!get("SELECT 1 FROM runtime_subjects s JOIN runtime_custody c ON c.subject_id=s.id WHERE s.run_id=? AND s.kind='root' AND s.status IN ('active','waiting') AND c.state IN ('owned','waiting')",runId))fail('RELEASE_STOPPED','发布责任已结束或失效');
  const room=getConversation(task!.conversationId);
  if(!room||room.archivedAt)fail('RELEASE_STALE','聊天室不可用');
  return {task:task!,plan:plan!,room:room!};
}
function savePreview(kind:string,payload:unknown,owner:string,deadlineAt?:string) {
  const id=randomUUID(),fingerprint=hash(payload),expiresAt=new Date(Math.min(Date.now()+15*60_000,deadlineAt?Date.parse(deadlineAt):Infinity)).toISOString();
  run('INSERT INTO information_release_previews(id,owner,kind,fingerprint,payload,expires_at) VALUES (?,?,?,?,?,?)',id,owner,kind,fingerprint,sealManagedContent(Buffer.from(JSON.stringify(payload)),`release-preview:${id}:${fingerprint}`),expiresAt);
  return {id,fingerprint,expiresAt};
}
function confirmedPreview(value:unknown,owner:string,kind:string) {
  const v=object(value);assertFields(v,['previewId','fingerprint','clientKey']);
  const id=text(v.previewId,100),fingerprint=text(v.fingerprint,64),clientKey=text(v.clientKey,100);
  const p=get<PreviewRow>('SELECT * FROM information_release_previews WHERE id=?',id);
  if(!p||p.owner!==owner||p.kind!==kind||p.fingerprint!==fingerprint)fail('RELEASE_STALE','预览不存在或不属于当前管理会话');
  if(p!.result){if(p!.client_key!==clientKey)fail('RELEASE_CONFLICT','已确认预览不能更换提交编号');return {p:p!,clientKey,result:JSON.parse(p!.result)};}
  if(Date.parse(p!.expires_at)<=Date.now())fail('RELEASE_EXPIRED','预览已过期');
  if(get('SELECT 1 FROM information_release_previews WHERE client_key=?',clientKey))fail('RELEASE_CONFLICT','提交编号已使用');
  const payload=JSON.parse(openManagedContent(p!.payload,`release-preview:${id}:${fingerprint}`).toString());
  if(hash(payload)!==fingerprint)fail('RELEASE_STALE','预览内容不匹配');
  return {p:p!,clientKey,payload};
}
function finishPreview(id:string,clientKey:string,result:unknown) {run('UPDATE information_release_previews SET result=?,client_key=? WHERE id=?',JSON.stringify(result),clientKey,id);}
function aggregateMaterial(instruction:string,sources:Array<{key:string;body:string}>) {
  const material=`仅供私密汇总。${instruction}\n\n${sources.map(s=>`材料 ${s.key}\n${s.body}`).join('\n\n')}`;
  if(material.length>12000)throw new AccountError(400,'所选结果与汇总要求合计超过 12000 字符，请减少来源');
  return material;
}
/** Explicit Owner intake authorizes copies, never edits the original reports' ACL. */
export function previewPrivateAggregate(value:unknown,owner:string):PrivateAggregatePreview {
  const v=object(value);assertFields(v,['sourceRunId','itemKeys','aggregatorId','instruction','maxTokens']);
  const sourceRunId=text(v.sourceRunId,100),aggregatorId=text(v.aggregatorId,100),instruction=text(v.instruction,2000);
  const task=getRun(sourceRunId),plan=getDeliveryPlan(sourceRunId);
  const coordination=[1,2].includes(loadRuntimeContract(sourceRunId)?.features?.coordinationScopes??0);
  if(!task||task.status!=='completed'||(!plan&&!coordination)||releaseWorkflow(sourceRunId))fail('RELEASE_SOURCE_INVALID','请选择已完成且具有输入账本的独立材料或 Coordination 任务');
  if(!Array.isArray(v.itemKeys)||!v.itemKeys.length||v.itemKeys.length>6||v.itemKeys.some(k=>typeof k!=='string')||new Set(v.itemKeys).size!==v.itemKeys.length)throw new AccountError(400,'请选择不重复的结果项');
  const itemKeys=v.itemKeys as string[];
  const sources=itemKeys.map(key=>aggregateResult(sourceRunId,key).source);
  const bodies=sources.map(s=>({key:s.key,body:get<{body:string}>('SELECT body FROM messages WHERE id=?',s.ref.id)!.body}));
  const draft:PrivateAggregateDraft={sourceRunId,itemKeys,aggregatorId,instruction,maxTokens:Number(v.maxTokens)};
  const delivery=previewScopedDelivery({conversationId:task!.conversationId,coordinatorId:aggregatorId,goal:'私密汇总与授权发布',join:'all',returnProfile:'status-only-v1',maxTokens:v.maxTokens,items:[{key:'aggregate',target:aggregatorId,batch:1,material:aggregateMaterial(instruction,bodies),expectation:'result'}]},owner);
  const intake:Intake={draft,sources,membersVersion:getConversation(task!.conversationId)!.membersVersion,owner};
  const preview=savePreview('aggregate',{intake,deliveryId:delivery.id,deliveryFingerprint:delivery.fingerprint},owner);
  return {...preview,draft,sources:bodies,costPolicy:delivery.costPolicy,disclosure:'授权汇总者读取以上确切结果副本并生成私密草稿。原报告权限保持不变；发布给其他成员需另行批准。新任务单独计费，继承当前房间费用政策。'};
}
export function confirmPrivateAggregate(value:unknown,owner:string):{runId:string} {
  return tx(()=>{
    const c=confirmedPreview(value,owner,'aggregate');if(c.result)return c.result;
    const {intake,deliveryId,deliveryFingerprint}=c.payload as {intake:Intake;deliveryId:string;deliveryFingerprint:string};
    validateSources(intake.draft.sourceRunId,intake.sources);
    const runId=confirmScopedDelivery({previewId:deliveryId,fingerprint:deliveryFingerprint,clientKey:`aggregate:${c.p.id}`},owner,1);
    run('INSERT INTO information_release_workflows VALUES (?,?,?,?)',runId,intake.draft.sourceRunId,intake.draft.aggregatorId,JSON.stringify(intake));
    const result={runId};finishPreview(c.p.id,c.clientKey,result);return result;
  });
}
/** Called within the scoped completion command transaction, before the parent can resume. */
export function storeReleaseDraft(runId:string,attemptId:string,body:string) {
  if(!releaseWorkflow(runId))fail('RELEASE_UNSUPPORTED','任务未冻结发布能力');
  assertReleaseInputs(runId);active(runId);
  if(latestDraft(runId))fail('RELEASE_CONFLICT','模型草稿已提交');
  const inputs=JSON.stringify(ledgerSnapshot(attemptId));
  run('INSERT INTO information_release_drafts VALUES (?,1,?,?,?,?)',runId,body,attemptId,inputs,now());
}
function draftInputs(runId:string,draft:DraftRow) {
  assertReleaseInputs(runId);
  const snapshot=JSON.parse(draft.inputs) as {ledger:string;inputs:ScopedSourceRef[]};
  if(ledgerSnapshot(draft.attempt_id).ledger!==snapshot.ledger)fail('RELEASE_STALE','汇总输入账本已改变');
  for(const ref of snapshot.inputs)if(hash(currentRef(runId,ref))!==hash(ref))fail('RELEASE_STALE','汇总输入内容已改变');
  return snapshot;
}
export function editReleaseDraft(runId:string,value:unknown) {
  return tx(()=>{
    active(runId);if(hasPublishedRelease(runId))fail('RELEASE_ALREADY_CONSUMED','已发布内容不可改写');
    const v=object(value);assertFields(v,['expectedRevision','body']);const d=latestDraft(runId);
    if(!d||d.revision!==v.expectedRevision)fail('RELEASE_STALE','草稿版本已改变');
    draftInputs(runId,d!);const body=text(v.body,24000);
    run('INSERT INTO information_release_drafts VALUES (?,?,?,?,?,?)',runId,d!.revision+1,body,d!.attempt_id,d!.inputs,now());
    return releaseState(runId);
  });
}
function releaseAccess(value:unknown,roomId:string):MessageAccess {
  const v=object(value);assertFields(v,['visibility','audience']);
  if(!['public','private'].includes(String(v.visibility))||!Array.isArray(v.audience)||v.audience.length>32||v.audience.some(id=>typeof id!=='string')||v.visibility==='public'&&v.audience.length)throw new AccountError(400,'发布范围无效');
  const members=getConversation(roomId)!.agentIds;
  const audience=[...new Set(['user',...v.audience as string[]])].sort();
  if(audience.some(id=>id!=='user'&&!members.includes(id))||v.visibility==='private'&&audience.length===1)throw new AccountError(400,'请选择房间中的发布接收者');
  return {visibility:v.visibility as 'public'|'private',audience:v.visibility==='public'?[]:audience};
}
export function previewInformationRelease(runId:string,value:unknown,owner:string):InformationReleasePreview {
  return tx(()=>{
    const {room,plan}=active(runId);const d=latestDraft(runId);if(!d||!releaseWorkflow(runId))fail('RELEASE_DRAFT_MISSING','尚无汇总草稿');
    if(hasPublishedRelease(runId))fail('RELEASE_ALREADY_CONSUMED','本次任务已发布');
    const v=object(value);assertFields(v,['expectedRevision','mode','access']);
    if(v.expectedRevision!==d!.revision)fail('RELEASE_STALE','草稿已改变');
    if(!['exact_content','deterministic_projection'].includes(String(v.mode)))throw new AccountError(400,'仅支持确切文字或固定状态投影');
    const snapshot=draftInputs(runId,d!),access=releaseAccess(v.access,room.id),w=releaseWorkflow(runId)!;
    const intake=JSON.parse(w.intake) as Intake;
    // Registry v1: fixed key/state fields, frozen source selection, no expressions/templates/model text.
    const body=v.mode==='exact_content'?d!.body:JSON.stringify({version:1,items:intake.draft.itemKeys.map(key=>{
      aggregateResult(w.source_run_id,key); // Only an accepted, still-current result projects as completed.
      return {key,state:'completed'};
    })});
    const policyId=randomUUID();
    const payload={runId,draftRevision:d!.revision,body,access,mode:v.mode,projectionId:v.mode==='deterministic_projection'?'status-receipts-v1':null,sourceSummary:intake.sources.map(s=>({key:s.key,ref:s.ref,inputCount:s.inputs.length})),sourceCount:intake.sources.length,inputCount:snapshot.inputs.length+intake.sources.reduce((n,s)=>n+s.inputs.length,0),maxUses:1 as const,policyId,policyVersion:1,inputs:d!.inputs,membersVersion:room.membersVersion,owner};
    const p=savePreview('release',payload,owner,plan.deadlineAt);
    run('INSERT INTO information_release_policies VALUES (?,?,1,?,?,?)',policyId,runId,'proposed',p.expiresAt,JSON.stringify({...payload,fingerprint:p.fingerprint}));
    return {...payload,...p} as InformationReleasePreview;
  });
}
function validateGrant(g:GrantRecord) {
  const {room}=active(g.runId);const d=latestDraft(g.runId);
  const p=get<{version:number;status:string;expires_at:string;record:string}>('SELECT * FROM information_release_policies WHERE id=?',g.policyId);
  if(!p||p.status==='revoked'||p.version!==g.policyVersion)fail('RELEASE_REVOKED','发布策略已撤销或变化');
  if(Date.parse(p!.expires_at)<=Date.now())fail('RELEASE_EXPIRED','发布授权已过期');
  if(room.membersVersion!==g.membersVersion||!d||d.revision!==g.draftRevision||d.inputs!==g.inputs)fail('RELEASE_STALE','草稿、成员或输入账本已改变');
  draftInputs(g.runId,d!);
  const stored=JSON.parse(p!.record);if(stored.fingerprint!==g.fingerprint||stored.body!==g.body||hash(stored.access)!==hash(g.access))fail('RELEASE_STALE','发布字节或范围与批准不符');
  releaseAccess(g.access,room.id);
}
export function confirmInformationRelease(value:unknown,owner:string):{grantId:string;runId:string} {
  return tx(()=>{
    const c=confirmedPreview(value,owner,'release');if(c.result)return c.result;
    const g:GrantRecord={...c.payload,id:c.p.id,fingerprint:c.p.fingerprint,expiresAt:c.p.expires_at,commandKey:c.clientKey};
    validateGrant(g);if(hasPublishedRelease(g.runId))fail('RELEASE_ALREADY_CONSUMED','本次任务已发布');
    const grantId=randomUUID();
    run("UPDATE information_release_policies SET status='approved' WHERE id=? AND status='proposed'",g.policyId);
    run('INSERT INTO information_release_grants VALUES (?,?,?,?,?)',grantId,g.policyId,g.runId,'ready',JSON.stringify(g));
    const result={grantId,runId:g.runId};finishPreview(c.p.id,c.clientKey,result);return result;
  });
}
export function revokeInformationRelease(policyId:string) {
  return tx(()=>{
    const p=get<{run_id:string;status:string}>('SELECT run_id,status FROM information_release_policies WHERE id=?',policyId);if(!p)throw new AccountError(404,'发布策略不存在');
    if(p.status!=='revoked')run("UPDATE information_release_policies SET status='revoked',version=version+1 WHERE id=?",policyId);
    return releaseState(p.run_id);
  });
}
export function publishInformationRelease(grantId:string):{runId:string;messageId:string;releaseId:string} {
  return tx(()=>{
    const grant=get<GrantRow>('SELECT * FROM information_release_grants WHERE id=?',grantId);if(!grant)throw new AccountError(404,'发布授权不存在');
    const prior=get<{id:string;message_id:string}>('SELECT id,message_id FROM information_release_records WHERE grant_id=?',grantId);
    if(prior)return {runId:grant.run_id,messageId:prior.message_id,releaseId:prior.id};
    const g=JSON.parse(grant.record) as GrantRecord;validateGrant(g);
    if(hasPublishedRelease(g.runId))fail('RELEASE_ALREADY_CONSUMED','本次任务已有发布事实');
    if(grant.status!=='ready'||run("UPDATE information_release_grants SET status='consumed' WHERE id=? AND status='ready'",grantId)!==1)fail('RELEASE_ALREADY_CONSUMED','授权已消费');
    const releaseId=randomUUID();
    // Owner's explicit disclosure creates a new message. No attempt/reply binding and no original ACL mutation.
    const message=post({runId:g.runId,from:'user',to:g.access.visibility==='public'?'all':g.access.audience.filter(id=>id!=='user').join(','),kind:'user',body:g.body,...g.access,meta:{informationReleaseId:releaseId},clientMessageId:`information-release:${grantId}`});
    if(message.body!==g.body||hash({visibility:message.visibility,audience:message.audience})!==hash(g.access))fail('RELEASE_STALE','消息投递范围与批准不符');
    run('INSERT INTO information_release_records VALUES (?,?,?,?,?,?)',releaseId,grantId,g.runId,message.id,JSON.stringify({grantId,policyId:g.policyId,policyVersion:g.policyVersion,body:g.body,access:g.access,draftRevision:g.draftRevision,inputs:g.inputs,owner:g.owner,commandKey:g.commandKey}),now());
    recordRegisteredRuntimeExternalEvent({receiverId:'information-release-v1',runId:g.runId,correlationId:g.runId,generation:1,sourceEventId:releaseId,payload:{releaseId}});
    return {runId:g.runId,messageId:message.id,releaseId};
  });
}
export function releaseState(runId:string):InformationReleaseState {
  const w=releaseWorkflow(runId);if(!w)throw new AccountError(404,'私密汇总任务不存在');const d=latestDraft(runId);
  return {runId,sourceRunId:w.source_run_id,aggregatorId:w.aggregator_id,sourceSummary:(JSON.parse(w.intake) as Intake).sources.map(s=>({key:s.key,ref:s.ref,inputCount:s.inputs.length})),draft:d?{revision:d.revision,body:d.body}:null,
    policies:all<{id:string;version:number;status:string;expires_at:string}>('SELECT * FROM information_release_policies WHERE run_id=? ORDER BY rowid',runId).map(p=>({id:p.id,version:p.version,status:p.status,expiresAt:p.expires_at})),
    grants:all<GrantRow>('SELECT * FROM information_release_grants WHERE run_id=? ORDER BY rowid',runId).map(g=>{const r=JSON.parse(g.record);return {id:g.id,policyId:g.policy_id,status:g.status,draftRevision:r.draftRevision,body:r.body,access:r.access};}),
    records:all<{id:string;grant_id:string;message_id:string;record:string}>('SELECT * FROM information_release_records WHERE run_id=?',runId).map(r=>{const d=JSON.parse(r.record);return {id:r.id,grantId:r.grant_id,messageId:r.message_id,body:d.body,access:d.access};})};
}
export function roomReleaseStates(roomId:string) {return all<{run_id:string}>('SELECT w.run_id FROM information_release_workflows w JOIN runs r ON r.id=w.run_id WHERE r.conversation_id=? ORDER BY r.created_at DESC LIMIT 20',roomId).map(r=>releaseState(r.run_id));}
