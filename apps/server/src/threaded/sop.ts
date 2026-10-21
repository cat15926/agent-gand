import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {BackendTool} from './backends/types.ts';
import type {createThreadedCooperation} from './cooperation.ts';
import {digest,integer,object,reject,strings,text,type CollaborationOptions} from './collaborationTypes.ts';

const string={type:'string'},number={type:'integer'},list={type:'array',items:string,maxItems:100};
const descriptor=(name:string,description:string,properties:Record<string,unknown>,required:string[]):BackendTool=>({name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}});
export const THREADED_SOP_TOOLS:BackendTool[]=[
  descriptor('read_sop','Read an authorized SOP board or exact historical version. A board is descriptive and grants no execution ownership.',
    {sopKey:string,version:number},['sopKey']),
  descriptor('update_sop','CAS a descriptive SOP board. New boards expect version 0. Self-reported checks are unknown or attested; stage and baton do not transfer authority. Replacing checks removes their previous machine verification.',
    {idempotencyKey:string,sopKey:string,expectedVersion:number,title:string,stage:string,baton:{type:['string','null']},sourceRefs:list,
      checks:{type:'array',maxItems:100,items:{type:'object',properties:{id:string,label:string,state:{enum:['unknown','attested']},
        verificationRequirement:{type:'object',properties:{kind:{const:'task_done'},taskId:string},required:['kind','taskId'],additionalProperties:false}},required:['id','label','state'],additionalProperties:false}}},
    ['idempotencyKey','sopKey','expectedVersion']),
  descriptor('verify_sop_check','CAS one check using the registered task_done verifier. It proves only the exact platform task fact; prose, review approval and unregistered predicates cannot become verified.',
    {idempotencyKey:string,sopKey:string,expectedVersion:number,checkId:string,evidenceId:string},
    ['idempotencyKey','sopKey','expectedVersion','checkId','evidenceId']),
];

export interface ThreadedSopVerifiedFact {
  kind:'task_done';evidenceId:string;taskId:string;taskVersion:number;actionId:string;generation:number;
  criteriaHash:string;transitionId:string;actorId:string;actorIdentity:string;
}
export interface ThreadedSopCheck {
  id:string;label:string;state:'unknown'|'attested'|'verified';
  verificationRequirement?:{kind:'task_done';taskId:string;criteriaHash:string};
  attestedBy?:string;attestedAt?:number;verifiedAt?:number;verifiedFact?:ThreadedSopVerifiedFact;
}
export interface ThreadedSopRecord {
  id:string;sopKey:string;version:number;title:string;stage:string;baton:string|null;checks:ThreadedSopCheck[];
  visibility:'public'|'private';audience:string[];sourceRefs:string[];updatedBy:string;updatedAt:number;
}
type Row={id:string;owner_id:string;thread_id:string;sop_key:string;version:number;record:string;created_at:number};
type Actor={ownerId:string;threadId:string;agentId:string};
type TaskEvidence={transitionId:string;version:number;taskId:string;criteriaHash:string;acceptanceMessageIds:string[];actorIdentity:string};

type ReaderOptions={messages:Pick<CollaborationOptions['messages'],'getMessage'>};
function createSopReader(db:Database.Database,options:ReaderOptions) {
  // This is the existing cooperation identity fingerprint, derived through read-only DB queries.
  // No live execution Binding, claim coordinator or authority bypass is created for an Owner view.
  function actorIdentity(scope:Actor):string|null {
    const m=db.prepare(`SELECT m.version,m.permission_version,m.role_version,m.account_version,m.status,a.version agent_version,a.enabled,a.definition
      FROM threaded_members m JOIN agents a ON a.id=m.agent_id JOIN threaded_threads t ON t.id=m.thread_id AND t.owner_id=m.owner_id
      JOIN threaded_instances i ON i.instance_owner_id=t.owner_id AND i.singleton=1
      WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=?`).get(scope.ownerId,scope.threadId,scope.agentId) as
      {status:string;enabled:number;role_version:number;agent_version:number;definition:string}|undefined;
    if(!m||m.status!=='joined'||m.enabled!==1||m.role_version!==m.agent_version)return null;
    const definition=JSON.parse(m.definition) as {accountRef?:string};
    const account=definition.accountRef?db.prepare(`SELECT id,enabled,archived,config_version,credential_version,identity_generation FROM accounts
      WHERE id=? AND enabled=1 AND archived=0 AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`).get(definition.accountRef):null;
    if(definition.accountRef&&!account)return null;
    return digest({m,account});
  }
  function readable(scope:{ownerId:string;agentId?:string},id:string):boolean {
    const source=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,scope.ownerId) as {thread_id:string}|undefined;
    return !!source&&!!options.messages.getMessage({ownerId:scope.ownerId,threadId:source.thread_id,
      viewer:scope.agentId?{kind:'agent',agentId:scope.agentId}:{kind:'owner'}},id);
  }
  function assertSources(scope:{ownerId:string;agentId?:string},ids:string[]){
    if(!ids.every(id=>readable(scope,id)))reject('THREADED_SOP_SOURCE_FORBIDDEN',403);
  }
  function find(scope:{ownerId:string;threadId:string},key:string){return db.prepare('SELECT * FROM threaded_sops WHERE owner_id=? AND thread_id=? AND sop_key=?')
    .get(scope.ownerId,scope.threadId,key) as Row|undefined;}
  function stored(scope:{ownerId:string;threadId:string;agentId?:string},key:string,version?:number):ThreadedSopRecord {
    const row=find(scope,key);if(!row)reject('THREADED_SOP_NOT_FOUND',404);
    let record=row.record;
    if(version!==undefined){const historical=db.prepare('SELECT record FROM threaded_sop_versions WHERE sop_id=? AND version=?').get(row.id,version) as {record:string}|undefined;
      if(!historical)reject('THREADED_SOP_NOT_FOUND',404);record=historical.record;}
    const value=JSON.parse(record) as ThreadedSopRecord;assertSources(scope,value.sourceRefs);return value;
  }
  function requirement(scope:Actor,value:unknown):{requirement:NonNullable<ThreadedSopCheck['verificationRequirement']>;sourceRefs:string[]}{
    const req=object(value);
    if(req.kind!=='task_done'||Object.keys(req).some(k=>!['kind','taskId'].includes(k)))reject('THREADED_SOP_VERIFIER_UNREGISTERED',400);
    const taskId=text(req.taskId),task=db.prepare(`SELECT criteria_hash,source_record FROM threaded_task_ownership
      WHERE task_id=? AND owner_id=? AND thread_id=?`).get(taskId,scope.ownerId,scope.threadId) as {criteria_hash:string;source_record:string}|undefined;
    if(!task)reject('THREADED_SOP_REQUIREMENT_TASK_NOT_FOUND',404);
    const sourceRefs=(JSON.parse(task.source_record) as {sourceRefs:string[]}).sourceRefs;assertSources(scope,sourceRefs);
    return {requirement:{kind:'task_done',taskId,criteriaHash:task.criteria_hash},sourceRefs};
  }
  /** Trusted facts are re-derived from durable domain producers, never from a model-provided state or label. */
  function taskFact(scope:Actor,evidenceId:string):{fact:ThreadedSopVerifiedFact;sourceRefs:string[]} {
    const e=db.prepare(`SELECT e.*,a.owner_id,a.thread_id,a.generation current_generation,g.record generation_record
      FROM threaded_action_evidence e JOIN threaded_actions a ON a.id=e.action_id
      JOIN threaded_action_generations g ON g.action_id=e.action_id AND g.generation=e.generation
      WHERE e.id=? AND e.kind='task_transition' AND a.owner_id=? AND a.thread_id=?`)
      .get(evidenceId,scope.ownerId,scope.threadId) as {action_id:string;generation:number;agent_id:string;record:string;current_generation:number;generation_record:string}|undefined;
    if(!e||e.current_generation!==e.generation)reject('THREADED_SOP_TYPED_EVIDENCE_REQUIRED');
    const value=JSON.parse(e.record) as TaskEvidence,g=JSON.parse(e.generation_record) as {
      subject:{kind:string;taskId?:string};predicate:string;criteriaHash:string;holders:string[];scope:{sourceRefs:string[]}};
    if(g.subject.kind!=='task'||g.predicate!=='task_done'||g.subject.taskId!==value.taskId||g.criteriaHash!==value.criteriaHash
      ||!g.holders.includes(e.agent_id))reject('THREADED_SOP_TYPED_EVIDENCE_REQUIRED');
    const t=db.prepare(`SELECT t.status,t.assignee,t.acceptance_criteria,o.version,o.criteria_hash,o.source_record FROM tasks t
      JOIN threaded_task_ownership o ON o.task_id=t.id WHERE t.id=? AND o.owner_id=? AND o.thread_id=?`)
      .get(value.taskId,scope.ownerId,scope.threadId) as {status:string;assignee:string;acceptance_criteria:string;version:number;criteria_hash:string;source_record:string}|undefined;
    const transition=db.prepare(`SELECT t.record,b.agent_id,b.owner_id,b.thread_id FROM threaded_task_transitions t
      JOIN threaded_execution_bindings b ON b.id=t.binding_id WHERE t.id=? AND t.task_id=? AND t.version=? AND t.action_id=? AND t.generation=?`)
      .get(value.transitionId,value.taskId,value.version,e.action_id,e.generation) as {record:string;agent_id:string;owner_id:string;thread_id:string}|undefined;
    if(!t||!transition)reject('THREADED_SOP_TYPED_EVIDENCE_REQUIRED');
    const tr=JSON.parse(transition.record) as {to:string;actor:string;criteriaHash:string;assignee:string};
    if(t.status!=='completed'||t.assignee!==e.agent_id||t.version!==value.version||t.criteria_hash!==g.criteriaHash
      ||digest(JSON.parse(t.acceptance_criteria))!==g.criteriaHash||tr.to!=='completed'||tr.actor!==e.agent_id
      ||tr.assignee!==e.agent_id||tr.criteriaHash!==g.criteriaHash||transition.agent_id!==e.agent_id
      ||transition.owner_id!==scope.ownerId||transition.thread_id!==scope.threadId
      ||actorIdentity({...scope,agentId:e.agent_id})!==value.actorIdentity)reject('THREADED_SOP_EVIDENCE_STALE');
    const sourceRefs=[...new Set([...g.scope.sourceRefs,...(JSON.parse(t.source_record) as {sourceRefs:string[]}).sourceRefs,...value.acceptanceMessageIds])];
    assertSources(scope,sourceRefs);
    const criteria=JSON.parse(t.acceptance_criteria) as string[];
    if(value.acceptanceMessageIds.length!==criteria.length||value.acceptanceMessageIds.some(id=>{
      const m=options.messages.getMessage({ownerId:scope.ownerId,threadId:scope.threadId,viewer:{kind:'agent',agentId:scope.agentId}},id);
      return !m||m.state!=='published'||m.sender.agentId!==e.agent_id||!m.body.trim();
    }))reject('THREADED_SOP_TYPED_EVIDENCE_REQUIRED');
    return {fact:{kind:'task_done',evidenceId,taskId:value.taskId,taskVersion:value.version,actionId:e.action_id,generation:e.generation,
      criteriaHash:g.criteriaHash,transitionId:value.transitionId,actorId:e.agent_id,actorIdentity:value.actorIdentity},sourceRefs};
  }
  function projected(scope:{ownerId:string;threadId:string;agentId?:string},record:ThreadedSopRecord):ThreadedSopRecord {
    // Historical verification stays in history; current truth is checked separately on every read.
    return {...record,checks:record.checks.map(check=>{
      if(check.state!=='verified'||!check.verifiedFact)return check;
      try{
        if(!check.verificationRequirement||check.verificationRequirement.taskId!==check.verifiedFact.taskId
          ||check.verificationRequirement.criteriaHash!==check.verifiedFact.criteriaHash)return {...check,state:'unknown' as const};
        const actor=scope.agentId??check.verifiedFact.actorId;
        const current=taskFact({...scope,agentId:actor},check.verifiedFact.evidenceId);
        if(digest(current.fact)===digest(check.verifiedFact))return check;
      }catch{/* A missing verifier, revoked actor or changed domain fact is unknown, never cached success. */}
      return {...check,state:'unknown' as const};
    })};
  }
  function snapshot(ownerId:string,threadId:string):ThreadedSopRecord[]{
    return (db.prepare('SELECT * FROM threaded_sops WHERE owner_id=? AND thread_id=? ORDER BY updated_at DESC,id LIMIT 100').all(ownerId,threadId) as Row[])
      .flatMap(row=>{try{return [projected({ownerId,threadId},stored({ownerId,threadId},row.sop_key))];}catch{return [];}});
  }
  return {find,stored,taskFact,projected,snapshot,requirement};
}

/** Pure Owner projection; the calling HTTP view authenticates ownerId/threadId first. */
export function snapshotThreadedSops(db:Database.Database,options:ReaderOptions,ownerId:string,threadId:string):ThreadedSopRecord[]{
  return createSopReader(db,options).snapshot(ownerId,threadId);
}

export function createThreadedSop(db:Database.Database,options:CollaborationOptions&{cooperation:ReturnType<typeof createThreadedCooperation>}) {
  const c=options.cooperation,now=options.now??Date.now;
  const {find,stored,taskFact,projected,snapshot,requirement}=createSopReader(db,options);
  function assertWithin(){if(!db.inTransaction)reject('THREADED_SOP_TRANSACTION_REQUIRED');}
  function commit(binding:ThreadedBinding,previous:ThreadedSopRecord|undefined,record:ThreadedSopRecord):ThreadedSopRecord {
    const encoded=JSON.stringify(record);
    if(previous){const changed=db.prepare('UPDATE threaded_sops SET version=?,record=?,updated_at=? WHERE id=? AND version=?')
      .run(record.version,encoded,now(),record.id,previous.version);if(changed.changes!==1)reject('THREADED_SOP_VERSION_CONFLICT');}
    else db.prepare('INSERT INTO threaded_sops VALUES(?,?,?,?,?,?,?,?)').run(record.id,binding.ownerId,binding.threadId,record.sopKey,record.version,encoded,now(),now());
    db.prepare('INSERT INTO threaded_sop_versions VALUES(?,?,?,?,?)').run(record.id,record.version,binding.id,encoded,now());
    return projected(binding,record);
  }
  function executeWithin(binding:ThreadedBinding,name:string,input:Record<string,unknown>):ThreadedSopRecord {
    c.running(binding,name==='read_sop');const key=text(input.sopKey),row=find(binding,key);
    if(name==='read_sop')return projected(binding,stored(binding,key,input.version===undefined?undefined:integer(input.version,1,1e9)));
    if(!['update_sop','verify_sop_check'].includes(name))reject('THREADED_SOP_TOOL_UNSUPPORTED',400);
    assertWithin();text(input.idempotencyKey);
    const expectedVersion=integer(input.expectedVersion,0,1e9),previous=row?stored(binding,key):undefined;
    if((previous?.version??0)!==expectedVersion)reject('THREADED_SOP_VERSION_CONFLICT');
    if(name==='verify_sop_check'){
      if(!previous)reject('THREADED_SOP_NOT_FOUND',404);
      const checkId=text(input.checkId),check=previous.checks.find(v=>v.id===checkId);if(!check)reject('THREADED_SOP_CHECK_NOT_FOUND',404);
      if(!check.verificationRequirement)reject('THREADED_SOP_VERIFICATION_REQUIREMENT_REQUIRED');
      const verified=taskFact(binding,text(input.evidenceId));
      if(check.verificationRequirement.kind!==verified.fact.kind||check.verificationRequirement.taskId!==verified.fact.taskId
        ||check.verificationRequirement.criteriaHash!==verified.fact.criteriaHash)reject('THREADED_SOP_EVIDENCE_REQUIREMENT_MISMATCH');
      const scope=c.boundary(binding,[...previous.sourceRefs,...verified.sourceRefs]);
      return commit(binding,previous,{...previous,...scope,version:expectedVersion+1,updatedBy:binding.agentId,updatedAt:now(),
        checks:previous.checks.map(check=>check.id===checkId?{...check,state:'verified',verifiedFact:verified.fact,verifiedAt:now()}:check)});
    }
    let checks=previous?.checks??[];const requirementSources:string[]=[];
    if(input.checks!==undefined){if(!Array.isArray(input.checks)||input.checks.length>100)reject('THREADED_TOOL_INPUT_INVALID',400);
      checks=input.checks.map(raw=>{const check=object(raw);
        if(Object.keys(check).some(k=>!['id','label','state','verificationRequirement'].includes(k))||!['unknown','attested'].includes(String(check.state)))reject('THREADED_SOP_SELF_VERIFICATION_FORBIDDEN',403);
        const req=check.verificationRequirement===undefined?undefined:requirement(binding,check.verificationRequirement);
        if(req)requirementSources.push(...req.sourceRefs);
        const state=check.state as 'unknown'|'attested';return {id:text(check.id),label:text(check.label,2000),state,
          ...(req?{verificationRequirement:req.requirement}:{}),...(state==='attested'?{attestedBy:binding.agentId,attestedAt:now()}:{} )};});
      if(new Set(checks.map(c=>c.id)).size!==checks.length)reject('THREADED_TOOL_INPUT_INVALID',400);
    }
    const baton=input.baton===undefined?previous?.baton??null:input.baton===null?null:text(input.baton);
    if(baton&&!c.identity({...binding,agentId:baton}))reject('THREADED_SOP_BATON_MEMBER_REQUIRED',400);
    const refs=input.sourceRefs===undefined?[]:strings(input.sourceRefs),scope=c.boundary(binding,[...(previous?.sourceRefs??[]),...requirementSources,...refs]);
    return commit(binding,previous,{id:previous?.id??randomUUID(),sopKey:key,version:expectedVersion+1,
      title:input.title===undefined?previous?.title??key:text(input.title,1000),stage:input.stage===undefined?previous?.stage??'unknown':text(input.stage,200),
      baton,checks,...scope,updatedBy:binding.agentId,updatedAt:now()});
  }
  function privacySources(binding:ThreadedBinding,name:string,_input:Record<string,unknown>,result:unknown):string[] {
    if(!THREADED_SOP_TOOLS.some(t=>t.name===name))return [];
    const value=result as ThreadedSopRecord;
    return stored(binding,value.sopKey,value.version).sourceRefs;
  }
  function refreshResult(binding:ThreadedBinding,name:string,_input:Record<string,unknown>,result:unknown):unknown {
    if(!THREADED_SOP_TOOLS.some(t=>t.name===name))return result;
    const value=result as ThreadedSopRecord;
    return projected(binding,stored(binding,value.sopKey,value.version));
  }
  return {executeWithin,privacySources,refreshResult,snapshot};
}
