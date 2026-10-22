import type Database from 'better-sqlite3';
import type {ThreadedMessageReceipt} from '@agent-gand/shared';
import type {createExecutionResourceCoordinator} from '../execution/resources/coordinator.ts';
import type {createThreadedMessaging} from './messaging.ts';
import {createThreadedRuntime} from './runtime.ts';
import {createThreadedBackendRuntime} from './backendRuntime.ts';
import {createThreadedRelease,ThreadedReleaseError} from './release.ts';
import {createThreadedStore} from './store.ts';
import {loadThreadedProductionSettings} from './productionSettings.ts';
import {recoverThreadedBackendFacts} from './backendRecovery.ts';
import {ThreadedAuthorityError} from './contracts.ts';
import {digest} from './collaborationTypes.ts';
import {threadedAdmissionMode,threadedCapabilities,rejectThreadedAdmission} from './policy.ts';
import {loadThreadedProductionGithub} from './productionGithub.ts';
import {loadThreadedProductionCommands} from './productionCommands.ts';

/** Production wiring is inert until an operator pins a release pack and opens its durable controls. */
export function createThreadedProduction(db:Database.Database,options:{
  resources:ReturnType<typeof createExecutionResourceCoordinator>;messaging:ReturnType<typeof createThreadedMessaging>;
  settings:ReturnType<typeof loadThreadedProductionSettings>;
  mode?:typeof threadedAdmissionMode;fetch?:Parameters<typeof createThreadedBackendRuntime>[1]['fetch'];
  onRequestReserved?:Parameters<typeof createThreadedBackendRuntime>[1]['onRequestReserved'];
  onRequestSettled?:Parameters<typeof createThreadedBackendRuntime>[1]['onRequestSettled'];
  github?:{file?:string;readToken:(name:string)=>string|undefined;fetch?:typeof fetch};
  commands?:{file?:string};
  holdPolicy?:import('./collaborationTypes.ts').CollaborationOptions['holdPolicy'];
  waitSourceAuthorization?:import('./collaborationTypes.ts').CollaborationOptions['waitSourceAuthorization'];
}){
  const mode=options.mode??threadedAdmissionMode,store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();
  const settings=options.settings,release=createThreadedRelease(db,{mode,members:()=>settings?.members()??[]});
  const policy=(scope:Parameters<typeof release.assertExistingWork>[0],allowDispatchClosed=false)=>{
    try{release.assertExistingWork(scope,{allowDispatchClosed});assertRetainedConfiguration(scope);settings!.validateAgent(scope.agentId);}catch(error){throw new ThreadedAuthorityError(error instanceof ThreadedReleaseError||error instanceof ThreadedAuthorityError?error.code:'THREADED_RELEASE_WORK_BLOCKED');}
  };
  const ingress={assert(input:{ownerId:string;threadId:string},targets:string[]){release.assertNewRoot(input.ownerId,input.threadId,targets);},
    record(receipt:ThreadedMessageReceipt){if(receipt.message.state==='published')release.recordRootWithin(receipt.message.ownerId,receipt.message.threadId,receipt.message.id);}};
  const base={resources:options.resources,messaging:options.messaging,autoStart:false,deferDispatchUntilStart:true,
    notificationsEnabled:mode()!=='observe',repairIntervalMs:mode()==='observe'?0:1000};
  function assertRetainedConfiguration(scope:{ownerId:string;threadId:string;agentId:string}){
    const frozen=release.grant(scope.ownerId,scope.threadId)?.members.find(m=>m.agentId===scope.agentId),registered=settings?.registered.find(m=>m.agentId===scope.agentId);
    if(!frozen||!registered)throw new ThreadedAuthorityError('THREADED_RELEASE_CONFIGURATION_NOT_RETAINED');
    const keys=['agentId','backend','backendVersion','model','roleVersion','permissionVersion','accountId','accountConfigVersion','accountCredentialVersion','accountIdentityGeneration'] as const;
    const shape=(m:typeof registered)=>Object.fromEntries(keys.map(k=>[k,m[k]??null]));
    if(digest(shape(frozen))!==digest(shape(registered)))throw new ThreadedAuthorityError('THREADED_RELEASE_CONFIGURATION_NOT_RETAINED');
  }
  function resolveAgent(scope:{ownerId:string;threadId:string;agentId:string}){
    assertRetainedConfiguration(scope);const value=settings!.resolveAgent(scope),workspace=commands?.resolveWorkspace(scope);
    return workspace?{...value,workspace,informationBoundary:`${value.informationBoundary}:project:${commands!.workspaceIdentity(scope)}`} :value;
  }
  function authorizeMember(scope:{ownerId:string;threadId:string;agentId:string}){
    if(!settings||mode()==='observe')return null;
    try{
      const thread=db.prepare('SELECT state FROM threaded_threads WHERE owner_id=? AND id=?').get(scope.ownerId,scope.threadId) as {state:string}|undefined;
      if(!thread||thread.state==='closed'||thread.state==='archived')return null;
      const member=release.assertGrantedMember(scope);assertRetainedConfiguration(scope);settings.validateAgent(scope.agentId);
      return digest(member);
    }catch{return null;}
  }
  const github=loadThreadedProductionGithub({file:options.github?.file,ownerId,mode,
    readToken:name=>options.github?.readToken(name),fetch:options.github?.fetch,
    assertOutsideTransaction(){if(db.inTransaction)throw new ThreadedAuthorityError('THREADED_GITHUB_IO_IN_TRANSACTION');},
    authorizeMember});
  const commands=loadThreadedProductionCommands(db,{file:options.commands?.file,ownerId,mode,resources:options.resources,authorizeMember});
  const domains={...(github?{trackingSources:{github_pr:github.tracking}}:{}),
    actions:{...(github?{pr:github.pr}:{}),...(commands?{commands:commands.commands}:{})},
    holdPolicy:options.holdPolicy,waitSourceAuthorization:options.waitSourceAuthorization};
  const runtime=settings?createThreadedBackendRuntime(db,{...base,resolveAgent,fetch:options.fetch,
    ...domains,
    onRequestReserved:options.onRequestReserved,onRequestSettled:options.onRequestSettled,
    dispatchEnabled:mode()!=='observe',executionPolicy:{admit:s=>policy(s),assertAuthorized:s=>policy(s,true)},ingress})
    :createThreadedRuntime(db,{...base,dispatchEnabled:false,collaborationEnabled:true,prepareResources(){throw new ThreadedAuthorityError('THREADED_PRODUCTION_ADMISSION_CLOSED');}});
  // Account revocations remain authoritative, but cannot arm a business repair timer in observe.
  if(mode()==='observe')runtime.collaboration?.close();
  function admission(){let ready=!!settings,reason:string|null=null;try{settings?.members();}catch(error){ready=false;reason=error instanceof ThreadedAuthorityError?error.code:'THREADED_RELEASE_PIN_CHANGED';}
    const control=release.state(ownerId);return {mode:mode(),configured:!!settings,ready,reason,canCreate:ready&&mode()==='execute'&&control.admissionOpen,
      members:settings?.registered.map(m=>({agentId:m.agentId,backend:m.backend,model:m.model}))??[],control,
      domains:{github:github?.status()??{configured:false,state:'not_registered'},
        commands:commands?.status()??{configured:false,state:'not_registered'}}};}
  function capabilities(viewOwnerId?:string,threadId?:string){
    const value=threadedCapabilities(),a=admission();let admissionAllowed=a.canCreate,executionAvailable=!!settings&&mode()!=='observe';
    if(threadId){
      admissionAllowed=false;executionAvailable=false;
      if(viewOwnerId===ownerId){
        try{release.assertNewRoot(ownerId,threadId);admissionAllowed=a.canCreate;}catch{/* Scope is readable even when new work is forbidden. */}
        executionAvailable=!!settings&&mode()!=='observe'&&(release.grant(ownerId,threadId)?.members.some(member=>{
          const scope={ownerId,threadId,agentId:member.agentId};
          try{release.assertGrantedMember(scope);assertRetainedConfiguration(scope);settings!.validateAgent(member.agentId);return true;}catch{return false;}
        })??false);
      }
    }
    return {...value,configured:{mode:mode()},domains:a.domains,implemented:{...value.implemented,admission:admissionAllowed,
      execution:executionAvailable,tools:executionAvailable}};
  }
  function createThread(input:{ownerId:string;title:string;clientRequestId:string}){
    if(input.ownerId!==ownerId)throw new ThreadedReleaseError('THREADED_RELEASE_OWNER_FORBIDDEN',403);
    if(!settings)rejectThreadedAdmission();
    return db.transaction(()=>{
      const prior=db.prepare('SELECT id,title FROM threaded_threads WHERE owner_id=? AND client_request_id=?').get(ownerId,input.clientRequestId) as {id:string;title:string}|undefined;
      if(prior){if(prior.title!==input.title.trim())throw new ThreadedReleaseError('THREADED_RELEASE_IDEMPOTENCY_CONFLICT');
        if(!release.grant(ownerId,prior.id))throw new ThreadedReleaseError('THREADED_RELEASE_HISTORICAL_THREAD_REJECTED');return store.getThread(prior.id,ownerId)!;}
      const a=admission();if(!a.canCreate)throw new ThreadedReleaseError(a.mode==='observe'?'THREADED_RELEASE_OBSERVE_ONLY':'THREADED_RELEASE_ADMISSION_CLOSED',403);
      const members=settings!.members(),thread=store.createThread({title:input.title,clientRequestId:input.clientRequestId,members:members.map(m=>({agentId:m.agentId,handle:m.agentId,roleVersion:m.roleVersion,
        permissionVersion:m.permissionVersion,accountVersion:m.accountConfigVersion}))});
      release.grantThread({ownerId,threadId:thread.id,requestId:`new-thread:${input.clientRequestId}`});
      runtime.collaboration!.routing.configure(ownerId,thread.id,{preferred:[],defaultAgent:members[0]!.agentId},0);
      db.prepare("UPDATE threaded_threads SET state='open' WHERE id=? AND owner_id=?").run(thread.id,ownerId);
      return store.getThread(thread.id,ownerId)!;
    }).immediate();
  }
  return {...runtime,release,admission,capabilities,createThread,
    close(){runtime.close();commands?.close();},
    async shutdown(timeoutMs=15_000){commands?.close();return runtime.shutdown(timeoutMs);},
    messageAdmission(){if(!settings)rejectThreadedAdmission();if(mode()==='observe')throw new ThreadedReleaseError('THREADED_RELEASE_OBSERVE_ONLY',403);},
    recover(){if(mode()==='observe')return {observed:true,plan:release.snapshot(ownerId)};
      const result=runtime.recover();return {...result,...recoverThreadedBackendFacts(db,runtime.authority)};},
  };
}
