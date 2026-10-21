import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {BackendTool} from './backends/types.ts';
import type {createThreadedActions} from './actions.ts';
import type {createThreadedCooperation} from './cooperation.ts';
import type {createThreadedRouting} from './routing.ts';
import type {ActionOptions,ActionGeneration,PrFact} from './actionTypes.ts';
import {object,text,strings,integer,digest,reject,type CollaborationOptions} from './collaborationTypes.ts';

const s={type:'string'},n={type:'integer'},list={type:'array',items:s,maxItems:100};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]):BackendTool=>({name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}});
export const THREADED_REVIEW_TOOLS:BackendTool[]=[
  tool('review_context','Read the exact accepted request, immutable HEAD, author route and finding IDs for this review responsibility.',{actionId:s},['actionId']),
  tool('submit_review','Publish one ordinary A2A review to the exact different author/predecessor. The server verifies accepted source/revision/current HEAD; responsibility completion and approval remain separate.',{
    idempotencyKey:s,actionId:s,expectedGeneration:n,expectedVersion:n,authorAgentId:s,acceptedSourceMessageId:s,acceptedRevision:n,reviewedHeadSha:s,
    verdict:{enum:['approved','changes_requested','commented']},findings:list,resolvedFindingIds:list,body:s},
    ['idempotencyKey','actionId','expectedGeneration','expectedVersion','authorAgentId','acceptedSourceMessageId','acceptedRevision','reviewedHeadSha','verdict','findings','resolvedFindingIds','body']),
  tool('start_review_revision','Attest responses to every open finding and request an independent review of a new live HEAD under the same causal root. Self-reported fixes do not verify findings.',{
    idempotencyKey:s,actionId:s,expectedGeneration:n,expectedVersion:n,targets:list,parallelIntent:s,
    responses:{type:'array',maxItems:100,items:{type:'object',properties:{findingId:s,body:s,disposition:{enum:['addressed','disputed','deferred']}},required:['findingId','body','disposition'],additionalProperties:false}}},
    ['idempotencyKey','actionId','expectedGeneration','expectedVersion','targets','responses']),
  tool('read_review_workflow','Read a current or historical review version with current source authorization. Does not grant approval.',{actionId:s,version:n},['actionId']),
  tool('check_review_gate','Re-read live GitHub HEAD and current reviewer permissions to check the local independent-review gate. Never merges or publishes to GitHub.',{actionId:s,expectedVersion:n},['actionId','expectedVersion']),
];
export const REVIEW_READ_TOOLS=new Set(['review_context','read_review_workflow','check_review_gate']);
type Finding={id:string;text:string;openedHeadSha:string;openedEvidenceId:string;reviewerId:string;state:'open'|'attested'|'verified';resolutionEvidenceId:string|null};
type Report={evidenceId:string;messageId:string;verdict:string;reviewerId:string;authorization:string;identity:string;headSha:string;acceptedSourceMessageId:string;acceptedRevision:number};
export type ThreadedReviewWorkflow={actionId:string;version:number;generation:number;headSha:string;rootId:string;state:'awaiting_review'|'changes_requested'|'reviewed'|'awaiting_re_review';
  requiredReviewers:string[];acceptedSourceMessageId:string;acceptedRevision:number;authorAgentId:string;findings:Finding[];reports:Record<string,Report>;
  scope:ActionGeneration['scope'];updatedAt:number};
type Prepared={fact:PrFact|null;authorization:string|null;at:number;actionPrepared?:Awaited<ReturnType<ReturnType<typeof createThreadedActions>['prepare']>>};
export function createThreadedReviews(db:Database.Database,options:CollaborationOptions&ActionOptions&{
  actions:ReturnType<typeof createThreadedActions>;cooperation:ReturnType<typeof createThreadedCooperation>;routing:ReturnType<typeof createThreadedRouting>;
}){
  const {actions,cooperation:c}=options,now=options.now??Date.now;
  const load=(id:string)=>{const row=db.prepare('SELECT record FROM threaded_review_workflows WHERE action_id=?').get(id) as {record:string}|undefined;return row?JSON.parse(row.record) as ThreadedReviewWorkflow:undefined;};
  function source(binding:ThreadedBinding,id:string){actions.assertReadable(binding,id);const row=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,binding.ownerId) as {thread_id:string};
    return options.messages.getMessage({ownerId:binding.ownerId,threadId:row.thread_id,viewer:{kind:'agent',agentId:binding.agentId}},id)!;}
  function action(binding:ThreadedBinding,id:string){const a=actions.owned(binding,id),g=actions.generation(a);if(g.subject.kind!=='github_pr')reject('THREADED_REVIEW_SUBJECT_REQUIRED',400);return {a,g};}
  function accepted(binding:ThreadedBinding,id:string,generation:number){const row=db.prepare(`SELECT m.id FROM threaded_action_message_fences f JOIN threaded_message_routes r ON r.message_id=f.message_id AND r.kind='action'
    JOIN threaded_messages m ON m.id=f.message_id WHERE f.action_id=? AND f.generation=? ORDER BY m.rowid LIMIT 1`).get(id,generation) as {id:string}|undefined;
    if(!row)reject('THREADED_REVIEW_ACCEPTED_REQUEST_REQUIRED');const message=source(binding,row.id);if(message.state!=='published')reject('THREADED_REVIEW_ACCEPTED_REQUEST_REQUIRED');return message;}
  function originalAuthor(id:string){const first=db.prepare('SELECT record FROM threaded_action_generations WHERE action_id=? ORDER BY generation LIMIT 1').get(id) as {record:string};return (JSON.parse(first.record) as ActionGeneration).predecessor;}
  function visible(binding:ThreadedBinding,w:ThreadedReviewWorkflow){for(const id of w.scope.sourceRefs)source(binding,id);return w;}
  function save(binding:ThreadedBinding,next:ThreadedReviewWorkflow,previous?:ThreadedReviewWorkflow){
    if(previous){const r=db.prepare('UPDATE threaded_review_workflows SET version=?,generation=?,head_sha=?,record=?,updated_at=? WHERE action_id=? AND version=?')
      .run(next.version,next.generation,next.headSha,JSON.stringify(next),now(),next.actionId,previous.version);if(r.changes!==1)reject('THREADED_REVIEW_VERSION_CONFLICT');}
    else db.prepare('INSERT INTO threaded_review_workflows VALUES(?,?,?,?,?,?,?,?)').run(next.actionId,binding.ownerId,binding.threadId,next.version,next.generation,next.headSha,JSON.stringify(next),now());
    db.prepare('INSERT INTO threaded_review_versions VALUES(?,?,?,?,?,?)').run(next.actionId,next.version,next.generation,next.headSha,JSON.stringify(next),now());
  }
  function current(binding:ThreadedBinding,id:string){const {a,g}=action(binding,id),request=accepted(binding,id,a.generation),prior=load(id);
    if(prior)visible(binding,prior);
    if(prior&&prior.generation===a.generation)return {a,g,w:prior};
    const legacy=prior?[]:db.prepare("SELECT id,agent_id,record FROM threaded_action_evidence WHERE action_id=? AND kind='published_review' ORDER BY rowid").all(id) as Array<{id:string;agent_id:string;record:string}>;
    const legacyReports=legacy.map(e=>({...e,value:JSON.parse(e.record) as {messageId:string;findings:string[];headSha:string}}));
    for(const report of legacyReports)source(binding,report.value.messageId);
    const w:ThreadedReviewWorkflow={actionId:id,version:(prior?.version??0)+1,generation:a.generation,headSha:g.pr!.headSha,rootId:a.root_id,
      state:prior?'awaiting_re_review':'awaiting_review',requiredReviewers:g.holders,acceptedSourceMessageId:request.id,acceptedRevision:request.seq,authorAgentId:prior?.authorAgentId??originalAuthor(id).agentId,
      findings:prior?prior.findings.map(f=>({...f,state:'open',resolutionEvidenceId:null})):legacyReports.flatMap(e=>(e.value.findings??[]).map((body,index):Finding=>({id:`${e.id}:${index}`,text:body,openedHeadSha:e.value.headSha,openedEvidenceId:e.id,reviewerId:e.agent_id,state:'open',resolutionEvidenceId:null}))),
      reports:{},scope:c.boundary(binding,[...(prior?.scope.sourceRefs??[]),...g.scope.sourceRefs,request.id,...legacyReports.map(e=>e.value.messageId)]),updatedAt:now()};
    return {a,g,w};
  }
  async function prepare(binding:ThreadedBinding,name:string,input:Record<string,unknown>):Promise<Prepared|undefined>{
    if(!THREADED_REVIEW_TOOLS.some(t=>t.name===name))return;
    c.running(binding,REVIEW_READ_TOOLS.has(name));const {a,g}=action(binding,text(input.actionId));
    if(name==='review_context'||name==='read_review_workflow')return;
    if(db.inTransaction)reject('THREADED_REVIEW_IO_IN_TRANSACTION');
    const subject=g.subject as Extract<typeof g.subject,{kind:'github_pr'}>,auth=options.pr?.authorize(binding,subject.repository);
    if(!auth){if(name==='check_review_gate')return {fact:null,authorization:null,at:now()};reject('THREADED_PR_SOURCE_NOT_INSTALLED',503);}
    let fact:PrFact|null=null;try{fact=await options.pr!.current(binding,subject);}catch{if(name!=='check_review_gate')reject('THREADED_PR_UNVERIFIABLE',503);}
    c.running(binding,REVIEW_READ_TOOLS.has(name));action(binding,text(input.actionId));
    if(options.pr?.authorize(binding,subject.repository)?.fingerprint!==auth.fingerprint)reject('THREADED_PR_AUTHORITY_CHANGED',403);
    const p:Prepared={fact,authorization:auth.fingerprint,at:now()};
    if(name==='start_review_revision')p.actionPrepared=await actions.prepare(binding,'transfer_action',{subject,predicate:'review_delivered',family:'review',successorSlot:'review',targets:input.targets,
      operation:a.state==='completed'?'revision':'replace',expectedGeneration:input.expectedGeneration,...(input.parallelIntent===undefined?{}:{parallelIntent:input.parallelIntent})});
    return p;
  }
  function live(binding:ThreadedBinding,g:ActionGeneration,p:Prepared|undefined){const subject=g.subject as Extract<typeof g.subject,{kind:'github_pr'}>;
    const auth=options.pr?.authorize(binding,subject.repository);if(!p||!p.fact||!auth||auth.fingerprint!==p.authorization||now()-p.at>30_000
      ||p.fact.repository!==subject.repository||p.fact.number!==subject.number)reject('THREADED_PR_UNVERIFIABLE',503);return {auth,fact:p.fact};}
  function expected(input:Record<string,unknown>,w:ThreadedReviewWorkflow,existing?:ThreadedReviewWorkflow){if(integer(input.expectedVersion,0,1e9)!==(existing?.version??0))reject('THREADED_REVIEW_VERSION_CONFLICT');
    if(input.expectedGeneration!==undefined&&integer(input.expectedGeneration,1,1e9)!==w.generation)reject('THREADED_ACTION_STALE_GENERATION');}
  function projection(binding:ThreadedBinding,w:ThreadedReviewWorkflow){visible(binding,w);return {...w,approvalGateSatisfied:false};}
  function executeWithin(binding:ThreadedBinding,name:string,input:Record<string,unknown>,p?:Prepared):unknown{
    if(!db.inTransaction)reject('THREADED_REVIEW_TRANSACTION_REQUIRED');
    c.running(binding,REVIEW_READ_TOOLS.has(name));const id=text(input.actionId),{a,g,w}=current(binding,id),existing=load(id);
    if(name==='review_context')return {actionId:id,generation:a.generation,workflowVersion:existing?.version??0,headSha:g.pr!.headSha,subject:g.subject,
      acceptedSourceMessageId:w.acceptedSourceMessageId,acceptedRevision:w.acceptedRevision,authorAgentId:w.authorAgentId,findings:w.findings};
    if(name==='read_review_workflow'){
      if(input.version!==undefined){const row=db.prepare('SELECT record FROM threaded_review_versions WHERE action_id=? AND version=?').get(id,integer(input.version,1,1e9)) as {record:string}|undefined;
        if(!row)reject('THREADED_REVIEW_VERSION_NOT_FOUND',404);return projection(binding,JSON.parse(row.record) as ThreadedReviewWorkflow);}
      return projection(binding,w);
    }
    if(name==='check_review_gate'){
      expected(input,w,existing);let status:'approved'|'blocked'|'stale'|'unverifiable'='blocked';const reasons:string[]=[];
      const callerAuth=g.subject.kind==='github_pr'?options.pr?.authorize(binding,g.subject.repository):null;
      if(!p?.fact||!p.authorization||callerAuth?.fingerprint!==p.authorization||now()-p.at>30_000){status='unverifiable';reasons.push('LIVE_HEAD_UNVERIFIABLE');}
      else if(p.fact.headSha!==w.headSha||a.generation!==w.generation){status='stale';reasons.push('HEAD_OR_GENERATION_CHANGED');}
      else{
        if(a.state!=='completed')reasons.push('REVIEW_RESPONSIBILITY_NOT_COMPLETED');
        for(const agentId of w.requiredReviewers){const r=w.reports[agentId],auth=g.subject.kind==='github_pr'?options.pr?.authorize({...binding,agentId},g.subject.repository):null;
          if(!r||r.verdict!=='approved'||r.headSha!==w.headSha){reasons.push('REQUIRED_REVIEW_NOT_APPROVED');continue;}
          if(!auth||auth.fingerprint!==r.authorization||auth.githubLogin.toLowerCase()===p.fact.authorLogin||c.identity({...binding,agentId})!==r.identity){status='unverifiable';reasons.push('REVIEWER_AUTHORITY_CHANGED');continue;}
          const candidate=db.prepare("SELECT 1 FROM threaded_action_candidates WHERE action_id=? AND generation=? AND agent_id=? AND evidence_id=? AND verdict='verified'").get(id,w.generation,agentId,r.evidenceId);
          if(!candidate)reasons.push('REVIEW_DELIVERY_NOT_RESOLVED');source(binding,r.messageId);source(binding,r.acceptedSourceMessageId);
        }
        if(w.findings.some(f=>f.state!=='verified'))reasons.push('FINDINGS_NOT_INDEPENDENTLY_VERIFIED');
        if(!reasons.length)status='approved';
      }
      const checkId=randomUUID(),result={checkId,actionId:id,generation:w.generation,workflowVersion:existing?.version??0,headSha:w.headSha,status,
        approvalGateSatisfied:status==='approved',reasons,checkedAt:now(),scope:'local_independent_review',externalApprovalGranted:false};
      db.prepare('INSERT INTO threaded_review_gate_checks VALUES(?,?,?,?,?,?,?,?)').run(checkId,id,w.generation,existing?.version??0,w.headSha,status,JSON.stringify({...result,sourceRefs:w.scope.sourceRefs}),now());return result;
    }
    const {auth,fact}=live(binding,g,p);expected(input,w,existing);
    if(name==='submit_review'){
      actions.held(binding,input);if(fact.headSha!==g.pr!.headSha||text(input.reviewedHeadSha).toLowerCase()!==fact.headSha)reject('THREADED_REVIEW_STALE_HEAD');
      if(auth.githubLogin.toLowerCase()===fact.authorLogin)reject('THREADED_REVIEW_INDEPENDENT_REVIEWER_REQUIRED',403);
      const target=text(input.authorAgentId);if(target!==w.authorAgentId||target===binding.agentId||!c.identity({...binding,agentId:target}))reject('THREADED_REVIEW_AUTHOR_ROUTE_INVALID',403);
      if(text(input.acceptedSourceMessageId)!==w.acceptedSourceMessageId||integer(input.acceptedRevision,1,1e12)!==w.acceptedRevision)reject('THREADED_REVIEW_ACCEPTED_SOURCE_MISMATCH');
      const verdict=text(input.verdict),findings=strings(input.findings,100),resolved=strings(input.resolvedFindingIds,100);
      if(!['approved','changes_requested','commented'].includes(verdict)||verdict==='changes_requested'&&!findings.length)reject('THREADED_REVIEW_VERDICT_INVALID',400);
      if(resolved.some(id=>!w.findings.some(f=>f.id===id))||resolved.length&&verdict!=='approved')reject('THREADED_REVIEW_FINDING_REFERENCE_INVALID',400);
      const scope=c.boundary(binding,[...w.scope.sourceRefs,w.acceptedSourceMessageId]);for(const ref of scope.sourceRefs)source({...binding,agentId:target},ref);
      const receipt=options.messages.postAgentMessageWithinTransaction({binding,toolCallId:`review:${text(input.idempotencyKey)}`,body:text(input.body,50_000),targets:[target],...scope});
      // This ordinary A2A callback wakes the author without granting reviewer execution standing.
      const evidenceId=randomUUID(),record={repository:fact.repository,number:fact.number,headSha:fact.headSha,reviewer:binding.agentId,githubLogin:auth.githubLogin,
        authorization:auth.fingerprint,messageId:receipt.message.id,verdict,findings,acceptedSource:'thread',acceptedSourceRef:w.acceptedSourceMessageId,acceptedRevision:w.acceptedRevision,
        reviewSubjectRef:`pr:${fact.repository}#${fact.number}`,authorAgentId:target};
      db.prepare('INSERT INTO threaded_action_evidence VALUES(?,?,?,?,?,?,?)').run(evidenceId,id,a.generation,binding.agentId,'published_review',JSON.stringify(record),now());
      db.prepare('INSERT INTO threaded_review_reports VALUES(?,?,?,?,?)').run(evidenceId,id,a.generation,receipt.message.id,JSON.stringify(record));
      const report:Report={evidenceId,messageId:receipt.message.id,verdict,reviewerId:binding.agentId,authorization:auth.fingerprint,identity:c.identity(binding)!,headSha:fact.headSha,
        acceptedSourceMessageId:w.acceptedSourceMessageId,acceptedRevision:w.acceptedRevision};
      const updated:ThreadedReviewWorkflow={...w,version:(existing?.version??0)+1,reports:{...w.reports,[binding.agentId]:report},
        findings:[...w.findings.map(f=>resolved.includes(f.id)?{...f,state:'verified' as const,resolutionEvidenceId:evidenceId}:f),
          ...findings.map((body,index):Finding=>({id:`${evidenceId}:${index}`,text:body,openedHeadSha:fact.headSha,openedEvidenceId:evidenceId,reviewerId:binding.agentId,state:'open',resolutionEvidenceId:null}))],
        state:verdict==='changes_requested'?'changes_requested':'reviewed',scope:{...scope,sourceRefs:[...new Set([...scope.sourceRefs,receipt.message.id])]},updatedAt:now()};
      save(binding,updated,existing);return {actionId:id,generation:a.generation,version:updated.version,evidenceId,messageId:receipt.message.id,
        findingIds:updated.findings.map(f=>f.id),verdict,actionCompleted:false,approvalGateSatisfied:false};
    }
    if(name==='start_review_revision'){
      const returned=g.operation==='return'&&actions.valid({actionId:id,generation:a.generation},binding.agentId);
      if((!['completed','replaceable'].includes(a.state)&&!returned)||fact.headSha===w.headSha)reject('THREADED_REVIEW_FRESH_REVISION_REQUIRED');
      const author=originalAuthor(id);
      if(c.source(binding).causalRootId!==w.rootId||binding.agentId!==w.authorAgentId||c.identity(binding)!==author.identity||!auth.mayAssign)
        reject('THREADED_REVIEW_REVISION_STANDING_REQUIRED',403);
      if(!Array.isArray(input.responses)||input.responses.length>100)reject('THREADED_REVIEW_RESPONSES_INVALID',400);
      const responses=input.responses.map(v=>{const r=object(v);if(Object.keys(r).some(k=>!['findingId','body','disposition'].includes(k)))reject('THREADED_REVIEW_RESPONSES_INVALID',400);
        const disposition=text(r.disposition);if(!['addressed','disputed','deferred'].includes(disposition))reject('THREADED_REVIEW_RESPONSES_INVALID',400);return {findingId:text(r.findingId),body:text(r.body,5000),disposition};});
      const open=w.findings.filter(f=>f.state!=='verified').map(f=>f.id);
      if(new Set(responses.map(r=>r.findingId)).size!==responses.length||digest([...open].sort())!==digest(responses.map(r=>r.findingId).sort()))reject('THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      const scope=c.boundary(binding,w.scope.sourceRefs),message=options.messages.postAgentMessageWithinTransaction({binding,toolCallId:`revision:${text(input.idempotencyKey)}`,targets:[],...scope,
        body:JSON.stringify({type:'revision_attestation',actionId:id,oldHeadSha:w.headSha,newHeadSha:fact.headSha,responses,verification:'attested'})});
      const transferred=actions.reviewRevisionWithin(binding,{idempotencyKey:`revision:${text(input.idempotencyKey)}`,subject:g.subject,predicate:'review_delivered',family:'review',successorSlot:'review',
        operation:a.state==='completed'?'revision':'replace',expectedGeneration:a.generation,targets:strings(input.targets),...(input.parallelIntent===undefined?{}:{parallelIntent:text(input.parallelIntent,1000)})},p?.actionPrepared) as {generation:number};
      const next=action(binding,id);if(next.g.pr!.headSha!==fact.headSha)reject('THREADED_REVIEW_HEAD_CHANGED_DURING_ADMISSION');
      // Adopt legacy v32 delivery facts as immutable unapproved history before admitting a fresh round.
      if(!existing)save(binding,w);
      const previous=existing??w;
      const request=accepted(binding,id,transferred.generation),updated:ThreadedReviewWorkflow={...w,version:previous.version+1,generation:transferred.generation,headSha:fact.headSha,
        state:'awaiting_re_review',requiredReviewers:next.g.holders,acceptedSourceMessageId:request.id,acceptedRevision:request.seq,reports:{},
        findings:w.findings.map(f=>({...f,state:responses.some(r=>r.findingId===f.id&&r.disposition==='addressed')?'attested':'open',resolutionEvidenceId:null})),
        scope:c.boundary(binding,[...scope.sourceRefs,message.message.id,request.id]),updatedAt:now()};
      save(binding,updated,previous);const claimId=randomUUID();db.prepare('INSERT INTO threaded_review_revision_claims VALUES(?,?,?,?,?,?,?)')
        .run(claimId,id,a.generation,transferred.generation,message.message.id,JSON.stringify({responses,oldHeadSha:w.headSha,newHeadSha:fact.headSha,verification:'attested',actor:binding.agentId}),now());
      return {actionId:id,generation:transferred.generation,version:updated.version,claimId,messageId:message.message.id,verification:'attested',approvalGateSatisfied:false};
    }
    return reject('THREADED_REVIEW_TOOL_UNSUPPORTED',400);
  }
  function privacySources(binding:ThreadedBinding,name:string,input:Record<string,unknown>,result:unknown){if(!THREADED_REVIEW_TOOLS.some(t=>t.name===name))return [];
    const {w}=current(binding,text(input.actionId));const r=object(result);const historical=name==='read_review_workflow'&&input.version!==undefined?r as unknown as ThreadedReviewWorkflow:w;
    visible(binding,historical);return historical.scope.sourceRefs;
  }
  return {prepare,executeWithin,privacySources};
}
