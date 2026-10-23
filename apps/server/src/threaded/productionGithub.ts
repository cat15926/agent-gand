import {constants,closeSync,fstatSync,openSync,readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ActionPrSource,ActionScope,PrAuthority} from './actionTypes.ts';
import {ThreadedAuthorityError} from './contracts.ts';
import {digest} from './collaborationTypes.ts';
import {githubActionSource} from './githubActions.ts';
import {githubPrTrackingSource} from './tracking.ts';
import type {ThreadedTrackingSource} from './tracking.ts';

type Actor={agentId:string;githubLogin:string;mayAssign:boolean};
type Repository={repository:string;pullNumbers:number[];threadIds:string[];actors:Actor[]};
type Configuration={schemaVersion:1;version:number;ownerId:string;
  credential:{source:'environment';name:string;version:number};repositories:Repository[]};
type State='registered'|'credential_pinned'|'ready'|'configuration_changed'|'credential_unavailable'|'credential_changed'|'principal_unverified';
type PrResponse={number:number;head:{sha:string};base:{repo:{full_name:string}};user:{login:string};
  updated_at:string;state:'open'|'closed';merged:boolean;merge_commit_sha:string|null};
function fail(code:string):never{throw new ThreadedAuthorityError(code);}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const integer=(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=max;
const login=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v);
const authorLogin=(v:unknown):v is string=>login(v)||(typeof v==='string'&&v.endsWith('[bot]')&&login(v.slice(0,-5)));
const repository=(v:unknown):v is string=>typeof v==='string'&&v===v.toLowerCase()&&v.length<=140
  &&/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(v)
  &&!['.','..'].includes(v.split('/')[1]!)&&/[a-z0-9]/.test(v.split('/')[1]!);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/i.test(v);
const unique=(values:unknown[])=>new Set(values).size===values.length;
const MAX_BYTES=1024*1024;

// JSON.parse silently accepts duplicate object keys. Reject them before validating
// the public operator contract so the same file has one unambiguous meaning.
function parseConfiguration(bytes:Buffer):unknown {
  const source=bytes.toString('utf8'),parsed:unknown=JSON.parse(source);
  const stack:Array<{kind:'object'|'array';keys:Set<string>;expectKey:boolean}>=[];
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(c==='"'){
      const start=i;for(i++;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='"')break;}
      const current=stack.at(-1);if(current?.kind==='object'&&current.expectKey){
        const key=JSON.parse(source.slice(start,i+1)) as string;
        if(current.keys.has(key))fail('THREADED_GITHUB_CONFIGURATION_INVALID');current.keys.add(key);current.expectKey=false;
      }
    }else if(c==='{'||c==='[')stack.push({kind:c==='{'?'object':'array',keys:new Set(),expectKey:c==='{'});
    else if(c==='}'||c===']')stack.pop();
    else if(c===','&&stack.at(-1)?.kind==='object')stack.at(-1)!.expectKey=true;
  }
  return parsed;
}
function validateConfiguration(v:unknown,ownerId:string):Configuration {
  if(!object(v)||!keys(v,['schemaVersion','version','ownerId','credential','repositories'])||v.schemaVersion!==1
    ||!integer(v.version)||!id(v.ownerId)||v.ownerId!==ownerId||!object(v.credential)
    ||!keys(v.credential,['source','name','version'])||v.credential.source!=='environment'
    ||typeof v.credential.name!=='string'||!/^THREADED_GITHUB_TOKEN_[A-Z0-9_]{1,100}$/.test(v.credential.name)
    ||!integer(v.credential.version)||!Array.isArray(v.repositories)||!v.repositories.length||v.repositories.length>50)
    fail('THREADED_GITHUB_CONFIGURATION_INVALID');
  const repositories=v.repositories as unknown[];const names:string[]=[],principals=new Set<string>();
  for(const r of repositories){
    if(!object(r)||!keys(r,['repository','pullNumbers','threadIds','actors'])||!repository(r.repository)
      ||!Array.isArray(r.pullNumbers)||!r.pullNumbers.length||r.pullNumbers.length>1000
      ||!r.pullNumbers.every(n=>integer(n,1_000_000_000))||!unique(r.pullNumbers)
      ||!Array.isArray(r.threadIds)||!r.threadIds.length||r.threadIds.length>100||!r.threadIds.every(id)||!unique(r.threadIds)
      ||!Array.isArray(r.actors)||!r.actors.length||r.actors.length>8)fail('THREADED_GITHUB_CONFIGURATION_INVALID');
    names.push(r.repository);const agents:string[]=[];
    for(const actor of r.actors){
      if(!object(actor)||!keys(actor,['agentId','githubLogin','mayAssign'])||!id(actor.agentId)||!login(actor.githubLogin)
        ||typeof actor.mayAssign!=='boolean')fail('THREADED_GITHUB_CONFIGURATION_INVALID');
      agents.push(actor.agentId);principals.add(actor.githubLogin.toLowerCase());
    }
    if(!unique(agents))fail('THREADED_GITHUB_CONFIGURATION_INVALID');
  }
  if(!unique(names)||principals.size!==1)fail('THREADED_GITHUB_CONFIGURATION_INVALID');
  return v as unknown as Configuration;
}

/** Explicit read-only production registration. Public configuration is pinned for
 * one process; neither tools nor model input can select credentials or endpoints. */
export function loadThreadedProductionGithub(options:{file?:string;ownerId:string;mode:()=>string;
  authorizeMember:(scope:ActionScope)=>string|null;readToken:(environmentVariable:string)=>string|undefined;
  fetch?:typeof fetch;assertOutsideTransaction:()=>void}):{
    pr:ActionPrSource;tracking:ThreadedTrackingSource;
    status:()=>{configured:true;state:State;version:number;repositoryCount:number};
  }|null {
  if(!options.file)return null;
  const requestedFile=path.resolve(options.file);
  let filename:string,initial:{bytes:Buffer;dev:number;ino:number;mtimeMs:number;ctimeMs:number},config:Configuration;
  function snapshot(file:string){
    if(realpathSync(file)!==file)fail('THREADED_GITHUB_CONFIGURATION_INVALID');
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=fstatSync(fd);if(!before.isFile()||before.size>MAX_BYTES)fail('THREADED_GITHUB_CONFIGURATION_INVALID');
      const bytes=readFileSync(fd),after=fstatSync(fd),live=statSync(file);
      if(bytes.length>MAX_BYTES||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs
        ||before.ctimeMs!==after.ctimeMs||live.dev!==after.dev||live.ino!==after.ino
        ||realpathSync(file)!==file)fail('THREADED_GITHUB_CONFIGURATION_INVALID');
      return {bytes,dev:after.dev,ino:after.ino,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs};
    }finally{closeSync(fd);}
  }
  try{filename=realpathSync(requestedFile);initial=snapshot(filename);config=validateConfiguration(parseConfiguration(initial.bytes),options.ownerId);}
  catch{fail('THREADED_GITHUB_CONFIGURATION_INVALID');}
  const publicHash=createHash('sha256').update(initial.bytes).digest('hex');
  const principal=config.repositories[0]!.actors[0]!.githubLogin.toLowerCase();
  let state:State='registered',pinnedToken:string|undefined,principalVerified=false;
  const healthy=()=>state==='registered'||state==='credential_pinned'||state==='ready';
  function configurationCurrent(){
    if(!healthy())return false;
    try{if(realpathSync(requestedFile)!==filename)throw new Error();const current=snapshot(filename);if(current.dev!==initial.dev||current.ino!==initial.ino
      ||current.mtimeMs!==initial.mtimeMs||current.ctimeMs!==initial.ctimeMs||!current.bytes.equals(initial.bytes))throw new Error();return true;}
    catch{state='configuration_changed';return false;}
  }
  function credentialCurrent(){
    if(!healthy())return false;
    let token:string|undefined;try{token=options.readToken(config.credential.name);}catch{state='credential_unavailable';return false;}
    if(typeof token!=='string'||!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)){state='credential_unavailable';return false;}
    if(pinnedToken!==undefined&&pinnedToken!==token){state='credential_changed';return false;}
    if(pinnedToken===undefined){pinnedToken=token;state='credential_pinned';}return true;
  }
  function registered(scope:ActionScope,name:string){
    if(!scope||scope.ownerId!==config.ownerId||!id(scope.threadId)||!id(scope.agentId)||!repository(name))return null;
    const repo=config.repositories.find(r=>r.repository===name),actor=repo?.actors.find(a=>a.agentId===scope.agentId);
    return repo&&actor&&repo.threadIds.includes(scope.threadId)?{repo,actor}:null;
  }
  function authorize(scope:ActionScope,name:string):PrAuthority|null {
    const entry=registered(scope,name);if(!entry)return null;
    try{
      if(!['closed','execute'].includes(options.mode())||!configurationCurrent())return null;
      const member=options.authorizeMember({ownerId:scope.ownerId,threadId:scope.threadId,agentId:scope.agentId});
      if(typeof member!=='string'||!member||!credentialCurrent())return null;
      return {fingerprint:digest({configuration:publicHash,version:config.version,credentialVersion:config.credential.version,
        scope:{ownerId:scope.ownerId,threadId:scope.threadId,agentId:scope.agentId},repository:name,
        githubLogin:entry.actor.githubLogin.toLowerCase(),mayAssign:entry.actor.mayAssign,member}),
        githubLogin:entry.actor.githubLogin.toLowerCase(),mayAssign:entry.actor.mayAssign};
    }catch{return null;}
  }
  function subject(scope:ActionScope,name:string,number:unknown){
    const entry=registered(scope,name);return entry&&integer(number,1_000_000_000)&&entry.repo.pullNumbers.includes(number)?entry:null;
  }
  function parsed(scope:ActionScope,value:string){
    if(typeof value!=='string')return null;
    const match=/^([^#]+)#([1-9][0-9]*)$/.exec(value);if(!match)return null;
    const number=Number(match[2]),name=match[1]!;return subject(scope,name,number)?{repository:name,number}:null;
  }
  function assertAuthority(scope:ActionScope,name:string,fingerprint:string){
    if(authorize(scope,name)?.fingerprint!==fingerprint)fail('THREADED_GITHUB_AUTHORITY_CHANGED');
  }
  function assertOutsideTransaction(){try{options.assertOutsideTransaction();}catch{fail('THREADED_GITHUB_IO_IN_TRANSACTION');}}
  async function readJson(scope:ActionScope,name:string,fingerprint:string,endpoint:string):Promise<unknown>{
    assertOutsideTransaction();
    assertAuthority(scope,name,fingerprint);
    let response:Response;
    const init:NonNullable<Parameters<typeof fetch>[1]>&{cache:'no-store'}={method:'GET',redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${pinnedToken!}`,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache, no-store','User-Agent':'agent-gand-threaded-production'}};
    try{response=await(options.fetch??fetch)(`https://api.github.com${endpoint}`,init);}
    catch{fail('THREADED_GITHUB_UNVERIFIABLE');}
    try{
      assertAuthority(scope,name,fingerprint);
      if(response.status===401||response.status===403)state='credential_unavailable';
      if(!response.ok||response.redirected||(response.url&&response.url!==`https://api.github.com${endpoint}`))throw new Error();
      const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw new Error();
      if(!response.body)throw new Error();
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.byteLength;
        if(count>MAX_BYTES){await reader.cancel();throw new Error();}chunks.push(chunk.value);}}
      finally{reader.releaseLock();}
      const result:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assertAuthority(scope,name,fingerprint);return result;
    }catch{try{await response.body?.cancel();}catch{/* A consumed/failed stream has nothing left to discard. */}fail('THREADED_GITHUB_UNVERIFIABLE');}
  }
  async function current(scope:ActionScope,name:string,number:number,fingerprint:string):Promise<PrResponse>{
    if(!subject(scope,name,number))fail('THREADED_GITHUB_SUBJECT_NOT_AUTHORIZED');
    if(!principalVerified){
      const user=await readJson(scope,name,fingerprint,'/user');
      if(!object(user)||!login(user.login)||user.login.toLowerCase()!==principal||!integer(user.id)){
        state='principal_unverified';fail('THREADED_GITHUB_PRINCIPAL_UNVERIFIABLE');
      }
      // The awaited identity read may resume after another concurrent read has
      // fenced this provider. A successful /user must not erase that fault.
      assertAuthority(scope,name,fingerprint);
      principalVerified=true;state='ready';
    }
    const value=await readJson(scope,name,fingerprint,`/repos/${name}/pulls/${number}`);
    if(!object(value)||value.number!==number||!object(value.base)||!object(value.base.repo)
      ||typeof value.base.repo.full_name!=='string'||value.base.repo.full_name.toLowerCase()!==name
      ||!object(value.head)||!sha(value.head.sha)||!object(value.user)||!authorLogin(value.user.login)
      ||typeof value.updated_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.updated_at)
      ||!Number.isFinite(Date.parse(value.updated_at))||(value.state!=='open'&&value.state!=='closed')
      ||typeof value.merged!=='boolean'||(value.merge_commit_sha!==null&&!sha(value.merge_commit_sha)))
      fail('THREADED_GITHUB_UNVERIFIABLE');
    assertAuthority(scope,name,fingerprint);
    return {number,head:{sha:value.head.sha.toLowerCase()},base:{repo:{full_name:name}},user:{login:value.user.login.toLowerCase()},
      updated_at:value.updated_at,state:value.state as 'open'|'closed',merged:value.merged,
      merge_commit_sha:typeof value.merge_commit_sha==='string'?value.merge_commit_sha.toLowerCase():null};
  }
  const pr:ActionPrSource={authorize,async current(scope,value){
    if(!value||value.kind!=='github_pr'||!subject(scope,value.repository,value.number))fail('THREADED_GITHUB_SUBJECT_NOT_AUTHORIZED');
    assertOutsideTransaction();
    const auth=authorize(scope,value.repository);if(!auth)fail('THREADED_GITHUB_NOT_AUTHORIZED');
    const adapter=githubActionSource({authorize,token:()=>pinnedToken??null,fetch:async(input)=>{
      if(input!==`https://api.github.com/repos/${value.repository}/pulls/${value.number}`)fail('THREADED_GITHUB_TRANSPORT_INVALID');
      const result=await current(scope,value.repository,value.number,auth.fingerprint);return new Response(JSON.stringify(result),{status:200});
    }});
    try{const result=await adapter.current(scope,value);assertAuthority(scope,value.repository,auth.fingerprint);return result;}
    catch(error){if(error instanceof ThreadedAuthorityError)throw error;fail('THREADED_GITHUB_UNVERIFIABLE');}
  }};
  const tracking:ThreadedTrackingSource={authorization(scope,value){const p=parsed(scope,value);return p?authorize(scope,p.repository)?.fingerprint??null:null;},
    deliveryAuthorization(scope,value){
      const p=parsed(scope,value);if(!p)return null;
      const caller={ownerId:scope.ownerId,threadId:scope.threadId,agentId:scope.agentId};
      const callerAuthorization=authorize(caller,p.repository);if(!callerAuthorization)return null;
      const entry=registered(caller,p.repository);if(!entry)return null;
      const recipients=Object.create(null) as Record<string,string>;
      for(const actor of entry.repo.actors){
        const recipient={ownerId:caller.ownerId,threadId:caller.threadId,agentId:actor.agentId};
        const authorization=authorize(recipient,p.repository);
        if(authorization)recipients[actor.agentId]=authorization.fingerprint;
      }
      // A registration/credential/member callback may fence the provider during
      // these synchronous checks. Never publish an audience without its caller.
      if(recipients[caller.agentId]!==callerAuthorization.fingerprint
        ||authorize(caller,p.repository)?.fingerprint!==callerAuthorization.fingerprint)return null;
      return recipients;
    },
    async observe(scope,value,previous){
      const p=parsed(scope,value);if(!p)fail('THREADED_GITHUB_SUBJECT_NOT_AUTHORIZED');
      assertOutsideTransaction();
      const auth=authorize(scope,p.repository);if(!auth)fail('THREADED_GITHUB_NOT_AUTHORIZED');
      const adapter=githubPrTrackingSource({authorize:(s,r)=>r===p.repository?authorize(s,r)?.fingerprint??null:null,fetch:async endpoint=>{
        if(endpoint!==`/repos/${p.repository}/pulls/${p.number}`)fail('THREADED_GITHUB_TRANSPORT_INVALID');
        return current(scope,p.repository,p.number,auth.fingerprint);
      }});
      try{const events=await adapter.observe(scope,value,previous);assertAuthority(scope,p.repository,auth.fingerprint);return events;}
      catch(error){if(error instanceof ThreadedAuthorityError)throw error;fail('THREADED_GITHUB_UNVERIFIABLE');}
    }};
  return {pr,tracking,status:()=>{configurationCurrent();return {configured:true,state,version:config.version,repositoryCount:config.repositories.length};}};
}
