import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {ActionCommandPort,ActionScope,CommandObservation} from './actionTypes.ts';
import type {QuiescenceProof,ThreadedClaimIdentity} from './contracts.ts';
import type {ResourceClaimRecord,ResourceEvidence} from '../execution/resources/types.ts';

const guardian=fileURLToPath(new URL('../execution/guardian.mjs',import.meta.url));
const fail=(code:string):never=>{throw new Error(code);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export interface ThreadedOsCommandRegistration {
  id:string;
  /** All process inputs are server-owned. There is deliberately no model argument substitution. */
  program:string;argv:readonly string[];cwd:string;environment:Readonly<Record<string,string>>;
  authorization(scope:ActionScope):string|null;
  /** A trusted domain verifier, never a model assertion. No verifier means effects remain unresolved. */
  reconcileSideEffects?(input:{commandId:string;scope:ActionScope;exit:{code:number|null;signal:string|null}|null;cancelled:boolean}):boolean;
}
export interface ThreadedOsCommandLease {
  /** Reserve an independent command lease. A completed Invocation must not free a still-running command's workspace. */
  reserve(input:{commandId:string;binding:ThreadedBinding;cwd:string}):ThreadedClaimIdentity;
  assertExecutable(claim:ThreadedClaimIdentity):void;
  markStarted(claim:ThreadedClaimIdentity):void;
  markUnknown(claim:ThreadedClaimIdentity):void;
  recordQuiescence(claim:ThreadedClaimIdentity,evidence:ResourceEvidence):QuiescenceProof;
  release(claim:ThreadedClaimIdentity,proof:QuiescenceProof):void;
}
type ProcessFact={pid:number;pgid:number;start:string;status:string;command:string};
type ProcessRecord={host:string;cwd:string;token:string;stage:'intent'|'registered'|'launch_authorized'|'running';
  pid?:number;pgid?:number;startIdentity?:string;ipcClosed?:boolean;cancelRequested?:boolean;
  exit?:{code:number|null;signal:string|null};spawnError?:string;groupStopped?:boolean;effectsReconciled?:boolean;
  proofEventId?:string;resourceReleased?:boolean};
type Row={command_id:string;registration_id:string;authorization:string;owner_id:string;thread_id:string;agent_id:string;
  binding_id:string;claim_record:string|null;registration_hash:string;state:CommandObservation['state'];record:string;created_at:number;updated_at:number};
/** Inspection failure is unknown. ps exit and an empty, successfully parsed snapshot are different facts. */
function processes():ProcessFact[]|null {
  try {
    const output=execFileSync('/bin/ps',['-axww','-o','pid=,pgid=,lstart=,stat=,command='],{encoding:'utf8',timeout:1500,maxBuffer:8*1024*1024});
    const facts:ProcessFact[]=[];
    for(const line of output.split('\n')) {
      if(!line.trim())continue;
      const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d+)\s+(\S+)\s+(.+)$/);
      if(!match)return null;
      facts.push({pid:Number(match[1]),pgid:Number(match[2]),start:match[3]!,status:match[4]!,command:match[5]!});
    }
    return facts.length?facts:null;
  }catch{return null;}
}
const owned=(record:ProcessRecord,fact:ProcessFact|undefined)=>!!fact&&fact.pid===record.pid&&fact.pgid===record.pid&&
  fact.pgid===record.pgid&&fact.start===record.startIdentity&&!fact.status.startsWith('Z')&&
  fact.command.includes(guardian)&&fact.command.endsWith(` ${record.token}`);
function exactClaim(a:ThreadedClaimIdentity,b:ThreadedClaimIdentity):boolean {
  return !!a&&!!b&&(Object.keys(a) as Array<keyof ThreadedClaimIdentity>).every(key=>a[key]===b[key])&&Object.keys(a).length===Object.keys(b).length;
}
/** The coordinator consumes this immutable reference; a successful signal syscall is never resource evidence. */
export function verifyThreadedOsCommandResourceEvidence(db:Database.Database,claim:ResourceClaimRecord,evidence:ResourceEvidence):boolean {
  const id=evidence.reference?.startsWith('threaded-os-command:')?evidence.reference.slice('threaded-os-command:'.length):null;
  if(!id||claim.request.mode!=='threaded'||evidence.reason!=='reconciled'||evidence.sideEffects!=='reconciled')return false;
  const event=db.prepare("SELECT e.record,c.claim_record FROM threaded_os_command_events e JOIN threaded_os_commands c ON c.command_id=e.command_id WHERE e.id=? AND e.kind='quiescence'")
    .get(id) as {record:string;claim_record:string|null}|undefined;
  if(!event?.claim_record)return false;
  const fact=JSON.parse(event.record) as {claim:ThreadedClaimIdentity;groupStopped:boolean;effectsReconciled:boolean};
  return fact.groupStopped===true&&fact.effectsReconciled===true&&exactClaim(fact.claim,claim.identity)&&
    exactClaim(JSON.parse(event.claim_record) as ThreadedClaimIdentity,claim.identity);
}
/** macOS POSIX command adapter; registration is explicit and there are no production default registrations. */
export function createThreadedOsCommandPort(db:Database.Database,options:{registration:ThreadedOsCommandRegistration;
  lease:ThreadedOsCommandLease;now?:()=>number}):ActionCommandPort&{close():void} {
  if(process.platform!=='darwin')fail('THREADED_OS_COMMAND_PLATFORM_UNVERIFIED');
  if(!options.lease)fail('THREADED_OS_COMMAND_RESOURCES_REQUIRED');
  const registration=options.registration,now=options.now??Date.now;
  if(!registration.id||!path.isAbsolute(registration.program)||!path.isAbsolute(registration.cwd)||
    realpathSync(registration.program)!==registration.program||realpathSync(registration.cwd)!==registration.cwd||
    !statSync(registration.program).isFile()||!statSync(registration.cwd).isDirectory())fail('THREADED_OS_COMMAND_REGISTRATION_INVALID');
  if(!Array.isArray(registration.argv)||registration.argv.some(v=>typeof v!=='string'||v.includes('\0'))||
    Object.entries(registration.environment).some(([key,value])=>!key||key.includes('=')||key.includes('\0')||typeof value!=='string'||value.includes('\0')))
    fail('THREADED_OS_COMMAND_REGISTRATION_INVALID');
  // Copy all static process input. Mutation of the caller's configuration cannot change an accepted command.
  const program=registration.program,argv=[...registration.argv],cwd=registration.cwd,environment={...registration.environment};
  const fingerprint=hash({id:registration.id,program,argv,cwd,environment}),children=new Map<string,ChildProcess>();
  const row=(id:string)=>db.prepare('SELECT * FROM threaded_os_commands WHERE command_id=?').get(id) as Row|undefined;
  const scope=(r:Row):ActionScope=>({ownerId:r.owner_id,threadId:r.thread_id,agentId:r.agent_id});
  const parse=(r:Row)=>JSON.parse(r.record) as ProcessRecord;
  function update(id:string,kind:string,change:(record:ProcessRecord)=>void,state?:CommandObservation['state']) {
    return db.transaction(()=>{const current=row(id)??fail('THREADED_OS_COMMAND_NOT_FOUND'),record=parse(current);change(record);
      const eventId=randomUUID();db.prepare('INSERT INTO threaded_os_command_events(id,command_id,kind,record,created_at) VALUES(?,?,?,?,?)')
        .run(eventId,id,kind,JSON.stringify(record),now());
      db.prepare('UPDATE threaded_os_commands SET record=?,state=?,updated_at=? WHERE command_id=?').run(JSON.stringify(record),state??current.state,now(),id);
      return {row:row(id)!,eventId};
    }).immediate();
  }
  function authorized(r:Row,input:ActionScope) {
    if(r.owner_id!==input.ownerId||r.thread_id!==input.threadId||r.agent_id!==input.agentId)fail('THREADED_OS_COMMAND_NOT_FOUND');
    if(r.registration_id!==registration.id||r.registration_hash!==fingerprint||registration.authorization(input)!==r.authorization)
      fail('THREADED_OS_COMMAND_AUTHORITY_CHANGED');
  }
  function observation(r:Row):CommandObservation {
    const record=parse(r);return {state:r.state,evidenceRef:record.proofEventId?`threaded-os-command:${record.proofEventId}`:`threaded-os-command-record:${r.command_id}`,
      result:JSON.stringify({processStopped:record.groupStopped===true,effectsReconciled:record.effectsReconciled===true,
        resourceReleased:record.resourceReleased===true,exit:record.exit??null})};
  }
  function release(r:Row) {
    if(!options.lease||!r.claim_record)return;
    let record=parse(r);if(record.resourceReleased||!record.groupStopped||!record.effectsReconciled)return;
    const claim=JSON.parse(r.claim_record) as ThreadedClaimIdentity;
    if(!record.proofEventId){const eventId=randomUUID();db.transaction(()=>{
      db.prepare('INSERT INTO threaded_os_command_events(id,command_id,kind,record,created_at) VALUES(?,?,?,?,?)')
        .run(eventId,r.command_id,'quiescence',JSON.stringify({claim,groupStopped:true,effectsReconciled:true,process:record}),now());
      record={...record,proofEventId:eventId};db.prepare('UPDATE threaded_os_commands SET record=?,updated_at=? WHERE command_id=?')
        .run(JSON.stringify(record),now(),r.command_id);
    }).immediate();}
    const proof=options.lease.recordQuiescence(claim,{reason:'reconciled',sideEffects:'reconciled',reference:`threaded-os-command:${record.proofEventId}`});
    options.lease.release(claim,proof);update(r.command_id,'resource_released',value=>{value.resourceReleased=true;});
  }
  function refresh(id:string):CommandObservation {
    let current=row(id)??fail('THREADED_OS_COMMAND_NOT_FOUND'),record=parse(current);
    if(record.host!==hostname())return {state:'unknown',evidenceRef:'threaded-os-command-host-unknown'};
    const facts=processes();if(!facts||!record.pid||!record.startIdentity)return {...observation(current),state:'unknown'};
    const leader=facts.find(f=>f.pid===record.pid),liveGroup=facts.some(f=>f.pgid===record.pgid&&!f.status.startsWith('Z'));
    if(liveGroup){
      if(!owned(record,leader)){if(options.lease&&current.claim_record&&!record.resourceReleased)options.lease.markUnknown(JSON.parse(current.claim_record));
        return {state:'unknown',evidenceRef:'threaded-os-command-identity-unknown'};}
      return {...observation(current),state:record.stage==='running'&&!record.cancelRequested?'running':'unknown'};
    }
    // No live group is a stop fact. Completion additionally needs the native exit receipt; cancellation needs a durable request.
    const reconciled=record.effectsReconciled===true||registration.reconcileSideEffects?.({commandId:id,scope:scope(current),exit:record.exit??null,cancelled:record.cancelRequested===true})===true;
    const state:CommandObservation['state']=!reconciled?'unknown':record.cancelRequested?'cancelled':record.exit?(record.exit.code===0?'completed':'failed'):'unknown';
    if(!record.groupStopped||record.effectsReconciled!==reconciled||current.state!==state)current=update(id,'group_stopped',r=>{r.groupStopped=true;r.effectsReconciled=reconciled;},state).row;
    if(state==='unknown'&&options.lease&&current.claim_record&&!record.resourceReleased)options.lease.markUnknown(JSON.parse(current.claim_record));
    release(current);return observation(row(id)!);
  }
  const validate=(value:unknown)=>{if(value!==undefined&&value!==null&&!(typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0))fail('THREADED_OS_COMMAND_ARGUMENTS_FORBIDDEN');};
  return {
    authorization:scope=>registration.authorization(scope),validate,
    async start(input) {
      validate(input.args);let existing=row(input.commandId);
      if(existing){authorized(existing,input.binding);if(existing.binding_id!==input.binding.id)fail('THREADED_OS_COMMAND_BINDING_MISMATCH');return refresh(input.commandId);}
      const authorization=registration.authorization(input.binding);if(!authorization)fail('THREADED_OS_COMMAND_NOT_AUTHORIZED');
      if(realpathSync(program)!==program||realpathSync(cwd)!==cwd)fail('THREADED_OS_COMMAND_REGISTRATION_CHANGED');
      // An intent is irrevocable even if the launcher dies before obtaining a PID. Retry observes unknown; it never spawns again.
      let won=false;db.transaction(()=>{
        existing=row(input.commandId);if(existing)return;
        const record:ProcessRecord={host:hostname(),cwd,token:randomUUID(),stage:'intent'};
        db.prepare('INSERT INTO threaded_os_commands(command_id,registration_id,authorization,owner_id,thread_id,agent_id,binding_id,claim_record,registration_hash,state,record,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,\'unknown\',?,?,?)')
          .run(input.commandId,registration.id,authorization,input.binding.ownerId,input.binding.threadId,input.binding.agentId,input.binding.id,null,fingerprint,JSON.stringify(record),now(),now());
        const lease=options.lease?.reserve({commandId:input.commandId,binding:input.binding,cwd});
        if(lease)db.prepare('UPDATE threaded_os_commands SET claim_record=? WHERE command_id=? AND claim_record IS NULL').run(JSON.stringify(lease),input.commandId);
        won=true;
      }).immediate();
      if(!won){authorized(row(input.commandId)!,input.binding);return refresh(input.commandId);}
      const current=row(input.commandId)!,record=parse(current),claim=current.claim_record?JSON.parse(current.claim_record) as ThreadedClaimIdentity:null;
      const uncertain=(reference:string):CommandObservation=>{
        if(claim&&db.open&&!parse(row(input.commandId)!).resourceReleased)try{options.lease.markUnknown(claim);}catch{/* An unknown result cannot undo a durable release proof. */}
        return {state:'unknown',evidenceRef:reference};
      };
      if(claim)options.lease!.assertExecutable(claim);
      const child=spawn(process.execPath,[guardian,record.token],{cwd,env:environment,shell:false,detached:true,stdio:['pipe','ignore','ignore','ipc']});
      children.set(input.commandId,child);child.stdin?.end();
      try{return await new Promise<CommandObservation>(resolve=>{
        let settled=false;const finish=(value:CommandObservation)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>{if(child.connected)child.disconnect();finish(uncertain('threaded-os-command-launch-unknown'));},5000);
        child.on('error',()=>finish(uncertain('threaded-os-command-launch-unknown')));
        child.on('message',(message:unknown)=>{if(!db.open)return;try{
          const value=message as {type?:string;pid?:number;token?:string;code?:number|null;signal?:string|null};
          if(value.type==='ready'){
            if(value.pid!==child.pid||value.token!==record.token)fail('THREADED_OS_COMMAND_OWNER_INVALID');
            const fact=processes()?.find(p=>p.pid===child.pid);
            if(!fact||fact.pgid!==child.pid||!fact.command.includes(guardian)||!fact.command.endsWith(` ${record.token}`))fail('THREADED_OS_COMMAND_OWNER_UNVERIFIED');
            update(input.commandId,'process_registered',r=>{r.pid=fact!.pid;r.pgid=fact!.pgid;r.startIdentity=fact!.start;r.stage='registered';});
            if(registration.authorization(input.binding)!==authorization)fail('THREADED_OS_COMMAND_AUTHORITY_CHANGED');
            if(claim){options.lease!.assertExecutable(claim);options.lease!.markStarted(claim);}
            update(input.commandId,'launch_authorized',r=>{r.stage='launch_authorized';});
            child.send({type:'start',command:program,args:argv,cwd,env:environment},error=>{if(error)finish(uncertain('threaded-os-command-ipc-unknown'));});
          }else if(value.type==='started'){
            update(input.commandId,'native_started',r=>{r.stage='running';},'running');finish(observation(row(input.commandId)!));
          }else if(value.type==='exit')update(input.commandId,'native_exit',r=>{r.exit={code:value.code??null,signal:value.signal??null};});
          else if(value.type==='spawnError')update(input.commandId,'native_spawn_error',r=>{r.spawnError='native_spawn_failed';});
        }catch{if(child.connected)child.disconnect();finish(uncertain('threaded-os-command-launch-unknown'));}});
        child.once('close',()=>{children.delete(input.commandId);if(!db.open)return;try{update(input.commandId,'ipc_closed',r=>{r.ipcClosed=true;});finish(refresh(input.commandId));}catch{finish({state:'unknown',evidenceRef:'threaded-os-command-stop-unverified'});}});
      });}catch{return uncertain('threaded-os-command-transport-unknown');}
    },
    async observe(input){const current=row(input.commandId)??fail('THREADED_OS_COMMAND_NOT_FOUND');authorized(current,input.scope);return refresh(input.commandId);},
    async cancel(input){const current=row(input.commandId)??fail('THREADED_OS_COMMAND_NOT_FOUND');authorized(current,input.scope);
      const record=parse(current);if(record.groupStopped)return refresh(input.commandId);
      const facts=processes();if(record.host!==hostname()||!facts||!owned(record,facts.find(f=>f.pid===record.pid)))return {...refresh(input.commandId),state:'unknown'};
      update(input.commandId,'cancel_requested',r=>{r.cancelRequested=true;});
      // Only an exact live guardian identity grants this signal. A PID alone never does.
      try{process.kill(-record.pid!,'SIGTERM');}catch{return refresh(input.commandId);}
      for(let i=0;i<25;i++){await pause(50);const answer=refresh(input.commandId);if(JSON.parse(answer.result??'{}').processStopped)return answer;}
      return {...refresh(input.commandId),state:'unknown'};
    },
    close(){for(const child of children.values())if(child.connected)child.disconnect();},
  };
}
