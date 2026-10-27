import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import net from 'node:net';

// No credential loader and no provider network: actual index/SDK, injected HTTP.
const args=process.argv.slice(2),option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const report=path.resolve(option('--report','docs/reports/evidence/threaded-rc09/main.json'));
const selected=option('--case','all'),root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc09-main-')));
const children=[],processes=[],checks=[],evidence=[],cleanup=[],failures=[],keys=new Map();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const loader=new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname;
const entry=new URL('../apps/server/src/index.ts',import.meta.url).pathname;
const preload=new URL('./fixtures/threadedRc09MainGuard.mjs',import.meta.url).pathname;
const stamp=new Date().toISOString();
const account={id:'rc09-synthetic-account',display_name:'RC09 injected',provider:'anthropic',auth_type:'api_key',source:'managed',enabled:1,archived:0,version:1,config_version:1,credential_version:1,identity_generation:null,created_at:stamp,updated_at:stamp};
const version={account_id:account.id,version:1,connection:JSON.stringify({baseUrl:'https://rc09.invalid',protocols:['anthropic-messages'],defaultModel:'fixture-model',timeoutMs:60000}),created_at:stamp};
const members=[['rc09-api','api'],['rc09-sdk','claude-sdk']].map(([agentId,backend])=>({agentId,backend,backendVersion:backend==='api'?'threaded-http-v1':'0.3.288',model:'fixture-model',roleVersion:1,permissionVersion:1,accountId:account.id,accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
async function freePort(){const s=net.createServer();await new Promise((y,n)=>{s.once('error',n);s.listen(0,'127.0.0.1',y);});const p=s.address().port;await new Promise(y=>s.close(y));return p;}
async function bounded(p,ms,reason){let t;try{return await Promise.race([p,new Promise((_,n)=>{t=setTimeout(()=>n(new Error(reason)),ms);})]);}finally{clearTimeout(t);}}
async function start(name,{restore=false,mode='execute',configured=true}={}){
 const dir=path.join(root,name);await mkdir(path.join(dir,'agents'),{recursive:true});
 const pack=path.join(dir,'pack.json');if(!restore)await writeFile(pack,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:[],maxOutputTokens:256,maxInputTokens:65536,maxRequests:2}),{mode:0o600});
 const port=await freePort(),origin=`http://127.0.0.1:${port}`;
 const child=fork(entry,[],{cwd:dir,execArgv:['--import',loader,'--import',preload],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',AGENT_GAND_ISOLATED_WORKER:'1',RC09_MAIN_ROOT:dir,DB_PATH:path.join(dir,'main.sqlite'),AGENTS_DIR:path.join(dir,'agents'),AGENT_GAND_PRIVATE_DIR:path.join(dir,'private'),HOST:'127.0.0.1',PORT:String(port),LOG_LEVEL:'silent',ACCOUNT_TRUSTED_ORIGINS:origin,THREADED_COLLABORATION_MODE:mode,...(configured?{THREADED_RELEASE_MEMBERS_FILE:pack}:{})}});
 children.push(child);processes.push({name,restore,mode,configured,pid:child.pid});let seq=0,auth,output='';const pending=new Map(),events=[];
 child.stdout.on('data',d=>{output=(output+d).slice(-10000);});child.stderr.on('data',d=>{output=(output+d).slice(-10000);});
 const exit=new Promise((y,n)=>{child.once('error',n);child.once('exit',(code,signal)=>{for(const p of pending.values())p.reject(new Error(`RC09_INDEX_EXIT_${code}_${signal}`));pending.clear();y({code,signal});});});
 child.on('message',m=>{if(m.event){events.push(m);return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);});
 if(!keys.has(name))keys.set(name,randomBytes(32).toString('hex'));
 child.send({operation:'initialize',root:dir,restore,account,version,members,ephemeralMasterKey:keys.get(name),scenario:name});
 const request=async(url,payload,method='POST',headers=auth)=>{const r=await fetch(origin+url,{method,headers:{origin,...(payload===undefined?{}:{'content-type':'application/json'}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(10000)});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const end=Date.now()+30000;let ready=false;while(Date.now()<end&&child.exitCode===null&&!child.signalCode){try{ready=(await request('/api/health',undefined,'GET')).status===200;if(ready)break;}catch{}await delay(50);}assert.ok(ready,output);
 const call=(operation,extra={})=>bounded(new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.send({id,operation,...extra});}),15000,'RC09_IPC_TIMEOUT');
 return{child,dir,request,call,exit,
  async login(){const a=await request('/api/accounts/session',undefined,'POST',{'x-gand-bootstrap':'1'});assert.equal(a.status,200);const b=await request('/api/accounts/threaded/access-session',undefined,'POST',{cookie:a.cookie,'x-gand-csrf':a.body.csrfToken});assert.equal(b.status,200);auth={cookie:b.cookie,'x-gand-csrf':b.body.csrfToken};},
  async fault(){const end=Date.now()+45000;while(Date.now()<end){if(events.some(x=>x.event==='fault-window'))return JSON.parse(await readFile(path.join(dir,'fault-window.json'),'utf8'));if(child.exitCode!==null||child.signalCode)throw new Error(output);await delay(50);}throw new Error('RC09_FAULT_TIMEOUT');},
  async kill(){child.kill('SIGKILL');const r=await bounded(exit,10000,'RC09_KILL_TIMEOUT');assert.equal(r.signal,'SIGKILL');},
  async close(){child.kill('SIGTERM');const r=await bounded(exit,20000,'RC09_SHUTDOWN_TIMEOUT');assert.equal(r.code,0);}
 };
}
async function controls(w,admissionOpen,dispatchOpen){const a=await w.request('/api/threaded/release',undefined,'GET');assert.equal(a.status,200);const r=await w.request('/api/threaded/release/controls',{expectedVersion:a.body.control.version,requestId:randomUUID(),admissionOpen,dispatchOpen,reason:'Isolated RC09 acceptance'});assert.equal(r.status,200);}
async function fresh(name,agent){const w=await start(name);await w.login();await controls(w,true,false);const t=await w.request('/api/threaded/threads',{title:name,clientRequestId:randomUUID()});assert.equal(t.status,200);const tid=t.body.thread?.id??t.body.id;
 const m=await w.request(`/api/threaded/threads/${tid}/messages`,{clientRequestId:randomUUID(),body:'Reply RC09_ACK without tools.',targets:[agent]});assert.equal(m.status,200);const message=(m.body.receipt??m.body).message;await w.call('budget',{messageId:message.id});await controls(w,true,true);return w;}
async function waitUnknown(w){const end=Date.now()+30000;while(Date.now()<end){const f=await w.call('facts');if(f.invocations[0]?.status==='unknown')return f;await delay(100);}throw new Error('RC09_UNKNOWN_TIMEOUT');}
function groupStopped(pid){return !execFileSync('ps',['-axo','pgid=,stat='],{encoding:'utf8',timeout:1000}).split('\n').some(l=>{const [g,s]=l.trim().split(/\s+/);return Number(g)===pid&&s&&!s.startsWith('Z');});}
async function stopped(rows){for(const p of rows){assert.equal(p.host,hostname());const end=Date.now()+5000;while(!groupStopped(p.pid)&&Date.now()<end)await delay(50);assert.equal(groupStopped(p.pid),true);if(!cleanup.some(x=>x.token===p.token))cleanup.push({...p,groupStopped:true,scope:'same-run observer only; does not update durable process rows or prove provider completion'});}}
function noReplay(f,before){assert.equal(f.effects.length,0);assert.deepEqual(f.foreignKeys,[]);assert.equal(f.deniedEgress,0);assert.equal(f.requests.length,before.requests.length);assert.equal(f.invocations.length,1);assert.equal(f.invocations[0].status,'unknown');assert.equal(f.claims.length,1);assert.equal(f.claims[0].state,'unknown');assert.equal(f.terminals.length,0);assert.equal(f.outputs.length,0);assert.equal(f.messages.filter(m=>m.origin==='agent_response').length,0);assert.equal(f.quiescence.length,0);}
async function run(name,fn){if(selected!=='all'&&selected!==name)return;const began=Date.now();try{await fn();checks.push({id:name,passed:true,elapsedMs:Date.now()-began});}catch(e){failures.push({id:name,reason:e.message});throw e;}}
try{
 for(const [name,agent]of [['api-receipt','rc09-api'],['sdk-receipt','rc09-sdk'],['sdk-closed','rc09-sdk']])await run(name,async()=>{
  const w=await fresh(name,agent),fault=await w.fault(),before=fault.snapshot;evidence.push({name,phase:'fault-window',...fault});assert.ok(before.requests.length);assert.ok(before.requests.every(r=>r.state==='complete'));
  if(name==='sdk-closed')assert.ok(before.processes.every(p=>p.state==='closed'));else assert.equal(before.budget[0].known_output,null);
  await w.kill();await stopped(before.processes);
  const n=await start(name,{restore:true}),after=await n.call('facts');evidence.push({name,phase:'automatic-startup-recovery',snapshot:after});noReplay(after,before);
  for(const row of after.requests){const budget=after.budget.find(b=>b.id===row.authorization_id);assert.equal(budget.known_output,row.output_tokens);assert.equal(budget.execution_state,'quiescent');assert.equal(budget.usage_state,'unknown');assert.equal(budget.known_cost,null);assert.equal(after.reconciliations.filter(r=>r.authorization_id===row.authorization_id).length,1);}
  if(name==='sdk-receipt')assert.ok(after.processes.every(p=>p.state==='registered'));
  if(name==='sdk-closed')assert.ok(after.processes.every(p=>p.state==='verified_stopped'));
  const repeat=await n.call('recover'),again=await n.call('facts');assert.equal(repeat.requestUsageRepaired,0);assert.equal(repeat.processStopsRepaired,0);assert.deepEqual(again.reconciliations,after.reconciliations);assert.deepEqual(again.outcomes,after.outcomes);assert.deepEqual(again.requests,after.requests);assert.deepEqual(again.processes,after.processes);noReplay(again,before);await n.close();
 });
 await run('unknown-request',async()=>{const w=await fresh('unknown-request','rc09-api'),before=await waitUnknown(w);evidence.push({name:'unknown-request',phase:'before',snapshot:before});assert.equal(before.requests[0].state,'unknown');await w.kill();const n=await start('unknown-request',{restore:true}),after=await n.call('facts');evidence.push({name:'unknown-request',phase:'after',snapshot:after});noReplay(after,before);assert.equal(after.budget[0].known_output,null);assert.equal(after.budget[0].execution_state,'unknown');assert.equal(after.reconciliations.length,0);assert.deepEqual(after.requests,before.requests);await n.close();});
 await run('observe',async()=>{const w=await fresh('observe','rc09-api'),fault=await w.fault();await w.kill();const n=await start('observe',{restore:true,mode:'observe'}),after=await n.call('facts');evidence.push({name:'observe',phase:'before',...fault},{name:'observe',phase:'after',snapshot:after});assert.deepEqual(after.budget,fault.snapshot.budget);assert.deepEqual(after.requests,fault.snapshot.requests);assert.deepEqual(after.processes,fault.snapshot.processes);assert.deepEqual(after.reconciliations,fault.snapshot.reconciliations);assert.equal(after.effects.length,0);assert.equal((await n.call('recover')).observed,true);await n.close();});
 await run('closed-no-pack',async()=>{const w=await fresh('closed-no-pack','rc09-api'),fault=await w.fault();await w.kill();const n=await start('closed-no-pack',{restore:true,mode:'closed',configured:false}),after=await n.call('facts');evidence.push({name:'closed-no-pack',phase:'before',...fault},{name:'closed-no-pack',phase:'after',snapshot:after});noReplay(after,fault.snapshot);assert.equal(after.budget[0].known_output,7);assert.equal(after.budget[0].known_cost,null);assert.equal(after.reconciliations.length,1);assert.equal(after.budget[0].usage_state,'unknown');await n.login();const a=await n.request('/api/threaded/admission',undefined,'GET');assert.equal(a.status,200);assert.equal(a.body.configured,false);assert.equal(a.body.canCreate,false);const repeat=await n.call('recover');assert.equal(repeat.requestUsageRepaired,0);await n.close();});
}catch(e){if(!failures.length)failures.push({id:'runner',reason:e.message});}
finally{
 for(const c of children)if(c.exitCode===null&&!c.signalCode){c.kill('SIGKILL');await bounded(new Promise(y=>c.once('exit',y)),10000,'RC09_CLEANUP_TIMEOUT').catch(()=>{});}
 const rows=evidence.flatMap(e=>e.snapshot?.processes??[]);try{await stopped(rows);}catch(e){failures.push({id:'cleanup',reason:e.message});}
 const result={ok:failures.length===0,stage:'RC09',date:new Date().toISOString(),groups:checks.length,checks,failures,actualMainIndex:true,entry:'apps/server/src/index.ts',actualPids:processes,actualSdk:'0.3.288',realSupplierRequests:0,syntheticCredentialsOnly:true,isolatedExecutionBypass:false,cleanup,evidence,limitations:['Injected HTTP supplies model usage; no supplier billing reconciliation is claimed.','SIGSTOP pins the exact failure window, then parent SIGKILLs actual index; no injected production recovery facts.','Registered SDK row deliberately remains unresolved even when same-run process observer confirms group absence.','Local process stopped and known output tokens never imply known price, a final Invocation or permission to publish/replay.']};
 await mkdir(path.dirname(report),{recursive:true});await writeFile(report,JSON.stringify(result,null,2)+'\n');await rm(root,{recursive:true,force:true});console.log(JSON.stringify({ok:result.ok,groups:checks.length,failures,pids:processes.length,guardians:cleanup.length,report}));if(!result.ok)process.exitCode=1;
}
