import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'gand-native-auth-timeout-'))),command=path.join(root,'codex-fixture'),log=path.join(root,'rpc.jsonl');
for(const key of Object.keys(process.env))if(/^(ACCOUNT_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|EXTERNAL_|LLM_)/.test(key))delete process.env[key];
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'test.sqlite'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),AGENTS_DIR:path.join(root,'roles'),EXTERNAL_CODEX_COMMAND:command});
await writeFile(command,`#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n');if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');if(m.method==='turn/start')process.exit(2);});
`,{mode:0o700});
const db=await import('../apps/server/src/db/database.ts'),{createAccount,getAccount}=await import('../apps/server/src/accounts/store.ts');
const {prepareAccountLaunch}=await import('../apps/server/src/accounts/launch.ts');
try{
  const account=createAccount({displayName:'Native identity timeout fixture',authType:'native_login',nativeClient:'codex'}),directory=path.join(root,'private','native',account.id,'1'),now=new Date().toISOString();
  await mkdir(path.join(directory,'config'),{recursive:true,mode:0o700});await mkdir(path.join(directory,'login'),{recursive:true,mode:0o700});
  db.run("INSERT INTO account_native_identities (account_id,generation,client,directory,status,created_at,updated_at) VALUES (?,1,'codex',?,'authenticated',?,?)",account.id,directory,now,now);
  db.run('UPDATE accounts SET identity_generation=1 WHERE id=?',account.id);
  const start=Date.now();
  await assert.rejects(()=>prepareAccountLaunch('codex-app-server',{managed:true,accountId:account.id,authType:'native_login',connection:getAccount(account.id).connection,nativeClient:'codex',nativeDirectory:directory,runtimeHome:path.join(directory,'config'),binding:{identityGeneration:1}},new AbortController().signal),error=>{
    assert.equal(error.code,'timeout');assert.equal(error.details.phase,'initialization');assert.equal(error.details.initializationStep,'client');assert.equal(error.details.limitMs,15000);assert.match(error.message,/15 秒/);assert.doesNotMatch(error.message,/600 秒/);return true;
  });
  assert.ok(Date.now()-start<20000);
  const methods=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).map(r=>r.method);assert.ok(methods.includes('account/read'));assert.ok(!methods.includes('turn/start'));
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_model_calls').n,0);
  console.log(JSON.stringify({passed:true,identityTimeoutMs:15000,replyTimeoutMs:600000,modelTurns:0,supplierRequests:0}));
}finally{db.closeDatabase();await rm(root,{recursive:true,force:true});}
