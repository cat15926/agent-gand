import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {createThreadedCooperation} from './cooperation.ts';
import type {createThreadedRouting} from './routing.ts';
import {digest,integer,object,reject,strings,text,type CollaborationOptions,type CollaborationTerminal} from './collaborationTypes.ts';
import type {ActionFence,ActionGeneration,ActionOptions,ActionSubject,PrFact} from './actionTypes.ts';

type ActionRow={id:string;owner_id:string;thread_id:string;subject_key:string;family:string;slot:string;
  generation:number;version:number;state:string;root_id:string};
type Prepared={fact:PrFact;authorization:string;at:number}|undefined;
export function createThreadedActions(db:Database.Database,options:CollaborationOptions&ActionOptions&{
  cooperation:ReturnType<typeof createThreadedCooperation>;routing:ReturnType<typeof createThreadedRouting>;
}) {
  const {cooperation:c,routing}=options,now=options.now??Date.now;
  const row=(id:string)=>db.prepare('SELECT * FROM threaded_actions WHERE id=?').get(id) as ActionRow|undefined;
  function readable(scope:{ownerId:string;agentId:string},id:string){
    const m=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,scope.ownerId) as {thread_id:string}|undefined;
    return !!m&&!!options.messages.getMessage({ownerId:scope.ownerId,threadId:m.thread_id,viewer:{kind:'agent',agentId:scope.agentId}},id);
  }
  function generation(a:ActionRow):ActionGeneration {
    return JSON.parse((db.prepare('SELECT record FROM threaded_action_generations WHERE action_id=? AND generation=?')
      .get(a.id,a.generation) as {record:string}).record) as ActionGeneration;
  }
  function capture(binding:Pick<ThreadedBinding,'invocationId'>):ActionFence|null {
    const value=db.prepare(`SELECT f.action_id,f.generation FROM threaded_invocation_wakes w JOIN threaded_action_message_fences f
      ON f.message_id=w.source_message_id JOIN threaded_action_holders h ON h.action_id=f.action_id AND h.generation=f.generation AND h.agent_id=w.agent_id
      WHERE w.invocation_id=?`).get(binding.invocationId) as {action_id:string;generation:number}|undefined;
    return value?{actionId:value.action_id,generation:value.generation}:null;
  }
  function valid(fence:ActionFence,agentId:string):boolean {
    return !!db.prepare(`SELECT 1 FROM threaded_actions a JOIN threaded_action_holders h ON h.action_id=a.id AND h.generation=a.generation
      WHERE a.id=? AND a.generation=? AND a.state='active' AND h.agent_id=? AND h.outcome IS NULL`).get(fence.actionId,fence.generation,agentId);
  }
  function assertBinding(binding:ThreadedBinding){const f=capture(binding);if(f&&!valid(f,binding.agentId))reject('THREADED_ACTION_STALE_GENERATION');}
  function bindMessage(messageId:string,fence:ActionFence|null){if(fence)db.prepare('INSERT OR IGNORE INTO threaded_action_message_fences VALUES(?,?,?)').run(messageId,fence.actionId,fence.generation);}
  function admission(messageId:string,agentId:string){const f=db.prepare('SELECT action_id,generation FROM threaded_action_message_fences WHERE message_id=?').get(messageId) as {action_id:string;generation:number}|undefined;
    if(!f)return true;
    const a=row(f.action_id);if(!a||a.generation!==f.generation)return false;
    // Ordinary A2A may ask a non-holder for help without granting that recipient business standing.
    const holder=db.prepare('SELECT 1 FROM threaded_action_holders WHERE action_id=? AND generation=? AND agent_id=?').get(a.id,a.generation,agentId);
    return !holder||valid({actionId:f.action_id,generation:f.generation},agentId);}
  function owned(binding:ThreadedBinding,id:string){const a=row(id);if(!a||a.owner_id!==binding.ownerId||a.thread_id!==binding.threadId)reject('THREADED_ACTION_NOT_FOUND',404);
    if(!generation(a).scope.sourceRefs.every(id=>readable(binding,id)))reject('THREADED_ACTION_SOURCE_FORBIDDEN',403);
    return a;
  }
  function held(binding:ThreadedBinding,input:Record<string,unknown>){const a=owned(binding,text(input.actionId));
    if(a.generation!==integer(input.expectedGeneration,1,1e9)||!valid({actionId:a.id,generation:a.generation},binding.agentId))reject('THREADED_ACTION_STALE_GENERATION');
    const fence=capture(binding);if(!fence||fence.actionId!==a.id||fence.generation!==a.generation)reject('THREADED_ACTION_DISPATCH_REQUIRED',403);
    return a;
  }
  function subject(value:unknown):ActionSubject {const s=object(value);
    if(s.kind==='task'&&Object.keys(s).every(k=>['kind','taskId'].includes(k)))return {kind:'task',taskId:text(s.taskId)};
    if(s.kind==='github_pr'&&Object.keys(s).every(k=>['kind','repository','number'].includes(k))){const repository=text(s.repository).toLowerCase();
      if(!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository))reject('THREADED_ACTION_SUBJECT_INVALID',400);
      return {kind:'github_pr',repository,number:integer(s.number,1,1e9)};}
    return reject('THREADED_ACTION_SUBJECT_INVALID',400);
  }
  const subjectKey=(s:ActionSubject)=>s.kind==='task'?`task:${s.taskId}`:`github_pr:${s.repository}#${s.number}`;
  function task(binding:ThreadedBinding,id:string){const t=db.prepare(`SELECT t.*,o.version,o.criteria_hash,o.creator_id,o.source_record FROM tasks t JOIN threaded_task_ownership o ON o.task_id=t.id
      WHERE t.id=? AND o.owner_id=? AND o.thread_id=?`).get(id,binding.ownerId,binding.threadId) as
      {id:string;status:string;assignee:string|null;acceptance_criteria:string;criteria_hash:string;creator_id:string;version:number;result:string|null;source_record:string}|undefined;
    if(!t)reject('THREADED_DOMAIN_TASK_NOT_FOUND',404);
    const source=JSON.parse(t.source_record) as {sourceRefs:string[]};
    if(!source.sourceRefs.every(id=>readable(binding,id)))reject('THREADED_DOMAIN_TASK_SOURCE_FORBIDDEN',403);
    return t;
  }
  async function prepare(binding:ThreadedBinding,name:string,input:Record<string,unknown>):Promise<Prepared>{
    c.running(binding,name==='read_action');if(name!=='read_action')assertBinding(binding);
    const s=name==='transfer_action'?subject(input.subject):['publish_action_review','complete_action'].includes(name)?generation(owned(binding,text(input.actionId))).subject:null;
    if(!s||s.kind!=='github_pr')return;
    if(db.inTransaction)reject('THREADED_ACTION_IO_IN_TRANSACTION');
    const auth=options.pr?.authorize(binding,s.repository);if(!auth)reject('THREADED_PR_SOURCE_NOT_INSTALLED',503);
    let fact:PrFact;
    try{fact=await options.pr!.current(binding,s);}catch{reject('THREADED_PR_UNVERIFIABLE',503);}
    c.running(binding);assertBinding(binding);
    if(options.pr?.authorize(binding,s.repository)?.fingerprint!==auth.fingerprint)reject('THREADED_PR_AUTHORITY_CHANGED',403);
    return {fact,authorization:auth.fingerprint,at:now()};
  }
  function pr(binding:ThreadedBinding,s:Extract<ActionSubject,{kind:'github_pr'}>,p:Prepared){
    const auth=options.pr?.authorize(binding,s.repository);
    if(!p||!auth||auth.fingerprint!==p.authorization||now()-p.at>30_000||p.fact.repository!==s.repository||p.fact.number!==s.number)
      reject('THREADED_PR_UNVERIFIABLE',503);
    return {auth,fact:p.fact};
  }
  function writeTask(binding:ThreadedBinding,id:string,next:{status:string;assignee:string|null;result:string|null},fence:ActionFence|null){
    const before=task(binding,id),evidenceId=randomUUID();
    db.prepare('INSERT INTO threaded_task_writes VALUES(?,?,?,?,?)').run(id,before.version,next.status,next.assignee,next.result);
    db.prepare('UPDATE tasks SET status=?,assignee=?,result=?,attempt=attempt+?,updated_at=? WHERE id=?')
      .run(next.status,next.assignee,next.result,before.status==='pending'&&next.status==='in_progress'?1:0,new Date(now()).toISOString(),id);
    db.prepare('DELETE FROM threaded_task_writes WHERE task_id=?').run(id);
    db.prepare('UPDATE threaded_task_ownership SET version=version+1 WHERE task_id=? AND version=?').run(id,before.version);
    db.prepare('INSERT INTO threaded_task_transitions VALUES(?,?,?,?,?,?,?,?)').run(evidenceId,id,before.version+1,binding.id,fence?.actionId??null,fence?.generation??null,
      JSON.stringify({from:before.status,to:next.status,actor:binding.agentId,criteriaHash:before.criteria_hash,result:next.result,assignee:next.assignee}),now());
    return {transitionId:evidenceId,version:before.version+1};
  }
  function evidence(a:ActionRow,agent:string,kind:string,value:unknown){const id=randomUUID();db.prepare('INSERT INTO threaded_action_evidence VALUES(?,?,?,?,?,?,?)')
    .run(id,a.id,a.generation,agent,kind,JSON.stringify(value),now());return id;}
  function dispatch(a:ActionRow,g:ActionGeneration,binding:ThreadedBinding){for(const target of g.holders){
    if(!c.identity({...binding,agentId:target}))reject('THREADED_ACTION_TARGET_UNAVAILABLE');
    if(!g.scope.sourceRefs.every(id=>readable({...binding,agentId:target},id)))reject('THREADED_ACTION_TARGET_SOURCE_FORBIDDEN',403);
  }
    const receipt=options.messages.postAgentMessageWithinTransaction({binding,toolCallId:`action:${a.id}:${a.generation}`,targets:g.holders,...g.scope,
      body:JSON.stringify({type:'action_assignment',actionId:a.id,generation:a.generation,subject:g.subject,predicate:g.predicate,
        freshness:g.freshness,parallelIntent:g.parallelIntent??null})});
    bindMessage(receipt.message.id,{actionId:a.id,generation:a.generation});
    routing.save(receipt,{targets:g.holders,strategy:g.holders.length>1?'parallel':'serial',intent:'execute',promptTags:[],intentExplicit:true,
      reason:'action_transfer',warnings:[],explicit:true},'action');
  }
  function storeGeneration(a:ActionRow,g:ActionGeneration){
    db.prepare('INSERT INTO threaded_action_generations VALUES(?,?,?,?)').run(a.id,a.generation,JSON.stringify(g),now());
    for(const agent of g.holders)db.prepare('INSERT INTO threaded_action_holders VALUES(?,?,?,NULL,NULL)').run(a.id,a.generation,agent);
  }
  function markReplaceable(a:ActionRow){
      db.prepare("UPDATE threaded_actions SET state='replaceable',version=version+1,updated_at=? WHERE id=? AND generation=? AND state='active'").run(now(),a.id,a.generation);
      const g=generation(a);c.callback('action_replaceable',`action-replaceable:${a.id}:${a.generation}`,g.predecessor.binding,g.predecessor.agentId,
        JSON.stringify({type:'action_replaceable',actionId:a.id,generation:a.generation}),g.scope,{frozen:{...g.frozen,identity:g.predecessor.identity,actionFence:null}});
  }
  function recordOutcome(a:ActionRow,agent:string,outcome:string,reason:unknown){
    const id=evidence(a,agent,'holder_outcome',{outcome,reason});
    db.prepare('UPDATE threaded_action_holders SET outcome=?,evidence_id=? WHERE action_id=? AND generation=? AND agent_id=? AND outcome IS NULL').run(outcome,id,a.id,a.generation,agent);
    const pending=db.prepare('SELECT 1 FROM threaded_action_holders WHERE action_id=? AND generation=? AND outcome IS NULL').get(a.id,a.generation);
    if(!pending)markReplaceable(a);
    return {evidenceId:id,state:row(a.id)!.state};
  }
  function commitCandidate(a:ActionRow,g:ActionGeneration,agentId:string,evidenceId:string,verified:boolean){
      const candidateId=randomUUID();db.prepare('INSERT INTO threaded_action_candidates VALUES(?,?,?,?,?,?,?)')
        .run(candidateId,a.id,a.generation,agentId,evidenceId,verified?'verified':'rejected',now());
      if(!verified)return {candidateId,state:a.state,verified:false,approvalGateSatisfied:false};
      db.prepare("UPDATE threaded_action_holders SET outcome='succeeded',evidence_id=? WHERE action_id=? AND generation=? AND agent_id=? AND outcome IS NULL")
        .run(evidenceId,a.id,a.generation,agentId);
      const unfinished=db.prepare("SELECT 1 FROM threaded_action_holders WHERE action_id=? AND generation=? AND (outcome IS NULL OR outcome<>'succeeded')").get(a.id,a.generation);
      if(!unfinished){db.prepare("UPDATE threaded_actions SET state='completed',version=version+1,updated_at=? WHERE id=? AND generation=? AND version=? AND state='active'")
          .run(now(),a.id,a.generation,a.version);
        const original=g.predecessor.binding;
        c.callback('action_completed',`action-completed:${a.id}:${a.generation}`,original,g.predecessor.agentId,
          JSON.stringify({type:'action_completed',actionId:a.id,generation:a.generation,predicate:g.predicate,approvalGateSatisfied:false}),g.scope,
          {frozen:{...g.frozen,identity:g.predecessor.identity,actionFence:null}});
      }
      else if(!db.prepare('SELECT 1 FROM threaded_action_holders WHERE action_id=? AND generation=? AND outcome IS NULL').get(a.id,a.generation))markReplaceable(a);
      c.recoverWithin();return {candidateId,verified:true,state:row(a.id)!.state,approvalGateSatisfied:false};
  }
  function transfer(binding:ThreadedBinding,input:Record<string,unknown>,p:Prepared,workflowRevision=false){
    const s=subject(input.subject),predicate=text(input.predicate),family=text(input.family),slot=text(input.successorSlot);
    if(slot!==(s.kind==='task'?'primary':'review'))reject('THREADED_ACTION_SUCCESSOR_SLOT_UNREGISTERED',400);
    if((s.kind==='task'&&(predicate!=='task_done'||family!=='work'))||(s.kind==='github_pr'&&(predicate!=='review_delivered'||family!=='review')))
      reject('THREADED_ACTION_PREDICATE_UNSUPPORTED',400);
    const operation=(input.operation??'transfer') as ActionGeneration['operation'];
    if(!['transfer','replace','return','revision'].includes(operation))reject('THREADED_ACTION_OPERATION_INVALID',400);
    let targets=strings(input.targets),parallelIntent=input.parallelIntent===undefined?undefined:text(input.parallelIntent,1000);
    if(!targets.length||targets.length>8||(targets.length>1&&!parallelIntent))reject('THREADED_ACTION_PARALLEL_INTENT_REQUIRED');
    const existing=db.prepare('SELECT * FROM threaded_actions WHERE owner_id=? AND subject_key=? AND family=? AND slot=?')
      .get(binding.ownerId,subjectKey(s),family,slot) as ActionRow|undefined;
    const prior=existing?generation(existing):undefined;
    if(existing&&operation==='revision'&&!workflowRevision&&(db.prepare('SELECT 1 FROM threaded_review_workflows WHERE action_id=?').get(existing.id)||db.prepare("SELECT 1 FROM threaded_action_evidence WHERE action_id=? AND kind='published_review'").get(existing.id)))reject('THREADED_REVIEW_REVISION_RESPONSES_REQUIRED');
    // Canonical identity is instance-wide, while standing and return routes remain frozen to their home Thread.
    if(existing&&existing.thread_id!==binding.threadId)reject('THREADED_ACTION_CANONICAL_CONFLICT');
    if(existing){owned(binding,existing.id);
      if(operation==='transfer')return {actionId:existing.id,generation:existing.generation,state:existing.state,
        holders:prior!.holders,admitted:false,outcome:'safe_wait'};
    }
    if(existing&&integer(input.expectedGeneration,1,1e9)!==existing.generation)reject('THREADED_ACTION_STALE_GENERATION');
    if(!existing&&operation!=='transfer')reject('THREADED_ACTION_NOT_FOUND',404);
    if(existing&&existing.root_id!==c.source(binding).causalRootId)reject('THREADED_ACTION_ROOT_MISMATCH');
    if(existing&&prior){
      const isPredecessor=prior.predecessor.agentId===binding.agentId&&prior.predecessor.threadId===binding.threadId
        &&prior.predecessor.identity===c.identity(binding);
      if(operation==='return'){
        held(binding,{actionId:existing.id,expectedGeneration:existing.generation});
        if(prior.holders.length>1)return {...recordOutcome(existing,binding.agentId,'rejected_ownership','parallel return records this holder outcome only'),
          actionId:existing.id,generation:existing.generation,returned:false,reason:'THREADED_ACTION_PARALLEL_RETURN_UNSUPPORTED'};
        targets=[prior.predecessor.agentId];parallelIntent=prior.parallelIntent;
        if(!isPredecessor&&targets[0]===binding.agentId)reject('THREADED_ACTION_RETURN_ROUTE_INVALID');
        if((input.targets as unknown[]).length!==1||(input.targets as unknown[])[0]!==targets[0])reject('THREADED_ACTION_RETURN_EXACT_PREDECESSOR_REQUIRED');
      }else if(!isPredecessor&&!(prior.operation==='return'&&valid({actionId:existing.id,generation:existing.generation},binding.agentId)))
        reject('THREADED_ACTION_STANDING_MISMATCH',403);
      if(operation==='replace'&&existing.state!=='replaceable'){
        const incoming=capture(binding);
        if(prior.operation!=='return'||!incoming||incoming.actionId!==existing.id||incoming.generation!==existing.generation
          ||!valid(incoming,binding.agentId))reject('THREADED_ACTION_REPLACEMENT_PROOF_REQUIRED');
      }
      if(existing.state==='completed'&&operation!=='revision')reject('THREADED_ACTION_ALREADY_COMPLETED');
      if(operation==='revision'&&existing.state!=='completed')reject('THREADED_ACTION_REVISION_REQUIRES_COMPLETION');
    }
    let freshness:string,standing:string,criteriaHash:string|undefined,prFact:PrFact|undefined;
    if(s.kind==='task'){
      const t=task(binding,s.taskId);
      if(t.status==='completed'||t.status==='cancelled'||t.status==='failed')reject('THREADED_ACTION_SUBJECT_TERMINAL');
      if(targets.length!==1)reject('THREADED_TASK_SINGLE_ASSIGNEE_REQUIRED');
      if(!existing&&![t.creator_id,t.assignee].includes(binding.agentId))reject('THREADED_ACTION_STANDING_MISMATCH',403);
      criteriaHash=t.criteria_hash;freshness=`task:${s.taskId}:criteria:${criteriaHash}`;standing=digest({creator:t.creator_id,criteriaHash});
    }else{
      const {auth,fact}=pr(binding,s,p);prFact=fact;freshness=`head:${fact.headSha}`;standing=prior?.standing??auth.fingerprint;
      if(existing&&prior&&operation==='replace'&&!workflowRevision&&freshness!==prior.freshness
        &&(db.prepare('SELECT 1 FROM threaded_review_workflows WHERE action_id=?').get(existing.id)||db.prepare("SELECT 1 FROM threaded_action_evidence WHERE action_id=? AND kind='published_review'").get(existing.id)))reject('THREADED_REVIEW_REVISION_RESPONSES_REQUIRED');
      if(prior&&options.pr?.authorize(prior.predecessor.binding,s.repository)?.fingerprint!==prior.standing)reject('THREADED_ACTION_STANDING_MISMATCH',403);
      if(!existing&&!auth.mayAssign)reject('THREADED_ACTION_STANDING_MISMATCH',403);
      for(const target of operation==='return'?[]:targets){const actor=options.pr?.authorize({...binding,agentId:target},s.repository);
        if(!actor||actor.githubLogin.toLowerCase()===fact.authorLogin)reject('THREADED_REVIEW_INDEPENDENT_REVIEWER_REQUIRED',403);}
      if(operation==='revision'&&prior?.freshness===freshness)reject('THREADED_ACTION_FRESH_REVISION_REQUIRED');
      if(operation==='return'&&prior){freshness=prior.freshness;prFact=prior.pr;}
    }
    const id=existing?.id??randomUUID(),nextGeneration=(existing?.generation??0)+1;
    if(existing){const result=db.prepare('UPDATE threaded_actions SET generation=generation+1,version=version+1,state=\'active\',updated_at=? WHERE id=? AND generation=? AND version=?')
      .run(now(),id,existing.generation,existing.version);if(result.changes!==1)reject('THREADED_ACTION_CAS_CONFLICT');}
    else db.prepare('INSERT INTO threaded_actions VALUES(?,?,?,?,?,?,1,1,\'active\',?,?,?)').run(id,binding.ownerId,binding.threadId,subjectKey(s),family,slot,c.source(binding).causalRootId,now(),now());
    const a=row(id)!;
    const g:ActionGeneration={subject:s,predicate:predicate as ActionGeneration['predicate'],freshness,standing,criteriaHash,pr:prFact,holders:targets,parallelIntent,
      predecessor:prior?.predecessor??{agentId:binding.agentId,threadId:binding.threadId,binding,identity:c.identity(binding)!},
      bindingId:binding.id,rootId:a.root_id,operation,scope:c.boundary(binding,[...(prior?.scope.sourceRefs??[]),
        ...(s.kind==='task'?(JSON.parse(task(binding,s.taskId).source_record) as {sourceRefs:string[]}).sourceRefs:[])]),frozen:prior?.frozen??c.frozen(binding)};
    storeGeneration(a,g);
    if(prFact)db.prepare(`INSERT INTO threaded_action_freshness VALUES(?,?,'verified',?,?,?)
      ON CONFLICT(action_id) DO UPDATE SET generation=excluded.generation,status=excluded.status,head_sha=excluded.head_sha,authorization=excluded.authorization,checked_at=excluded.checked_at`)
      .run(id,a.generation,prFact.headSha,standing,now());
    if(s.kind==='task'){const t=task(binding,s.taskId);writeTask(binding,t.id,{status:'in_progress',assignee:targets[0]!,result:null},{actionId:id,generation:nextGeneration});}
    dispatch(a,g,binding);c.recoverWithin();return {actionId:id,generation:nextGeneration,state:'active',holders:targets,admitted:true};
  }
  function executeWithin(binding:ThreadedBinding,name:string,input:Record<string,unknown>,p:Prepared):unknown {
    c.running(binding,name==='read_action');if(name!=='read_action')assertBinding(binding);
    if(name==='create_task'){
      const title=text(input.title,1000),criteria=strings(input.acceptanceCriteria,100);if(!criteria.length)reject('THREADED_TASK_ACCEPTANCE_REQUIRED');
      const id=randomUUID(),stamp=new Date(now()).toISOString();
      db.prepare(`INSERT INTO tasks(id,title,body,status,assignee,created_by,blocked_by,kind,acceptance_criteria,created_at,updated_at)
        VALUES(?,?,?,'pending',?,?,'[]','work',?,?,?)`).run(id,title,input.body===undefined?null:text(input.body,10_000),binding.agentId,binding.agentId,JSON.stringify(criteria),stamp,stamp);
      db.prepare('INSERT INTO threaded_task_ownership VALUES(?,?,?,?,1,?,?)').run(id,binding.ownerId,binding.threadId,binding.agentId,digest(criteria),JSON.stringify(c.boundary(binding)));
      return {taskId:id,version:1,status:'pending',acceptanceCriteria:criteria};
    }
    if(name==='transfer_action')return transfer(binding,input,p);
    if(name==='read_action'){
      const a=owned(binding,text(input.actionId)),g=generation(a);
      return {actionId:a.id,generation:a.generation,state:a.state,subject:g.subject,predicate:g.predicate,holders:g.holders,
        freshness:g.freshness,...(g.subject.kind==='task'?{task:task(binding,g.subject.taskId)}:{})};
    }
    const a=held(binding,input),g=generation(a),fence={actionId:a.id,generation:a.generation};
    if(name==='complete_task'){
      if(g.subject.kind!=='task'||g.predicate!=='task_done')reject('THREADED_ACTION_PREDICATE_MISMATCH');
      const t=task(binding,g.subject.taskId);if(t.version!==integer(input.expectedTaskVersion,1,1e9)||t.status!=='in_progress'||t.assignee!==binding.agentId||t.criteria_hash!==g.criteriaHash)
        reject('THREADED_TASK_STATE_VERSION_CONFLICT');
      const refs=strings(input.acceptanceMessageIds,100),criteria=JSON.parse(t.acceptance_criteria) as string[];
      if(refs.length!==criteria.length)reject('THREADED_TASK_ACCEPTANCE_EVIDENCE_REQUIRED');
      for(const id of refs){const m=options.messages.getMessage({ownerId:binding.ownerId,threadId:binding.threadId,viewer:{kind:'agent',agentId:binding.agentId}},id);
        if(!m||m.sender.agentId!==binding.agentId||m.state!=='published'||!m.body.trim()||m.sourceInvocationId!==binding.invocationId)reject('THREADED_TASK_ACCEPTANCE_SOURCE_INVALID',403);}
      const result=text(input.result,20_000),transition=writeTask(binding,t.id,{status:'completed',assignee:t.assignee,result},fence);
      const evidenceId=evidence(a,binding.agentId,'task_transition',{...transition,taskId:t.id,criteriaHash:g.criteriaHash,acceptanceMessageIds:refs,actorIdentity:c.identity(binding)});
      return {...transition,evidenceId,status:'completed',actionCompleted:false};
    }
    if(name==='publish_action_review'){
      if(!db.prepare('SELECT 1 FROM threaded_review_legacy_admissions WHERE action_id=? AND generation=?').get(a.id,a.generation)
        ||db.prepare('SELECT 1 FROM threaded_review_workflows WHERE action_id=?').get(a.id))reject('THREADED_REVIEW_FULL_CONTRACT_REQUIRED');
      if(g.subject.kind!=='github_pr')reject('THREADED_ACTION_PREDICATE_MISMATCH');
      const {auth,fact}=pr(binding,g.subject,p),head=text(input.reviewedHeadSha).toLowerCase();
      if(fact.headSha!==g.pr?.headSha||head!==fact.headSha)reject('THREADED_REVIEW_STALE_HEAD');
      if(auth.githubLogin.toLowerCase()===fact.authorLogin)reject('THREADED_REVIEW_INDEPENDENT_REVIEWER_REQUIRED',403);
      const verdict=text(input.verdict);if(!['approved','changes_requested','commented'].includes(verdict))reject('THREADED_REVIEW_VERDICT_INVALID',400);
      const findings=strings(input.findings,100);if(verdict==='changes_requested'&&!findings.length)reject('THREADED_REVIEW_FINDINGS_REQUIRED');
      const body=text(input.body,50_000),receipt=routing.postWithin(binding,`review:${text(input.idempotencyKey)}`,{body,targets:[],...c.boundary(binding)});
      bindMessage(receipt.message.id,fence);
      const evidenceId=evidence(a,binding.agentId,'published_review',{repository:g.subject.repository,number:g.subject.number,headSha:head,
        reviewer:binding.agentId,githubLogin:auth.githubLogin,authorization:auth.fingerprint,messageId:receipt.message.id,verdict,findings,acceptedSource:'thread'});
      return {evidenceId,messageId:receipt.message.id,verdict,reviewedHeadSha:head,approvalGateSatisfied:false};
    }
    if(name==='complete_action'){
      const evidenceId=text(input.evidenceId),e=db.prepare('SELECT * FROM threaded_action_evidence WHERE id=? AND action_id=? AND generation=? AND agent_id=?')
        .get(evidenceId,a.id,a.generation,binding.agentId) as {kind:string;record:string}|undefined;
      if(!e)reject('THREADED_ACTION_TYPED_EVIDENCE_REQUIRED');
      const value=JSON.parse(e.record) as Record<string,unknown>;let verified=false;
      if(g.subject.kind==='task'&&e.kind==='task_transition'){
        const t=task(binding,g.subject.taskId),transition=db.prepare('SELECT record FROM threaded_task_transitions WHERE id=? AND task_id=? AND version=? AND action_id=? AND generation=?')
          .get(value.transitionId,g.subject.taskId,t.version,a.id,a.generation) as {record:string}|undefined;
        verified=t.status==='completed'&&t.assignee===binding.agentId&&t.criteria_hash===g.criteriaHash&&!!transition&&JSON.parse(transition.record).to==='completed';
      }else if(g.subject.kind==='github_pr'&&e.kind==='published_review'){
        const {fact,auth}=pr(binding,g.subject,p),m=options.messages.getMessage({ownerId:binding.ownerId,threadId:binding.threadId,viewer:{kind:'agent',agentId:binding.agentId}},text(value.messageId));
        if(fact.headSha!==g.pr?.headSha||fact.headSha!==value.headSha)reject('THREADED_REVIEW_STALE_HEAD');
        verified=!!m&&m.state==='published'&&m.sender.agentId===binding.agentId&&value.acceptedSource==='thread'
          &&value.authorization===auth.fingerprint&&auth.githubLogin.toLowerCase()!==fact.authorLogin;
        db.prepare(`INSERT INTO threaded_action_freshness VALUES(?,?,'verified',?,?,?) ON CONFLICT(action_id)
          DO UPDATE SET generation=excluded.generation,status=excluded.status,head_sha=excluded.head_sha,authorization=excluded.authorization,checked_at=excluded.checked_at`)
          .run(a.id,a.generation,fact.headSha,auth.fingerprint,now());
      }
      return commitCandidate(a,g,binding.agentId,evidenceId,verified);
    }
    if(name==='action_outcome'){
      if(g.subject.kind==='task'&&task(binding,g.subject.taskId).status==='completed')reject('THREADED_ACTION_DOMAIN_COMPLETION_PENDING');
      const outcome=text(input.outcome);if(!['failed','cancelled','unavailable','rejected_ownership'].includes(outcome))reject('THREADED_ACTION_OUTCOME_INVALID',400);
      return recordOutcome(a,binding.agentId,outcome,text(input.reason,2000));
    }
    return reject('THREADED_ACTION_TOOL_UNSUPPORTED',400);
  }
  async function refreshFreshness(){const result:Array<{actionId:string;status:string}>=[];
    for(const a of db.prepare("SELECT * FROM threaded_actions WHERE family='review'").all() as ActionRow[]){
      const g=generation(a);if(g.subject.kind!=='github_pr')continue;
      const source=options.pr,scope=g.predecessor.binding,auth=source?.authorize(scope,g.subject.repository);
      let status='unverifiable',head:string|null=null;
      if(source&&auth&&auth.fingerprint===g.standing)try{const fact=await source.current(scope,g.subject);
        if(source.authorize(scope,g.subject.repository)?.fingerprint===auth.fingerprint){head=fact.headSha;status=head===g.pr?.headSha?'verified':'stale';}}catch{/* no cached acceptance */}
      c.transaction(()=>{const current=row(a.id);if(!current||current.generation!==a.generation)return;
        db.prepare(`INSERT INTO threaded_action_freshness VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,head_sha=excluded.head_sha,authorization=excluded.authorization,checked_at=excluded.checked_at`)
          .run(a.id,a.generation,status,head,auth?.fingerprint??null,now());});
      result.push({actionId:a.id,status});
    }return result;
  }
  function snapshot(ownerId:string,threadId:string){return (db.prepare('SELECT * FROM threaded_actions WHERE owner_id=? AND thread_id=? ORDER BY updated_at DESC LIMIT 100').all(ownerId,threadId) as ActionRow[]).flatMap(a=>{
    const g=generation(a);if(g.scope.sourceRefs.some(id=>!options.messages.getMessage({ownerId,threadId,viewer:{kind:'owner'}},id)))return [];
    const holders=db.prepare('SELECT agent_id agentId,outcome FROM threaded_action_holders WHERE action_id=? AND generation=?').all(a.id,a.generation) as Array<{agentId:string;outcome:string|null}>;
    const check=db.prepare('SELECT * FROM threaded_action_freshness WHERE action_id=? AND generation=?').get(a.id,a.generation) as {status:string;checked_at:number}|undefined;
    const freshnessStatus=g.subject.kind==='task'?'verified':check&&now()-check.checked_at<=30_000?check.status:'unverifiable';
    return [{id:a.id,subject:g.subject,predicate:g.predicate,generation:a.generation,state:a.state,holders,freshness:g.freshness,freshnessStatus,
      approvalGateSatisfied:false as const}];});}
  function onTerminalWithin(input:CollaborationTerminal){
    if(input.status==='completed')return;
    // A known failed/cancelled Invocation cannot overwrite an already committed legitimate task_done producer fact.
    recoverWithin();
    const f=capture(input.binding);if(!f||!valid(f,input.binding.agentId))return;
    recordOutcome(row(f.actionId)!,input.binding.agentId,input.status,{invocationId:input.binding.invocationId,quiescence:input.quiescence.id});
  }
  function privacySources(binding:ThreadedBinding,name:string,input:Record<string,unknown>,result:unknown):string[]{
    if(!['create_task','read_action','transfer_action','complete_task','publish_action_review','complete_action','action_outcome'].includes(name))return [];
    const value=object(result),id=value.actionId??input.actionId;
    if(typeof id==='string')return generation(owned(binding,id)).scope.sourceRefs;
    if(name==='create_task'&&typeof value.taskId==='string')return (JSON.parse(task(binding,value.taskId).source_record) as {sourceRefs:string[]}).sourceRefs;
    return [];
  }
  function recoverWithin(){
    // A producer may have committed task_done before the process lost the candidate/projection step.
    // Resolve only the exact durable platform transition; a completed Invocation is never a candidate.
    for(const e of db.prepare(`SELECT e.* FROM threaded_action_evidence e JOIN threaded_actions a ON a.id=e.action_id AND a.generation=e.generation
      JOIN threaded_action_holders h ON h.action_id=a.id AND h.generation=a.generation AND h.agent_id=e.agent_id
      WHERE e.kind='task_transition' AND a.state='active' AND h.outcome IS NULL
        AND NOT EXISTS(SELECT 1 FROM threaded_action_candidates c WHERE c.evidence_id=e.id)`).all() as Array<{id:string;action_id:string;generation:number;agent_id:string;record:string}>){
      const a=row(e.action_id)!,g=generation(a);if(g.subject.kind!=='task')continue;
      const value=JSON.parse(e.record) as {transitionId:string;version:number;criteriaHash:string;acceptanceMessageIds:string[];actorIdentity:string};
      const scope={...g.predecessor.binding,agentId:e.agent_id};
      if(value.actorIdentity!==c.identity(scope)||!g.scope.sourceRefs.every(id=>readable(scope,id)))continue;
      const t=task(scope,g.subject.taskId);
      const transition=db.prepare('SELECT record FROM threaded_task_transitions WHERE id=? AND task_id=? AND version=? AND action_id=? AND generation=?')
        .get(value.transitionId,t.id,t.version,a.id,a.generation) as {record:string}|undefined;
      const verified=t.status==='completed'&&t.assignee===e.agent_id&&t.version===value.version&&t.criteria_hash===g.criteriaHash
        &&value.actorIdentity===c.identity(scope)&&!!transition&&JSON.parse(transition.record).to==='completed'
        &&value.acceptanceMessageIds.every(id=>!!options.messages.getMessage({ownerId:a.owner_id,threadId:a.thread_id,viewer:{kind:'agent',agentId:e.agent_id}},id));
      commitCandidate(a,g,e.agent_id,e.id,verified);
    }
    for(const v of db.prepare(`SELECT a.id action_id,a.generation,h.agent_id,q.id,q.reason FROM threaded_actions a
      JOIN threaded_action_holders h ON h.action_id=a.id AND h.generation=a.generation AND h.outcome IS NULL
      JOIN threaded_action_message_fences f ON f.action_id=a.id AND f.generation=a.generation
      JOIN threaded_message_routes r ON r.message_id=f.message_id AND r.kind='action'
      JOIN threaded_wakes w ON w.source_message_id=f.message_id AND w.target_agent_id=h.agent_id
      JOIN threaded_wake_queue q ON q.wake_id=w.id WHERE a.state='active' AND q.state='cancelled'`).all() as
      Array<{action_id:string;generation:number;agent_id:string;id:string;reason:string}>){
      if(valid({actionId:v.action_id,generation:v.generation},v.agent_id))recordOutcome(row(v.action_id)!,v.agent_id,'unavailable',{queueId:v.id,reason:v.reason});
    }
  }
  function reviewRevisionWithin(binding:ThreadedBinding,input:Record<string,unknown>,p:Prepared){
    c.running(binding);if(!db.inTransaction||!['revision','replace'].includes(String(input.operation))||object(input.subject).kind!=='github_pr')reject('THREADED_REVIEW_REVISION_INTERNAL_REQUIRED');
    return transfer(binding,input,p,true);
  }
  return {prepare,executeWithin,reviewRevisionWithin,capture,valid,assertBinding,bindMessage,admission,snapshot,held,generation,owned,refreshFreshness,onTerminalWithin,recoverWithin,
    privacySources,assertReadable(binding:ThreadedBinding,id:string){if(!readable(binding,id))reject('THREADED_ACTION_SOURCE_FORBIDDEN',403);}};
}
