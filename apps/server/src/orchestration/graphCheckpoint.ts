import { assertLegacyRun, assertLegacyMode } from '../runs/legacyMode.ts';
import type { CoordinationPlanStep } from '@agent-gand/shared';
import { DEFAULT_COORDINATION_STEP_TOKENS, DEFAULT_RESPONSE_TIMEOUT_MS } from '@agent-gand/shared';
import { all, get } from '../db/database.ts';
import { getRun, listRunAgentSnapshots } from '../runs/trace.ts';
import { getRunCoordinationPlan, listCoordinationStepStates, listCoordinationStepAttempts } from '../coordination/store.ts';
import { listTasks } from '../messaging/tasks.ts';
import { listAttempts as taskAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';
import { isAdapterTurnTask, taskAdapterEnabled } from '../runtime/taskAdapter.ts';
import { listAttempts, listDispatches, listBatches } from '../collaboration/store.ts';
import { listByRun } from '../messaging/inbox.ts';
import { runSourceAccess, attemptAccess } from '../messaging/access.ts';
import { listExecutions } from '../execution/store.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { loadRuntimeContract } from '../runtime/runPolicy.ts';
import { resolveEvidence } from '../runtime/evidence.ts';
import { businessQuiescent } from './businessGates.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { OrchestrationError, stableDigest } from './normalize.ts';
import { attachCheckpointArchive, readBusinessCheckpoint, type BusinessCheckpoint } from './businessCheckpointStore.ts';
import { buildArtifactSnapshot } from '../artifacts/snapshots.ts';
import { costCarry, costBudgetState } from './costBudget.ts';
import { toolsForAgent } from '../tools/builtin/index.ts';

function fail(code:string,message:string):never {throw new OrchestrationError(409,code,message);}
/** Common guard for graph transfer and existing branch retries. No permission or budget reset. */
export function assertReadonlyRecovery(runId:string):void {
  const frozen=getRunOrchestrationSnapshot(runId),scope=runSourceAccess(runId);
  if(!businessQuiescent(runId,true))fail('RESULT_UNKNOWN','执行、工具或输出 Token 消耗尚未收敛，不能承接或重试。');
  if(scope.visibility!=='public'||listByRun(runId).some(m=>m.visibility==='private')||get("SELECT 1 FROM runtime_context_assemblies WHERE run_id=? AND visibility='private'",runId)||get("SELECT 1 FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,'$.visibility')='private'",runId))fail('PRIVATE_CHECKPOINT_UNSUPPORTED','跨引擎图检查点只支持公开范围；私密任务请使用冻结逐阶段恢复及副作用核对。');
  if(frozen?.execution?.readonly===false||frozen?.executionAuthority!=='orchestration'&&listRunAgentSnapshots(runId).some(a=>a.permissionMode!=='readonly')||listExecutions(runId).some(e=>e.permissionMode!=='readonly')||listToolExecutions(runId).some(t=>t.replayPolicy!=='safe'))fail('WRITE_RECONCILIATION_REQUIRED','写入及外部副作用不能仅复制文字跨引擎重试，请使用逐阶段核对恢复。');
  costCarry(runId);
  if(costBudgetState(runId)?.run.remaining===0)fail('COST_BUDGET_EXHAUSTED','原费用额度已耗尽，不能借后继重置。');
  const charged=get<{n:number}>("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0)n FROM orchestration_token_reservations WHERE run_id=?",runId)!.n;
  if(frozen?.request.constraints.maxTokens&&charged>=frozen.request.constraints.maxTokens)fail('CHECKPOINT_BUDGET_EXHAUSTED','原输出 Token 预算已耗尽，不能借后继重置。');
}

/** Compatibility adapters extract an immutable graph; there is no model planning and no source mutation. */
export function buildGraphCheckpoint(runId:string):BusinessCheckpoint {
  assertLegacyRun(runId);
  const source=getRun(runId),snapshot=getRunOrchestrationSnapshot(runId),plan=getRunCoordinationPlan(runId);
  if(!source||source.status!=='failed')fail('GRAPH_CHECKPOINT_UNSUPPORTED','图承接只支持失败终态；暂停任务沿原图恢复。');
  assertLegacyMode(source.mode);
  if(snapshot?.request.businessContract)fail('BUSINESS_CHECKPOINT_UNSUPPORTED','业务契约须使用适用的逐阶段入口，不能转换成无验收图。');
  assertReadonlyRecovery(runId);
  const inherited=readBusinessCheckpoint(runId),outputs:BusinessCheckpoint['outputs']=inherited?.graph?structuredClone(inherited.outputs):[];
  const steps:CoordinationPlanStep[]=[];
  const add=(id:string,actor:string|null,deps:string[],objective:string,type:CoordinationPlanStep['type']='agent_turn',meta:CoordinationPlanStep['metadata']={})=>{
    const agent=listRunAgentSnapshots(runId).find(a=>a.id===actor);
    steps.push({id,protocol:'sequential_pipeline',type,actorRole:id,actorCapability:type==='review'?'review':'execute',agentId:actor,dependsOn:deps,completion:'提供实质结果；审查步骤须通过独立审查',maxAttempts:1,tokenBudget:Math.min(snapshot?.request.constraints.maxTokens??DEFAULT_COORDINATION_STEP_TOKENS,DEFAULT_COORDINATION_STEP_TOKENS),timeoutMs:Math.min(snapshot?.request.constraints.deadlineMs??DEFAULT_RESPONSE_TIMEOUT_MS,DEFAULT_RESPONSE_TIMEOUT_MS),onFailure:'fail_plan',toolPolicy:{allowedTools:agent?toolsForAgent(agent).map(t=>t.name):[],requiresApproval:false},metadata:{...meta,objective,readonly:true}});
  };
  const confirm=(id:string,attemptId:string,output:string)=>{
    const step=steps.find(s=>s.id===id)!;
    if(outputs.some(o=>o.stepId===id))return;
    const proof=resolveEvidence(runId,{kind:'attempt_output',id:attemptId});
    if(!output.trim()||!proof.trusted||!proof.contentSha256||attemptAccess(attemptId).visibility!=='public')fail('CHECKPOINT_EVIDENCE_INVALID','完成分支缺少公开可信的执行证据。');
    outputs.push({attemptId,sourceRunId:runId,stageId:'',stepId:id,agentId:step.agentId!,objective:String(step.metadata.objective??source!.goal),output,sha256:proof.contentSha256,access:attemptAccess(attemptId),origin:'member'});
  };
  let engine:NonNullable<BusinessCheckpoint['graph']>['sourceEngine']=plan?'coordination':source!.mode;
  let protocols:NonNullable<BusinessCheckpoint['graph']>['protocols']=[{protocol:'sequential_pipeline',version:1}],terminalSteps=['complete'];
  if(plan) {
    if(plan.executionVersion!=='o4-workflows-v1'||plan.executionAdapter||plan.steps.some(s=>s.metadata.businessStageId)||snapshot?.execution?.engine!=='coordination')fail('GRAPH_CHECKPOINT_INCOMPATIBLE','该计划版本或执行适配器没有可迁移的冻结图，禁止重新规划降级。');
    steps.push(...structuredClone(inherited?.graph?.steps??plan.steps));protocols=inherited?.graph?.protocols??structuredClone(plan.protocols);terminalSteps=inherited?.graph?.terminalSteps??[...plan.completion.terminalSteps];
    const states=listCoordinationStepStates(plan.id),attempts=listCoordinationStepAttempts(plan.id);
    for(const step of plan.steps.filter(s=>s.agentId)) {
      const state=states.find(s=>s.stepId===step.id);
      if(state?.status!=='completed')continue;
      const attempt=attempts.filter(a=>a.revision===plan.revision&&a.stepId===step.id).at(-1);
      if(attempt?.status!=='completed'||attempt.output!==state.output)fail('CHECKPOINT_EVIDENCE_INVALID','步骤状态与完成证据不一致。');
      confirm(step.id,attempt.id,attempt.output!);
    }
  } else if(source!.mode==='pipeline') {
    if(!taskAdapterEnabled(runId))fail('LEGACY_CONTEXT_UNVERIFIED','旧流水线缺少当前适配器执行契约，禁止推断检查点。');
    let tail:string[]=[];
    source!.agentIds.forEach((actor,i)=>{
      const id=`pipeline-${i+1}`;add(id,actor,tail,source!.goal);tail=[id];
      const row=get<{task_id:string}>('SELECT task_id FROM orchestration_turn_tasks WHERE run_id=? AND scope=?',runId,`pipeline:${i}:${actor}`),task=row?listTasks(runId).find(t=>t.id===row.task_id):null;
      if(task?.status==='completed') {
        const attempt=taskAttempts(task.id).filter(a=>a.kind==='work').at(-1);
        if(attempt?.status!=='completed'||attempt.agentId!==actor||attempt.attemptNo!==task.attempt||attempt.output!==task.result)fail('CHECKPOINT_EVIDENCE_INVALID','流水线确认结果缺少当前成员及轮次的完成证据。');
        confirm(id,attempt.id,attempt.output!);
      }
    });add('complete',null,tail,source!.goal,'completion_gate');
  } else if(source!.mode==='supervisor') {
    if(!taskAdapterEnabled(runId))fail('LEGACY_CONTEXT_UNVERIFIED','旧主管缺少当前适配器契约。');
    const tasks=listTasks(runId).filter(t=>!isAdapterTurnTask(t.id));
    if(!tasks.length||tasks.some(t=>t.status==='cancelled'||!t.assignee||t.blockedBy.some(id=>!tasks.some(p=>p.id===id))))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','主管分工尚未冻结、含取消分支或未知依赖，不能重新调用规划。');
    const end=(id:string)=>tasks.find(t=>t.id===id)!.reviewerId?`task-${id}-review`:`task-${id}`;
    for(const task of tasks) {
      const id=`task-${task.id}`;add(id,task.assignee,task.blockedBy.map(end),task.body??task.title,'agent_turn',{title:task.title,acceptanceCriteria:task.acceptanceCriteria});
      if(task.reviewerId)add(`${id}-review`,task.reviewerId,[id],task.title,'review',{reviewTargetStepIds:[id],independent:true});
      if(task.status==='completed') {
        const attempt=taskAttempts(task.id).filter(a=>a.kind==='work').at(-1);
        const review=attempt?listReviews(task.id).filter(r=>r.attemptId===attempt.id&&r.reviewerId===task.reviewerId).at(-1):null;
        if(!attempt||attempt.status!=='completed'||attempt.attemptNo!==task.attempt||attempt.agentId!==task.assignee||attempt.output!==task.result||task.reviewerId&&review?.verdict!=='PASS')fail('CHECKPOINT_EVIDENCE_INVALID','主管已完成分支缺少当前轮次的可信工作或 PASS 审查。');
        confirm(id,attempt.id,attempt.output!);
        if(task.reviewerId) {
          const proof=taskAttempts(task.id).filter(a=>a.kind==='review'&&a.attemptNo===attempt.attemptNo&&a.agentId===task.reviewerId).at(-1);
          if(!proof||proof.status!=='completed')fail('CHECKPOINT_EVIDENCE_INVALID','当前工作轮次的独立审查缺少完成证据。');
          let verdict;try{verdict=JSON.parse(proof.output!);}catch{fail('CHECKPOINT_EVIDENCE_INVALID','独立审查输出无效。');}
          if(verdict?.verdict!=='PASS'||stableDigest({verdict:verdict.verdict,summary:verdict.summary,issues:verdict.issues})!==stableDigest({verdict:review!.verdict,summary:review!.summary,issues:review!.issues}))fail('CHECKPOINT_EVIDENCE_INVALID','独立审查输出与当前工作轮次的 PASS 记录不一致。');
          confirm(`${id}-review`,proof.id,proof.output!);
        }
      }
    }
    add('summary',source!.supervisorId??source!.agentIds[0]!,tasks.map(t=>end(t.id)),source!.goal,'aggregate');add('complete',null,['summary'],source!.goal,'completion_gate');
  } else {
    if(loadRuntimeContract(runId)?.features?.messageVisibilityVersion!==1)fail('LEGACY_CONTEXT_UNVERIFIED','协作任务没有冻结消息范围。');
    const batches=listBatches(runId),dispatches=listDispatches(runId),attempts=listAttempts(runId);
    if(batches.length!==1||batches[0]!.joinPolicy!=='all'||!['failed','timeout','partial'].includes(batches[0]!.status))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','仅支持单个明确的 all 汇合批次；any 竞速、嵌套或动态追问不能推断后续图。');
    const batch=batches[0]!,parent=dispatches.find(d=>d.id===batch.sourceDispatchId),parentAttempt=attempts.filter(a=>a.dispatchId===parent?.id).at(-1);
    const control=parentAttempt?.controlAction;
    if(!control||!['consult','ask_many'].includes(control.type)
      ||control.type==='consult'&&(control.join!=='all'||control.objective!==batch.question||control.visibility==='private')
      ||control.type==='ask_many'&&control.question!==batch.question
      ||!('targetAgentIds'in control)||stableDigest([...control.targetAgentIds].sort())!==stableDigest([...batch.targetAgentIds].sort()))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','批次与已冻结的 all 咨询控制动作不一致。');
    const branches=dispatches.filter(d=>d.batchId===batch.id&&d.kind==='fanout');
    if(!parent||parent.parentDispatchId||parent.status!=='completed'||parentAttempt?.status!=='completed'||branches.length!==batch.targetAgentIds.length||new Set(branches.map(d=>d.targetAgentId)).size!==branches.length||branches.some(d=>!batch.targetAgentIds.includes(d.targetAgentId))||dispatches.some(d=>['queued','running'].includes(d.status)||d.id!==parent.id&&!branches.some(b=>b.id===d.id)&&(d.kind!=='aggregate'||d.batchId!==batch.id)))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','批次派发、控制或成员结果不完整，无法证明其余事项。');
    const messages=new Map(listByRun(runId).map(m=>[m.id,m]));
    add('batch-source',parent.targetAgentId,[],messages.get(parent.sourceMessageId)?.body??source!.goal);confirm('batch-source',parentAttempt.id,parentAttempt.output!);
    for(const [i,branch]of branches.entries()) {
      const id=`branch-${i+1}`;add(id,branch.targetAgentId,['batch-source'],batch.question,'fanout');
      if(branch.status==='completed') {
        const attempt=attempts.filter(a=>a.dispatchId===branch.id).at(-1);
        if(attempt?.status!=='completed'||!['answer','complete','finish','implicit_complete'].includes(attempt.controlAction?.type??''))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','分支仍有动态控制义务，不能按完成文本复用。');
        confirm(id,attempt.id,attempt.output!);
      }
    }
    add('summary',batch.initiatorAgentId,branches.map((_,i)=>`branch-${i+1}`),`${source!.goal}\n汇合问题：${batch.question}`,'aggregate');add('complete',null,['summary'],source!.goal,'completion_gate');
  }
  if(steps.length>64||steps.some(s=>s.agentId&&!source!.agentIds.includes(s.agentId)))fail('GRAPH_CHECKPOINT_INCOMPATIBLE','依赖图超出限制或包含原授权外成员。');
  const complete=new Set(outputs.map(o=>o.stepId));
  const satisfied=(id:string,seen=new Set<string>()):boolean=>{if(seen.has(id))return false;seen.add(id);const step=steps.find(s=>s.id===id);return !!step&&(complete.has(id)||step.type==='completion_gate')&&step.dependsOn.every(d=>satisfied(d,new Set(seen)));};
  if(outputs.some(o=>!satisfied(o.stepId)))fail('CHECKPOINT_DEPENDENCY_INVALID','已确认结果的必要前序尚未确认，不能跳过依赖。');
  if(!steps.some(s=>s.agentId&&!complete.has(s.id)))fail('ALREADY_COMPLETED','没有剩余模型步骤，请核对原终态和交付。');
  const managed=all<{id:string;record:string}>('SELECT id,record FROM managed_artifact_versions WHERE run_id=?',runId).filter(a=>{const r=JSON.parse(a.record);return r.createdBy==='user'||outputs.some(o=>o.attemptId===r.attemptId);}).map(a=>a.id);
  const archive=buildArtifactSnapshot(runId,{stageIds:[],checkpoint:true,managedIds:managed,paths:steps.filter(s=>complete.has(s.id)).flatMap(s=>s.expectedArtifacts??[])});
  if(!archive.manifest.complete)fail('CHECKPOINT_INCOMPLETE','确认分支的产物快照不完整。');
  const checkpoint:BusinessCheckpoint={version:4,sourceRunId:runId,sourceVersion:plan?.revision??1,contract:null,graph:{sourceEngine:engine,steps,protocols,terminalSteps},access:runSourceAccess(runId),readonly:true,accepted:[],outputs,files:archive.manifest.files.filter(f=>f.storage==='workspace'&&f.sha256).map(f=>({sourceRunId:f.sourceRunId,path:f.path,sha256:f.sha256!})),runTokens:get<{n:number}>("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0)n FROM orchestration_token_reservations WHERE run_id=?",runId)!.n,stageTokens:[],costs:costCarry(runId),...(costBudgetState(runId)?{costBudget:costBudgetState(runId)!}:{})};
  attachCheckpointArchive(checkpoint,archive);
  if(Buffer.byteLength(JSON.stringify(checkpoint))>1024*1024)fail('CHECKPOINT_TOO_LARGE','依赖图检查点超过 1 MiB。');
  return checkpoint;
}
