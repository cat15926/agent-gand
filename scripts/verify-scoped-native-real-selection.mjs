import assert from 'node:assert/strict';
import {fork,spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
import {Database} from './helpers/platform-real-environment.mjs';
import {assertFrozenSourceRoles} from './helpers/scoped-native-source-roles.mjs';

const environment=await createDemoEnvironment();
try {
  const registry=await import('../apps/server/src/agents/registry.ts');
  const selected=registry.getAgent('codex'),sdk=registry.getAgent('sdk');
  const definition={...selected,systemPrompt:'SELECTED_CODEX_ROLE_PROMPT',execution:{...selected.execution,sessionPolicy:'run'}};
  environment.database.run('UPDATE agents SET definition=? WHERE id=?',JSON.stringify(definition),'codex');
  registry.createAgent({...sdk,id:'real-api',name:'API selection fixture',model:'anthropic:fixture-session',execution:{kind:'builtin-llm'}});
  const sourceDb=path.join(environment.root,'demo.sqlite'),root=path.join(environment.root,'selected-copy');
  const prepare=(directory,skipCodex=false)=>new Promise((resolve,reject)=>{
    const args=skipCodex?['prepare',sourceDb,'sdk','','real-api','','skip-codex']:['prepare',sourceDb,'sdk',selected.accountRef,'real-api','codex'];
    const worker=fork('scripts/helpers/platform-real-worker.mjs',args,{
      env:{...process.env,R8_ROOT:directory,R8_CAMPAIGN:'g5',DB_PATH:path.join(directory,'acceptance.sqlite'),AGENT_GAND_PRIVATE_DIR:path.join(directory,'private'),AGENTS_DIR:path.join(directory,'roles'),R8_MAX_STARTS:'20',R8_DEADLINE:String(Date.now()+60000)},
      execArgv:['--import',path.resolve('apps/server/node_modules/tsx/dist/loader.mjs')],stdio:['ignore','ignore','ignore','ipc']});
    let message;const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(new Error('PREPARATION_TIMEOUT'));},30000);
    worker.on('message',value=>{message=value;});worker.once('error',reject);worker.once('exit',code=>{clearTimeout(timer);code===0&&message?.type==='prepared'?resolve(message):reject(new Error(message?.code??'PREPARATION_FAILED'));});
  });
  const prepared=await prepare(root);
  const copy=new Database(path.join(root,'acceptance.sqlite'),{readonly:true});
  try {
    const actual=JSON.parse(copy.prepare("SELECT definition FROM agents WHERE id='r8-codex'").get().definition);
    assert.equal(actual.model,selected.model);assert.equal(actual.accountRef,selected.accountRef);
    assert.equal(actual.systemPrompt,definition.systemPrompt);assert.equal(actual.execution.sessionPolicy,'run');
    assert.equal(actual.permissionMode,'readonly');assert.deepEqual(actual.execution.nativeTools,[]);assert.deepEqual(actual.execution.platformTools,[]);
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM runs').get().n,0);
    assert.equal(copy.prepare('SELECT COUNT(*) n FROM orchestration_model_calls').get().n,0);
  } finally {copy.close();}
  const selectedIds=['sdk','codex','real-api'];
  assertFrozenSourceRoles(environment.database.db,prepared.sourceRoles,selectedIds);
  assert.throws(()=>assertFrozenSourceRoles(environment.database.db,prepared.sourceRoles,['sdk','other','real-api']),/SOURCE_ROLE_SELECTION_CHANGED/);
  for(const changed of [{...definition,model:'different-model'},{...definition,accountRef:sdk.accountRef},{...definition,systemPrompt:'changed'},
    {...definition,execution:{...definition.execution,sessionPolicy:'conversation'}}]){
    environment.database.run('UPDATE agents SET definition=? WHERE id=?',JSON.stringify(changed),'codex');
    assert.throws(()=>assertFrozenSourceRoles(environment.database.db,prepared.sourceRoles,selectedIds),/SOURCE_ROLE_CHANGED/);
  }
  environment.database.run('UPDATE agents SET definition=?,enabled=0 WHERE id=?',JSON.stringify(definition),'codex');
  assert.throws(()=>assertFrozenSourceRoles(environment.database.db,prepared.sourceRoles,selectedIds),/SOURCE_ROLE_CHANGED/);
  environment.database.run('UPDATE agents SET enabled=1 WHERE id=?','codex');
  assertFrozenSourceRoles(environment.database.db,prepared.sourceRoles,selectedIds);
  const sdkRoot=path.join(environment.root,'sdk-only-copy'),sdkPrepared=await prepare(sdkRoot,true);
  assertFrozenSourceRoles(environment.database.db,sdkPrepared.sourceRoles,['sdk','real-api']);
  assert.deepEqual(sdkPrepared.nativeRefresh,[]);
  const sdkCopy=new Database(path.join(sdkRoot,'acceptance.sqlite'),{readonly:true});
  try {
    assert.equal(sdkCopy.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
    assert.equal(sdkCopy.prepare("SELECT COUNT(*) n FROM accounts WHERE auth_type='native_login'").get().n,0);
    assert.equal(sdkCopy.prepare('SELECT COUNT(*) n FROM account_native_identities').get().n,0);
    assert.equal(sdkCopy.prepare("SELECT COUNT(*) n FROM agents WHERE json_extract(definition,'$.execution.driver')='codex-app-server'").get().n,0);
    assert.equal(sdkCopy.prepare('SELECT COUNT(*) n FROM runs').get().n,0);
    assert.equal(sdkCopy.prepare('SELECT COUNT(*) n FROM orchestration_model_calls').get().n,0);
  } finally {sdkCopy.close();}
  const cli=['--import',path.resolve('apps/server/node_modules/tsx/dist/loader.mjs'),'scripts/scoped-native-real-acceptance.mjs','--claude-agent','sdk','--api-agent','real-api','--skip-codex'];
  const dry=spawnSync(process.execPath,cli,{encoding:'utf8'});assert.equal(dry.status,0,dry.stderr);
  const dryResult=JSON.parse(dry.stdout);assert.equal(dryResult.skipCodex,true);assert.equal(dryResult.executed,false);assert.equal(dryResult.codexAccount,undefined);
  const conflict=spawnSync(process.execPath,[...cli,'--codex-agent','codex'],{encoding:'utf8'});
  assert.notEqual(conflict.status,0);assert.match(conflict.stderr,/CONFLICTING_CODEX_SELECTION/);
  const wrongScope=path.join(environment.root,'wrong-scope');await mkdir(wrongScope);
  await writeFile(path.join(wrongScope,'result.json'),JSON.stringify({limits:dryResult.limits,skipCodex:false}));
  const resumed=spawnSync(process.execPath,[...cli,'--resume','--execute','--output-dir',wrongScope],{encoding:'utf8'});
  assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/RESUME_SCOPE_CHANGED/);
  assert.equal(environment.externalRequests,0);
  console.log(JSON.stringify({passed:true,selectedRoleCopied:true,ordinaryToolsDisabled:true,resumeRoleDriftRejected:true,skipCodexCopiesNoCodexAccount:true,skipCodexCannotResumeFullCampaign:true,businessRowsCopied:0,supplierRequests:0}));
} finally {await environment.close();}
