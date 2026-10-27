import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

// Read-only evidence audit. This never opens SQLite, starts workers, or calls
// suppliers; its assertions and mutated in-memory controls are not new behavior
// acceptance groups. Historical reports are never rewritten.
const args=process.argv.slice(2);
const option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const input=path.resolve(option('--input','docs/reports/evidence/threaded-rc10/main-injected-delivery.json'));
const output=path.resolve(option('--output',input.replace(/\.json$/,'-chain-audit.json')));
assert.notEqual(input,output,'RC10_AUDIT_OUTPUT_MUST_DIFFER');
const bytes=await readFile(input),report=JSON.parse(bytes),digest=value=>createHash('sha256').update(value).digest('hex');
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const require=(condition,code)=>{if(!condition)throw new Error(code);};
const one=(values,code)=>{require(values.length===1,code);return values[0];};
const ordered=values=>[...values].sort();
function audit(r){
  require(r.ok===true&&r.groups===1&&r.failures.length===0,'MAIN_ACCEPTANCE_NOT_PASSED');
  require(r.actualMainIndex===true,'ACTUAL_INDEX_REQUIRED');
  const final=r.evidence.at(-1);require(!!final,'FINAL_SNAPSHOT_REQUIRED');
  require(r.evidence.every(e=>e.actualMainIndex===true&&e.isolatedExecutionBypass===false),'NO_FACTORY_EXECUTION_BYPASS');
  require(r.evidence.every(e=>e.toolErrors.length===0),'NO_TOOL_ERROR');
  require(final.invocations.length>0&&final.invocations.every(i=>i.status==='completed'),'INVOCATIONS_COMPLETED');
  const root=one(final.messages.filter(m=>m.origin==='user'&&m.body.startsWith('RC10_START ')),'ORIGINAL_REQUEST_UNIQUE');
  const home=root.body.match(/\bhome=([a-f0-9-]{36})/)?.[1],work=root.body.match(/\bwork=([a-f0-9-]{36})/)?.[1];
  require(home&&work&&home!==work&&root.thread_id===home&&root.causal_root_id===root.id,'ORIGINAL_ROOT_AND_THREADS');
  require(final.messages.every(m=>m.causal_root_id===root.id),'MESSAGE_ROOT_UNIFIED');
  require(final.invocations.every(i=>i.causal_root_id===root.id),'INVOCATION_ROOT_UNIFIED');
  require(final.queue.every(q=>q.causal_root_id===root.id),'QUEUE_ROOT_UNIFIED');
  require(final.budgetRoots.length===1&&final.budgetRoots[0].id===root.id,'BUDGET_ROOT_UNIFIED');
  const receipts=name=>final.toolReceipts.filter(t=>t.name===name).map(t=>({...t,result:parse(t.record).result}));
  function receiptMessage(receipt,agent,sourceThread,destination,targets,prefix){
    const m=receipt.result.message;require(m&&m.sender.agentId===agent&&m.sourceThreadId===sourceThread&&m.threadId===destination&&same(m.targets,targets)&&m.body.startsWith(prefix),'HANDOFF_RECEIPT_EXACT_ROUTE');
    require(m.causalRootId===root.id&&m.visibility==='public','HANDOFF_PUBLIC_SAME_ROOT');
    const saved=one(final.messages.filter(row=>row.id===m.id),'HANDOFF_MESSAGE_UNIQUE');
    require(saved.thread_id===destination&&saved.sender_agent_id===agent&&saved.origin==='agent_post'&&saved.visibility==='public'&&saved.body===m.body,'HANDOFF_RECEIPT_MATCHES_MESSAGE');return m;
  }
  const relay=receiptMessage(one(receipts('post_message'),'PUBLIC_RELAY_RECEIPT_UNIQUE'),'rc10-a',home,home,['rc10-b'],'RC10_TO_WORK ');
  const crosses=receipts('cross_post_message');require(crosses.length===2,'CROSS_THREAD_TWO_RECEIPTS');
  const entering=receiptMessage(one(crosses.filter(x=>x.result.message.threadId===work),'ENTERING_RECEIPT_UNIQUE'),'rc10-b',home,work,['rc10-b'],'RC10_CONSULT ');
  const returning=receiptMessage(one(crosses.filter(x=>x.result.message.threadId===home),'RETURN_RECEIPT_UNIQUE'),'rc10-b',work,home,['rc10-a'],'RC10_RETURN');
  const returnQueue=one(final.queue.filter(q=>q.source_message_id===returning.id&&q.agent_id==='rc10-a'&&q.thread_id===home),'RETURN_QUEUE_REQUIRED');
  require(returnQueue.state==='settled','RETURN_QUEUE_SETTLED');
  const returnInvocation=one(final.invocations.filter(i=>i.id===returnQueue.invocation_id&&i.agent_id==='rc10-a'&&i.thread_id===home),'RETURN_INVOCATION_REQUIRED');
  require(returnInvocation.status==='completed','RETURN_INVOCATION_COMPLETED');
  const returnAttemptIds=final.attempts.filter(a=>a.invocation_id===returnInvocation.id&&a.status==='completed').map(a=>a.id);
  const done=one(final.messages.filter(m=>m.origin==='agent_response'&&m.thread_id===home&&m.sender_agent_id==='rc10-a'&&returnAttemptIds.includes(m.source_attempt_id)),'RETURN_EXACT_RESPONSE_REQUIRED');
  require(done.body.includes('RC10_DONE'),'RETURN_EXACT_RESPONSE_DONE');
  one(final.wakes.filter(w=>w.source_message_id===returning.id&&w.target_agent_id==='rc10-a'),'RETURN_WAKE_UNIQUE');
  const group=one(final.groups,'CONSULTATION_UNIQUE');require(group.root_id===root.id&&group.thread_id===work&&group.caller_id==='rc10-b'&&group.callback_to==='rc10-b','CONSULTATION_SCOPE');
  const groupQueue=one(final.queue.filter(q=>q.invocation_id===group.parent_invocation_id),'CONSULTATION_PARENT_QUEUE_UNIQUE');require(groupQueue.source_message_id===entering.id,'CONSULTATION_FROM_CROSS_POST');
  const settlement=parse(one(final.settlements,'SETTLEMENT_UNIQUE').record);require(settlement.groupId===group.id&&settlement.kind==='partial','SETTLEMENT_PARTIAL');
  require(settlement.responses.length===2,'SETTLEMENT_EXACT_MEMBERS');
  const answer=one(settlement.responses.filter(x=>x.agentId==='rc10-c'),'C_RESPONSE_UNIQUE'),timeout=one(settlement.responses.filter(x=>x.agentId==='rc10-d'),'D_RESPONSE_UNIQUE');
  require(answer.status==='responded'&&typeof answer.body==='string'&&answer.body.trim().length>0,'C_ORIGINAL_NONEMPTY');
  require(timeout.status==='timeout'&&timeout.responseMessageId===null&&timeout.body===null,'D_TIMEOUT_EXPLICIT');
  const original=one(final.messages.filter(m=>m.id===answer.responseMessageId),'C_ORIGINAL_MESSAGE_UNIQUE');require(original.sender_agent_id==='rc10-c'&&original.origin==='agent_response'&&original.body===answer.body,'C_ORIGINAL_BODY_EXACT');
  const action=one(final.actions,'CANONICAL_ACTION_UNIQUE');require(action.root_id===root.id&&action.thread_id===work&&action.generation===2&&action.state==='completed','ACTION_FINAL_GENERATION_AND_ROOT');
  require(final.actionGenerations.length===2&&same(final.actionGenerations.map(g=>g.generation),[1,2]),'ACTION_GENERATIONS_EXACT');
  require(final.actionGenerations.every(g=>g.action_id===action.id&&parse(g.record).rootId===root.id),'ACTION_GENERATION_ROOT_UNIFIED');
  const reviewResults=receipts('submit_review').sort((a,b)=>a.result.generation-b.result.generation);require(reviewResults.length===2,'TWO_REVIEW_DELIVERIES');
  const first=reviewResults[0].result,last=reviewResults[1].result;
  require(first.verdict==='changes_requested'&&first.generation===1&&first.version===1,'FIRST_VERDICT_CHANGES_REQUEST_REQUIRED');
  require(last.verdict==='approved'&&last.generation===2&&last.version===3,'FINAL_VERDICT_APPROVED_REQUIRED');
  require(first.findingIds.length>0&&new Set(first.findingIds).size===first.findingIds.length,'FIRST_FINDINGS_NONEMPTY');
  require(same(ordered(first.findingIds),ordered(last.findingIds)),'REVIEW_FINDING_IDS_INHERITED');
  const workflow=one(final.workflows,'WORKFLOW_UNIQUE');require(workflow.actionId===action.id&&workflow.version===3&&workflow.generation===2&&workflow.rootId===root.id&&workflow.authorAgentId==='rc10-b','WORKFLOW_EXACT_FINAL_SCOPE');
  require(same(ordered(workflow.findings.map(f=>f.id)),ordered(first.findingIds)),'WORKFLOW_FINDING_IDS_INHERITED');
  require(workflow.findings.every(f=>f.state==='verified'&&f.openedEvidenceId===first.evidenceId&&f.resolutionEvidenceId===last.evidenceId),'FINDING_VERIFIED_WITH_EXACT_EVIDENCE');
  require(final.reviewReports.length===2,'TWO_IMMUTABLE_REVIEW_REPORTS');
  for(const result of [first,last]){
    const row=one(final.reviewReports.filter(x=>x.evidence_id===result.evidenceId),'REVIEW_EVIDENCE_REPORT_UNIQUE'),record=parse(row.record);
    require(row.action_id===action.id&&row.generation===result.generation&&row.message_id===result.messageId&&record.messageId===result.messageId&&record.verdict===result.verdict&&record.reviewer==='rc10-a'&&record.authorAgentId==='rc10-b','REVIEW_REPORT_MATCHES_RECEIPT');
    const message=one(final.messages.filter(m=>m.id===result.messageId),'REVIEW_REPORT_MESSAGE_UNIQUE');require(message.sender_agent_id==='rc10-a'&&message.origin==='agent_post','REVIEW_REPORT_AUTHORED_BY_INDEPENDENT_A');
    if(result===first)require(record.findings.length===first.findingIds.length&&record.findings.length>0,'FIRST_REPORT_FINDINGS_NONEMPTY');
    else require(record.findings.length===0,'APPROVED_REPORT_ADDS_NO_UNRESOLVED_FINDING');
  }
  const revision=one(receipts('start_review_revision'),'REVISION_RECEIPT_UNIQUE').result;
  require(revision.actionId===action.id&&revision.generation===2&&revision.version===2&&revision.verification==='attested'&&revision.approvalGateSatisfied===false,'REVISION_ATTESTATION_ONLY');
  const attestation=parse(one(final.messages.filter(m=>m.id===revision.messageId),'REVISION_MESSAGE_UNIQUE').body);
  require(attestation.type==='revision_attestation'&&attestation.actionId===action.id&&attestation.verification==='attested','REVISION_ATTESTATION_MESSAGE');
  require(same(ordered(attestation.responses.map(x=>x.findingId)),ordered(first.findingIds)),'REVISION_RESPONSES_COMPLETE');
  require(attestation.responses.every(x=>x.disposition==='addressed'&&typeof x.body==='string'&&x.body.trim()),'REVISION_RESPONSES_ADDRESS_FINDINGS');
  const firstReport=parse(final.reviewReports.find(x=>x.evidence_id===first.evidenceId).record),lastReport=parse(final.reviewReports.find(x=>x.evidence_id===last.evidenceId).record);
  require(firstReport.headSha!==lastReport.headSha&&attestation.oldHeadSha===firstReport.headSha&&attestation.newHeadSha===lastReport.headSha&&workflow.headSha===lastReport.headSha,'FRESH_INJECTED_HEAD_LINKED');
  const gates=final.reviewGates.map(g=>parse(g.record));
  require(gates.some(g=>g.generation===1&&g.workflowVersion===1&&g.status==='blocked'&&g.approvalGateSatisfied===false&&g.reasons.includes('REQUIRED_REVIEW_NOT_APPROVED')),'CHANGES_REQUESTED_GATE_BLOCKED');
  require(gates.some(g=>g.generation===2&&g.workflowVersion===3&&g.status==='approved'&&g.approvalGateSatisfied===true&&g.reasons.length===0),'FRESH_LOCAL_GATE_APPROVED');
  require(gates.every(g=>g.actionId===action.id&&g.externalApprovalGranted===false),'NO_EXTERNAL_APPROVAL');
  const completes=receipts('complete_action');require(completes.length===2&&completes.every(x=>x.result.state==='completed'&&x.result.verified===true&&x.result.approvalGateSatisfied===false),'RESPONSIBILITY_COMPLETION_SEPARATE_FROM_GATE');
  require(final.callbacks.length===3&&final.callbacks.filter(c=>c.kind==='consultation').length===1&&final.callbacks.filter(c=>c.kind==='action_completed').length===2,'CALLBACK_KINDS_EXACT');
  require(new Set(final.callbacks.map(c=>c.kind+':'+c.source_id)).size===3,'CALLBACK_LOGICAL_KEYS_UNIQUE');
  const callbackLinks=[];
  for(const callback of final.callbacks){
    require(callback.state==='delivered'&&callback.message_id,'CALLBACK_DELIVERED');
    const message=one(final.messages.filter(m=>m.id===callback.message_id),'CALLBACK_MESSAGE_UNIQUE');require(message.origin==='system'&&message.thread_id===work,'CALLBACK_SYSTEM_MESSAGE_SCOPE');
    const wake=one(final.wakes.filter(w=>w.source_message_id===message.id),'CALLBACK_WAKE_UNIQUE');require(wake.target_agent_id==='rc10-b','CALLBACK_EXACT_RECIPIENT');
    const queue=one(final.queue.filter(q=>q.source_message_id===message.id),'CALLBACK_QUEUE_UNIQUE');require(queue.agent_id==='rc10-b'&&queue.state==='settled','CALLBACK_QUEUE_SETTLED');
    const invocation=one(final.invocations.filter(i=>i.id===queue.invocation_id),'CALLBACK_INVOCATION_UNIQUE');require(invocation.status==='completed','CALLBACK_INVOCATION_COMPLETED');
    const event=one(final.outbox.filter(o=>o.source_id===message.id&&o.event_type==='message.created'),'CALLBACK_OUTBOX_UNIQUE');
    callbackLinks.push({callbackId:callback.id,kind:callback.kind,messageId:message.id,wakeId:wake.id,queueId:queue.id,invocationId:invocation.id,outboxId:event.id});
  }
  const before=r.evidence.find(e=>e.groups.length===1&&e.groups[0].state==='collecting'),after=r.evidence.find(e=>before&&e.pid!==before.pid&&e.groups.length===1&&e.groups[0].state==='collecting');
  require(before&&after&&same(before.groups,after.groups)&&after.effects.length===0,'ACTUAL_RESTART_ORIGINAL_GROUP_RETAINED');
  require(same(before.messages.find(m=>m.id===original.id),after.messages.find(m=>m.id===original.id)),'ACTUAL_RESTART_ORIGINAL_ANSWER_RETAINED');
  const effects=[...new Map(r.evidence.flatMap(e=>e.effects).map(e=>[e.requestId,e])).values()];
  require(effects.some(e=>e.agentId==='rc10-c'&&e.backend==='claude-sdk'&&e.generation),'ACTUAL_SDK_TRANSPORT_REQUIRED');
  require(effects.every(e=>e.realSupplier===r.realSupplier&&!e.localFault),'TRANSPORT_SCOPE_EXPLICIT');
  require(r.limitations.some(s=>s.includes('GitHub')&&s.includes('injected')),'INJECTED_PR_LIMITATION_REQUIRED');
  return{rootId:root.id,homeThreadId:home,workThreadId:work,publicRelayMessageId:relay.id,enteringMessageId:entering.id,
    returnedMessageId:returning.id,returnInvocationId:returnInvocation.id,returnResponseId:done.id,
    groupId:group.id,originalCMessageId:original.id,originalCBodySha256:digest(original.body),actionId:action.id,
    firstEvidenceId:first.evidenceId,finalEvidenceId:last.evidenceId,findingIds:first.findingIds,revisionMessageId:revision.messageId,
    callbackLinks,distinctTransportRequests:effects.length,realSupplier:r.realSupplier,actualIndexPids:r.actualPids.map(p=>p.pid),
    injectedGithubFacts:true,externalApprovalGranted:false};
}
const negativeControls=[
  {id:'detached_return_trigger',code:'RETURN_QUEUE_REQUIRED',mutate:r=>{const f=r.evidence.at(-1),t=f.toolReceipts.find(t=>t.name==='cross_post_message'&&parse(t.record).result.message.body.startsWith('RC10_RETURN')),id=parse(t.record).result.message.id;f.queue.find(q=>q.source_message_id===id).source_message_id='detached-original-trigger';}},
  {id:'vacuous_verified_findings',code:'WORKFLOW_FINDING_IDS_INHERITED',mutate:r=>{r.evidence.at(-1).workflows[0].findings=[];}},
  {id:'commented_without_changes_request',code:'FIRST_VERDICT_CHANGES_REQUEST_REQUIRED',mutate:r=>{const t=r.evidence.at(-1).toolReceipts.find(t=>t.name==='submit_review'&&parse(t.record).result.generation===1),record=parse(t.record);record.result.verdict='commented';t.record=JSON.stringify(record);}},
  {id:'duplicate_callback_wake',code:'CALLBACK_WAKE_UNIQUE',mutate:r=>{const f=r.evidence.at(-1),id=f.callbacks[0].message_id,w=structuredClone(f.wakes.find(w=>w.source_message_id===id));w.id+='-duplicate';f.wakes.push(w);}},
  {id:'missing_revision_finding_response',code:'REVISION_RESPONSES_COMPLETE',mutate:r=>{const f=r.evidence.at(-1),id=parse(f.toolReceipts.find(t=>t.name==='start_review_revision').record).result.messageId,m=f.messages.find(m=>m.id===id),body=parse(m.body);body.responses=[];m.body=JSON.stringify(body);}},
  {id:'reset_causal_root',code:'MESSAGE_ROOT_UNIFIED',mutate:r=>{const f=r.evidence.at(-1);f.messages.find(m=>m.origin==='agent_response').causal_root_id='invented-new-root';}},
];
let facts,failure;const controls=[];
try{
  facts=audit(report);
  for(const control of negativeControls){const changed=structuredClone(report);control.mutate(changed);let observed;
    try{audit(changed);}catch(error){observed=error.message;}
    require(observed===control.code,`NEGATIVE_CONTROL_FAILED:${control.id}:${observed??'accepted'}`);controls.push({id:control.id,rejected:true,reason:observed});}
}catch(error){failure={reason:error.message};process.exitCode=1;}
const result={schemaVersion:1,stage:'RC10',date:'2026-10-27',status:failure?'failed':'passed',
  scope:'Independent read-only audit of saved actual-index evidence, with in-memory mutated negative controls; no new behavioral acceptance groups, providers, GitHub or SQLite access',
  input:path.relative(process.cwd(),input),inputSha256:digest(bytes),behavioralAcceptanceGroupsAdded:0,externalRequests:0,
  assertions:['exact public handoff and cross-thread return trigger/Invocation/response','one causal root and cumulative budget root','original consultation reply and explicit timeout',
    'one canonical Action with two generations','nonempty changes-request findings inherited and verified by exact independent evidence','complete per-finding revision attestation without premature approval',
    'responsibility completion separate from current local approval','each callback has one message, wake, queue, completed Invocation and message.created outbox',
    'actual index restart preserves group and original SDK reply','real-model transport distinct from injected GitHub facts'],
  facts,negativeControls:controls,...(failure?{failure}:{})};
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,negativeControls:controls.length,behavioralAcceptanceGroupsAdded:0,output,...(failure?{failure}:{})}));
