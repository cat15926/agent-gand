/** Actual separate-PID RC04 restart evidence, with credentials retained solely
 * in the parent. The worker has no direct network and only fixed official GETs. */
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_BYTES=1024*1024;
const failure=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deadline=(promise,label)=>{
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure(`RC04_PROCESS_${label}_TIMEOUT`)),30_000);})])
    .finally(()=>clearTimeout(timer));
};
const identity=snapshot=>({ownerId:snapshot.ownerId,threadId:snapshot.threadId,rootId:snapshot.rootId,actionId:snapshot.actionId,
  stage:snapshot.stage,chain:{...snapshot.chain,rebuilds:undefined},counts:snapshot.counts,scriptedCalls:snapshot.scriptedCalls,
  ...(snapshot.durableIdentity?{durableIdentity:snapshot.durableIdentity}:{})});

export async function openRc04Process(root,options){
  assert.ok(path.isAbsolute(root));
  const {name,repository,number,principalLogin,readToken,githubFetch}=options;
  assert.match(name,/^[A-Za-z0-9_-]{1,60}$/);assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(Number.isSafeInteger(number)&&number>0);assert.match(principalLogin,/^[A-Za-z0-9-]{1,39}$/);
  assert.equal(typeof readToken,'function');assert.equal(typeof githubFetch,'function');
  const publicOptions={name,repository,number,principalLogin};
  const allowedPaths=new Set(['/user',`/repos/${repository}/pulls/${number}`]);
  const evidence={composition:'Actual separate child PID; createThreadedProduction with disposable SQLite and persisted stage metadata',
    mainIndexProcess:false,restartBoundary:'Completed initialize/poll/advanceObserved stage boundaries; no arbitrary mid-commit crash claim',
    credentialPolicy:'Real token retained only by parent callback; never worker env, argv, IPC, SQLite, output or metadata',
    directWorkerNetworkForbidden:true,pids:[],restarts:[],parentProviderGets:0,rejectedProviderRequests:0,workerForbiddenNetworkCalls:0};
  let current,closed=false,operation=Promise.resolve();
  async function proxyGet(child,message){
    const respond=value=>{if(child.connected)child.send({type:'github-response',requestId:message.requestId,...value});};
    try{
      const url=new URL(message.url),headers=new Headers(message.headers);
      if(url.href!==message.url||url.origin!=='https://api.github.com'||url.username||url.password||url.search||url.hash||!allowedPaths.has(url.pathname)
        ||message.method!=='GET'||message.redirect!=='error'||message.cache!=='no-store'
        ||[...headers.keys()].some(key=>!['accept','x-github-api-version','cache-control','user-agent'].includes(key))
        ||headers.get('accept')!=='application/vnd.github+json'||headers.get('x-github-api-version')!=='2022-11-28'
        ||headers.get('cache-control')!=='no-cache, no-store'||headers.get('user-agent')!=='agent-gand-threaded-production'){
        evidence.rejectedProviderRequests++;throw failure('RC04_PROCESS_GET_ALLOWLIST_REQUIRED');
      }
      let token=await readToken('THREADED_GITHUB_TOKEN_RC04');
      if(typeof token!=='string'||!/^[A-Za-z0-9_.-]{1,4096}$/.test(token))throw failure('RC04_PROCESS_CREDENTIAL_UNAVAILABLE');
      headers.set('authorization',`Bearer ${token}`);token=null;
      evidence.parentProviderGets++;
      const response=await githubFetch(url.href,{method:'GET',redirect:'error',cache:'no-store',headers,signal:AbortSignal.timeout(20_000)});
      if(!(response instanceof Response)||response.redirected||(response.url&&response.url!==url.href)||response.status<200||response.status>599)
        throw failure('RC04_PROCESS_RESPONSE_INVALID');
      if(!response.body)throw failure('RC04_PROCESS_RESPONSE_INVALID');
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
        if(bytes>MAX_BYTES){await reader.cancel();throw failure('RC04_PROCESS_RESPONSE_INVALID');}chunks.push(chunk.value);}}
      finally{reader.releaseLock();}
      const body=Buffer.concat(chunks).toString('utf8');
      // Even an unexpected provider echo cannot move the parent credential
      // across the worker boundary. Publish a fixed failure in that case.
      if(body.includes(headers.get('authorization').slice(7)))throw failure('RC04_PROCESS_RESPONSE_INVALID');
      respond({response:{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store','content-length':String(bytes)},body}});
    }catch{respond({error:{code:'RC04_PARENT_GET_FAILED'}});}
  }
  async function start(restore){
    const child=fork(new URL('./threadedRc04ProcessWorker.mjs',import.meta.url),[],{
      execArgv:['--import',new URL('../../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],
      stdio:['ignore','ignore','ignore','ipc'],env:{NODE_ENV:'test',LOG_LEVEL:'silent',PATH:'/usr/bin:/bin'},serialization:'json'});
    let sequence=0,closeResolve;
    const pending=new Map(),close=new Promise(resolve=>{closeResolve=resolve;});
    child.on('message',message=>{
      if(message?.type==='github-get'){void proxyGet(child,message);return;}
      const waiter=pending.get(message?.id);if(!waiter)return;pending.delete(message.id);
      evidence.workerForbiddenNetworkCalls=Math.max(evidence.workerForbiddenNetworkCalls,message.forbiddenNetworkCalls??0);
      if(message.error){const error=failure(message.error.code);error.message+=` (${message.error.kind}: ${(message.error.locations??[]).join(', ')}${message.error.domainCode?`; ${message.error.domainCode}`:''})`;
        if(message.error.requestTrace)error.requestTrace=message.error.requestTrace;waiter.reject(error);}
      else waiter.resolve(message.result);
    });
    child.on('error',()=>{for(const waiter of pending.values())waiter.reject(failure('RC04_PROCESS_SPAWN_FAILED'));pending.clear();});
    child.on('close',(code,signal)=>{for(const waiter of pending.values())waiter.reject(failure('RC04_PROCESS_EXITED'));pending.clear();closeResolve({code,signal,closeObserved:true});});
    const worker={child,close,call(operation,args={}){return deadline(new Promise((resolve,reject)=>{
      const id=++sequence;pending.set(id,{resolve,reject});
      if(!child.connected){pending.delete(id);reject(failure('RC04_PROCESS_DISCONNECTED'));return;}
      child.send({id,operation,...args},error=>{if(error){pending.delete(id);reject(failure('RC04_PROCESS_IPC_FAILED'));}});
    }),operation.toUpperCase());}};
    try{
      const ready=await worker.call('open',{root,options:{...publicOptions,...(restore?{restore:true}:{})}});
      assert.equal(ready.pid,child.pid);assert.equal(ready.forbiddenNetworkCalls,0);
      assert.equal(ready.bootPolicy.argvCount,2);
      // macOS may add its own text-encoding setting before Node starts.
      assert.ok(ready.bootPolicy.environmentKeys.every(key=>['LOG_LEVEL','NODE_ENV','PATH','__CF_USER_TEXT_ENCODING'].includes(key)));
      assert.ok(['LOG_LEVEL','NODE_ENV','PATH'].every(key=>ready.bootPolicy.environmentKeys.includes(key)));
      evidence.pids.push({pid:ready.pid,restore,...ready.bootPolicy});worker.initial=ready.snapshot;return worker;
    }catch(error){child.kill('SIGKILL');await deadline(close,'FAILED_START_CLOSE');throw error;}
  }
  const decorate=snapshot=>({...snapshot,processEvidence:JSON.parse(JSON.stringify(evidence))});
  function serialize(action){const result=operation.then(action);operation=result.catch(()=>{});return result;}
  async function rebuild(){
    if(closed)throw failure('RC04_PROCESS_CLOSED');
    const before=await current.call('snapshot'),gets=evidence.parentProviderGets,prior=current;
    assert.ok(prior.child.kill('SIGKILL'),'RC04 real child must be alive before SIGKILL');
    const exit=await deadline(prior.close,'SIGKILL_CLOSE');assert.equal(exit.signal,'SIGKILL');assert.equal(exit.closeObserved,true);
    current=await start(true);assert.notEqual(current.child.pid,prior.child.pid);
    const after=await current.call('snapshot');
    assert.deepEqual(identity(after),identity(before),'RC04 restart must preserve all chain identities and scripted-call count');
    assert.equal(evidence.parentProviderGets,gets,'RC04 restart must not perform provider IO');
    evidence.restarts.push({beforePid:prior.child.pid,afterPid:current.child.pid,...exit,stage:before.stage,
      preservedIdentitySha256:digest(identity(before)),sameThread:true,sameRoot:true,sameAction:true,sameWaits:true,
      duplicateCallbacks:0,duplicateReports:0,providerGetsDuringRestore:0,scriptedCallsDuringRestore:0});
    return decorate(after);
  }
  current=await start(options.restore===true);
  return {
    initialize:()=>serialize(async()=>decorate(await current.call('initialize'))),
    poll:()=>serialize(()=>current.call('poll')),
    advanceObserved:()=>serialize(async()=>decorate(await current.call('advanceObserved'))),
    snapshot:()=>serialize(async()=>decorate(await current.call('snapshot'))),
    processDiagnostics:()=>JSON.parse(JSON.stringify(evidence)),
    rebuild:()=>serialize(rebuild),
    restart:({signal='SIGKILL'}={})=>serialize(()=>{assert.equal(signal,'SIGKILL');return rebuild();}),
    close:()=>serialize(async()=>{if(closed)return;closed=true;
      try{await current.call('close');await deadline(current.close,'CLOSE');}
      catch(error){if(!current.child.signalCode&&current.child.exitCode===null)current.child.kill('SIGKILL');await deadline(current.close,'FINAL_CLOSE');throw error;}}),
  };
}
