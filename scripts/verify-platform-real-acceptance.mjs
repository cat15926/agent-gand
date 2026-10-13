import assert from 'node:assert/strict';
import { readFile, stat,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createDemoEnvironment } from './helpers/orchestration-demo-environment.mjs';
import { parsePlatformRealArgs } from './platform-collaboration-real-acceptance.mjs';
import { realEnvironment, Database } from './helpers/platform-real-environment.mjs';
import { realContract, ownerClient } from './helpers/platform-real-scenarios.mjs';
import {installRealFaults}from'./helpers/platform-real-faults.mjs';
import {syncNativeRefresh,authDigest}from'./helpers/platform-native-refresh.mjs';

const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const qaPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));process.env.PORT=String(qaPort);
const environment = await createDemoEnvironment();
try {
  const selected = ['--claude-agent', 'sdk', '--codex-account', (await import('../apps/server/src/agents/registry.ts')).getAgent('codex').accountRef, '--api-agent', 'real-api'];
  assert.equal(parsePlatformRealArgs(selected).execute, false, 'default command must not spend quota');
  for(const invalid of [[], [...selected, '--api-key', 'never-accepted'], [...selected, '--max-starts', '31'], [...selected, '--timeout-ms', '1'], [...selected, '--execute', '--execute']])assert.throws(()=>parsePlatformRealArgs(invalid));
  const { normalizeBusinessContract } = await import('../apps/server/src/orchestration/businessContract.ts');
  const contract = realContract([{execution:{assignments:[{agentId:'sdk',objective:'Actual deliverable',dependsOn:[]}]}}]);
  assert.equal(normalizeBusinessContract(contract).version,3);
  const registry = await import('../apps/server/src/agents/registry.ts');
  const { createAccount } = await import('../apps/server/src/accounts/store.ts');
  const account = createAccount({displayName:'R8 fake API',provider:'custom',apiKey:'R8-NEVER-REAL-CREDENTIAL',baseUrl:'http://127.0.0.1:9',protocols:['anthropic-messages'],models:['fixture-session'],defaultModel:'fixture-session'});
  registry.createAgent({id:'real-api',name:'API fixture',description:'fixture',systemPrompt:'Read only',model:'anthropic:fixture-session',accountRef:account.id,requiresAccount:true,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
  const { createRun } = await import('../apps/server/src/runs/trace.ts'); createRun('R8 SOURCE BUSINESS DATA MUST NOT COPY','pipeline',['real-api'],null,null,null);
  const originalAccounts = environment.database.all('SELECT id,version FROM accounts');
  const options=parsePlatformRealArgs([...selected,'--output-dir',path.join(environment.root,'real-copy'),'--source-db',path.join(environment.root,'demo.sqlite'),'--max-starts','3']);
  const cloned=await realEnvironment(options);const db=new Database(cloned.dbPath,{readonly:false});
  try{
    assert.equal(db.prepare('SELECT COUNT(*)n FROM runs').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*)n FROM accounts').get().n,3);
    assert.equal(db.prepare('SELECT COUNT(*)n FROM account_credentials').get().n,3);
    assert.equal(db.prepare('SELECT COUNT(*)n FROM agents').get().n,4);
    assert.deepEqual(environment.database.all('SELECT id,version FROM accounts'),originalAccounts);
    assert.equal((await stat(path.join(cloned.root,'private/account-master-key.json'))).mode&0o077,0);
    const metadata=await readFile(path.join(cloned.root,'environment.json'),'utf8');assert.ok(!metadata.includes('R8-NEVER-REAL-CREDENTIAL'));
    const sourceRun=environment.database.get('SELECT * FROM runs LIMIT 1'),columns=Object.keys(sourceRun);db.prepare(`INSERT INTO runs(${columns.join(',')})VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values({...sourceRun,id:'fixture-run'}));
    for(let i=0;i<4;i++)db.prepare("INSERT INTO orchestration_model_calls(id,run_id,agent_id,model,backend,status,queued_at)VALUES(?,?,'sdk','fixture-session','claude-sdk','waiting',?)").run('guard-'+i,'fixture-run',new Date().toISOString());
    for(let i=0;i<3;i++)db.prepare("UPDATE orchestration_model_calls SET started_at=?,status='started' WHERE id=?").run(new Date().toISOString(),'guard-'+i);
    assert.throws(()=>db.prepare("UPDATE orchestration_model_calls SET started_at=?,status='started' WHERE id=?").run(new Date().toISOString(),'guard-3'),/R8_ACCEPTANCE_EXECUTION_LIMIT/);
    assert.equal(db.prepare('SELECT COUNT(*)n FROM orchestration_model_calls WHERE started_at IS NOT NULL').get().n,3);
  }finally{db.close();}
  // Owner client uses the existing cookie/CSRF boundary without serializing either token.
  const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(environment.app);
  await environment.app.listen({port:qaPort,host:'127.0.0.1'});
  const { config }=await import('../apps/server/src/config.ts'); const base=`http://127.0.0.1:${environment.app.server.address().port}`;config.accounts.trustedOrigins=[base];
  const owner=ownerClient(base);assert.ok(Array.isArray((await owner('/api/accounts')).accounts));
  const supplier=http.createServer((_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end('{"value":"real local response"}'));await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
  const {createRequire}=await import('node:module'),require=createRequire(new URL('../apps/server/package.json',import.meta.url)),undici=require('undici');
  const fakeDb={prepare:()=>({get:()=>({id:'fixture-call',run_id:'fixture-run',agent_id:'r8-api'})})},tool={run:async()=>'actual bytes written'};
  const restore=installRealFaults({root:environment.root,db:fakeDb,getTool:()=>tool,allowLoopback:true});
  try{await writeFile(path.join(environment.root,'upstream-fault.json'),JSON.stringify({agentId:'r8-api'}));
    await assert.rejects(()=>undici.fetch(`http://127.0.0.1:${supplier.address().port}/messages`,{method:'POST',body:'{}'}));
    const captured=JSON.parse(await readFile(path.join(environment.root,'upstream-fault-result.json'),'utf8'));assert.equal(captured.receivedUpstreamHeaders,true);assert.equal(captured.httpStatus,200);
    assert.deepEqual(await(await undici.fetch(`http://127.0.0.1:${supplier.address().port}/messages`,{method:'POST',body:'{}'})).json(),{value:'real local response'});
  }finally{restore();supplier.closeAllConnections();await new Promise(resolve=>supplier.close(resolve));}
  const unsafeDb={prepare:()=>({get:()=>({pid:process.pid,token:'not-a-guardian-nonce'})})},safeTool={run:async()=>'fixture write'};
  const restoreGuard=installRealFaults({root:environment.root,db:unsafeDb,getTool:()=>safeTool});
  try{await writeFile(path.join(environment.root,'upstream-fault.json'),JSON.stringify({type:'native_after_write',agentId:'sdk',afterFile:'probe.txt'}));await assert.rejects(()=>safeTool.run({path:'probe.txt'},{runId:'fixture',agentId:'sdk'}),/R8_NATIVE_FAULT_OWNERSHIP_UNVERIFIED/);}finally{restoreGuard();}
  const native=createAccount({displayName:'R8 dummy native refresh',authType:'native_login',nativeClient:'codex'}),directory=path.join(environment.root,'private/native',native.id,'1'),sourcePath=path.join(directory,'config/auth.json'),copyPath=path.join(environment.root,'copy-auth.json');
  await mkdir(path.dirname(sourcePath),{recursive:true,mode:0o700});const old=JSON.stringify({tokens:{account_id:'fake-account',access_token:'fake-old'}}),jwt='fake.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fake',next=JSON.stringify({tokens:{account_id:'fake-account',access_token:jwt}});
  await writeFile(sourcePath,old,{mode:0o600});await writeFile(copyPath,next,{mode:0o600});environment.database.run('UPDATE accounts SET identity_generation=1 WHERE id=?',native.id);
  const nativeColumns=environment.database.all('PRAGMA table_info(account_native_identities)').map(c=>c.name);
  const identity={account_id:native.id,generation:1,client:'codex',directory,status:'authenticated',summary:'fake',identity_hash:authDigest('codex:fake-account'),created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  environment.database.run(`INSERT INTO account_native_identities(${nativeColumns.join(',')})VALUES(${nativeColumns.map(()=>'?').join(',')})`,...nativeColumns.map(c=>identity[c]??null));
  const refresh={sourceDb:path.join(environment.root,'demo.sqlite'),accountId:native.id,generation:1,sourcePath,copyPath,initialDigest:authDigest(old)};
  assert.equal((await syncNativeRefresh(refresh)).status,'refreshed_source');assert.equal(await readFile(sourcePath,'utf8'),next);
  assert.equal((await syncNativeRefresh(refresh)).status,'source_file_changed');assert.equal((await syncNativeRefresh({...refresh,generation:2})).status,'source_identity_changed');
  await writeFile(copyPath,JSON.stringify({tokens:{account_id:'different-account',access_token:jwt}}),{mode:0o600});assert.equal((await syncNativeRefresh({...refresh,initialDigest:authDigest(next)})).status,'refreshed_identity_mismatch');
  assert.equal(environment.externalRequests,0);
  console.log(JSON.stringify({passed:true,checks:['explicit opt-in and bounded arguments','valid schema v3 scenarios','selected accounts only, zero copied business rows','encrypted credentials and private master key','source configurations unchanged','atomic pre-I/O start ceiling','Owner session/CSRF','actual Undici 8 response-loss fault and one-shot recovery','native fault rejects an unowned process','native refresh CAS preserves user changes and identity generation'],realSupplierRequests:0}));
}finally{await environment.close();}
