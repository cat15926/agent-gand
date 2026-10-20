import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { createThreadedCooperation } from './cooperation.ts';
import type { CollaborationMessages } from './collaborationTypes.ts';
import {digest,reject,text} from './collaborationTypes.ts';
export type TrackingScope={ownerId:string;threadId:string;agentId:string};
export interface ThreadedTrackingSource {
  /** Current immutable authority/configuration fingerprint, or null when access is denied. */
  authorization(scope:TrackingScope,subject:string):string|null;
  /** Read live facts outside any SQLite transaction; no caller-provided URL or credentials. */
  observe(scope:TrackingScope,subject:string,previous?:Record<string,unknown>):Promise<Array<{key:string;event:Record<string,unknown>}>>;
}
export function createThreadedTracking(db:Database.Database,cooperation:ReturnType<typeof createThreadedCooperation>,sources:Record<string,ThreadedTrackingSource>) {
  async function observe(scope:TrackingScope,name:string,subject:string) {
    if(db.inTransaction)reject('THREADED_TRACKING_IO_IN_TRANSACTION');
    const source=sources[name],authorization=source?.authorization(scope,subject);
    if(!source||!authorization)reject('THREADED_TRACKING_SOURCE_NOT_AUTHORIZED',403);
    const prior=db.prepare(`SELECT record FROM threaded_tracking_events WHERE owner_id=? AND source=? AND subject=?
      AND json_extract(record,'$.__authorization')=? AND COALESCE(json_extract(record,'$.__baseline'),0)=0 ORDER BY seq DESC LIMIT 1`)
      .get(scope.ownerId,name,subject,authorization) as {record:string}|undefined;
    const events=await source.observe(scope,subject,prior?JSON.parse(prior.record) as Record<string,unknown>:undefined);
    if(source.authorization(scope,subject)!==authorization)reject('THREADED_TRACKING_AUTHORITY_CHANGED',403);
    if(events.length>1000)reject('THREADED_TRACKING_EVENT_LIMIT');
    for(const event of events)cooperation.recordTrackingEvent({ownerId:scope.ownerId,source:name,subject,
      eventKey:digest({authorization,key:text(event.key)}),event:{...Object.fromEntries(Object.entries(event.event).filter(([k])=>!k.startsWith('__'))),__authorization:authorization}});
    if(!events.length)cooperation.recordTrackingEvent({ownerId:scope.ownerId,source:name,subject,eventKey:`baseline:${authorization}`,
      event:{__baseline:true,__authorization:authorization}});
    return {authorization};
  }
  return {sources,
    async prepare(binding:ThreadedBinding,source:string,subject:string){cooperation.running(binding);const result=await observe(binding,source,subject);cooperation.running(binding);return result;},
    async refresh() {
      const results:Array<{waitId:string;status:string}>=[];
      const waits=db.prepare("SELECT id,owner_id,thread_id,agent_id,record FROM threaded_waits WHERE kind='tracking' AND state='awaiting'").all() as Array<{
        id:string;owner_id:string;thread_id:string;agent_id:string;record:string}>;
      for(const wait of waits){const record=JSON.parse(wait.record) as {source:string;subject:string;trackingAuthorization:string};
        const scope={ownerId:wait.owner_id,threadId:wait.thread_id,agentId:wait.agent_id};
        if(sources[record.source]?.authorization(scope,record.subject)!==record.trackingAuthorization){
          cooperation.transaction(()=>db.prepare("UPDATE threaded_waits SET state='withdrawn',version=version+1,outcome=? WHERE id=? AND state='awaiting'")
            .run(JSON.stringify({type:'tracking_authority_changed',businessConditionVerified:false}),wait.id));
          results.push({waitId:wait.id,status:'authority_changed'});continue;
        }
        try{await observe(scope,record.source,record.subject);results.push({waitId:wait.id,status:'observed'});}
        catch{results.push({waitId:wait.id,status:'unavailable'});}
      }
      cooperation.recover();return results;
    },
  };
}
export function threadedMessageTrackingSource(db:Database.Database,messages:CollaborationMessages):ThreadedTrackingSource {
  return {authorization(scope,subject){if(subject!==scope.threadId)return null;const member=db.prepare(`SELECT m.version,m.permission_version,m.role_version,a.definition,a.enabled
      FROM threaded_members m JOIN agents a ON a.id=m.agent_id WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=? AND m.status='joined' AND a.enabled=1 AND m.role_version=a.version`)
      .get(scope.ownerId,subject,scope.agentId);return member?digest(member):null;},
    async observe(scope,subject,previous){
      const rows=previous?db.prepare('SELECT id FROM threaded_messages WHERE owner_id=? AND thread_id=? AND seq>? ORDER BY seq').iterate(scope.ownerId,subject,Number(previous.seq??0))
        :db.prepare('SELECT id FROM threaded_messages WHERE owner_id=? AND thread_id=? ORDER BY seq DESC').iterate(scope.ownerId,subject);
      const result:Array<{key:string;event:Record<string,unknown>}>=[];
      for(const row of rows as Iterable<{id:string}>){const m=messages.getMessage({ownerId:scope.ownerId,threadId:subject,viewer:{kind:'agent',agentId:scope.agentId}},row.id);if(!m)continue;
        result.push({key:m.id,event:{type:'message',messageId:m.id,seq:m.seq,origin:m.origin,sender:m.sender.agentId??m.sender.kind}});
        if(!previous||result.length===1000)break;}
      return result;
    }};
}
/** Optional server-installed GitHub adapter. Repository allowlist and authenticated transport never come from model input. */
export function githubPrTrackingSource(input:{authorize:(scope:TrackingScope,repository:string)=>string|null;
  fetch:(path:string)=>Promise<{head:{sha:string};state:string;merged:boolean;merge_commit_sha:string|null;updated_at:string}>}):ThreadedTrackingSource {
  const parse=(subject:string)=>{const m=/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(subject);return m?{repository:m[1]!,number:m[2]!}:null;};
  return {authorization(scope,subject){const parsed=parse(subject);return parsed?input.authorize(scope,parsed.repository):null;},
    async observe(scope,subject,previous){const parsed=parse(subject);if(!parsed||!input.authorize(scope,parsed.repository))reject('THREADED_TRACKING_SOURCE_NOT_AUTHORIZED',403);
      const pr=await input.fetch(`/repos/${parsed.repository}/pulls/${parsed.number}`);
      const event={type:'github_pr',headSha:text(pr.head.sha),state:text(pr.state),merged:pr.merged,mergeCommitSha:pr.merge_commit_sha};
      if(previous&&digest(event)===digest(Object.fromEntries(Object.entries(previous).filter(([k])=>!k.startsWith('__')))))return [];
      return [{key:digest({updatedAt:pr.updated_at,event}),event}];}};
}
