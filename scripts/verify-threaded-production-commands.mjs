import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,rename,symlink,copyFile,stat,utimes} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc03-commands-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {loadThreadedProductionCommands}=await import('../apps/server/src/threaded/productionCommands.ts');
const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
const {verifyThreadedOsCommandResourceEvidence}=await import('../apps/server/src/threaded/osCommands.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../apps/server/src/threaded/backends/evidence.ts');
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {openBackendRuntimeFixture}=await import('./fixtures/threadedBackendRuntimeFixture.mjs');
const cases=[],fixtures=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){const answer=await fn();if(answer)return answer;await pause(50);}throw new Error('Timed out');}
async function fixture(name,delay=50){
  let f,registry,version=1;const proxy={authorization:s=>registry?.commands.manifest.authorization(s)??'pending',validate:a=>registry.commands.manifest.validate(a),
    start:i=>{const pending=registry.commands.manifest.start(i);f.beforeGuardianReady?.(i);return pending;},observe:i=>registry.commands.manifest.observe(i),cancel:i=>registry.commands.manifest.cancel(i)};
  f=await openBackendRuntimeFixture(root,name,{applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{commands:{manifest:proxy}},
    fetch:async()=>{try{return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:await(f.handler?.(f.activeClaim)??'done')}],
      stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:2}}),{headers:{'content-type':'application/json'}});}catch(error){f.handlerError=error;throw error;}}});
  const project=path.join(root,`${name}-project`),member=path.join(project,'member'),output=path.join(project,'output'),file=path.join(root,`${name}-commands.json`);
  await mkdir(member,{recursive:true});await mkdir(output);await writeFile(path.join(member,'source.txt'),'fixed project contents\n');
  const scope={ownerId:f.thread.ownerId,threadId:f.thread.id,agentId:'other-member'};
  const config={schemaVersion:1,version:1,ownerId:f.thread.ownerId,projects:[{id:'project',root:project,members:[{threadId:scope.threadId,agentId:scope.agentId,workspace:member}]}],
    commands:[{id:'manifest',projectId:'project',threadId:scope.threadId,agentId:scope.agentId,profile:'project_manifest_v1',cwd:output,readPaths:[member],writeRoot:output,settleDelayMs:delay}]};
  await writeFile(file,JSON.stringify(config));
  let resources;resources=createExecutionResourceCoordinator(f.db,{ownerNonce:`rc03:${randomUUID()}`,verifyEvidence:(_request,identity,evidence)=>{
    const claim=resources.getClaim(identity.claimId);return !!claim&&(verifyThreadedOsCommandResourceEvidence(f.db,claim,evidence)||verifyThreadedBackendResourceEvidence(f.db,claim,evidence));}});
  const options={file,ownerId:f.thread.ownerId,mode:()=> 'execute',authorizeMember:s=>s.ownerId===scope.ownerId&&s.threadId===scope.threadId&&s.agentId===scope.agentId?`member:${version}`:null,resources};
  registry=loadThreadedProductionCommands(f.db,options);
  for(const c of f.configurations.values()){c.kind='api';c.backendVersion='threaded-http-v1';c.workspace=member;}
  const tool=async(claim,name,input)=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
  const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
  async function run(receipt,handler){if(receipt)for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
    const claim=f.runtime.queue.claimNext('rc03-command');assert.ok(claim);f.activeClaim=claim;f.handler=handler;
    const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;}
  async function start(){let action,command,holder;
    await run(f.user('Read a selected project through the registered bounded OS command'),async claim=>{
      const task=ok(await tool(claim,'create_task',{idempotencyKey:'task',title:'Collect project manifest',acceptanceCriteria:['Inspect trusted manifest']}));
      action=ok(await tool(claim,'transfer_action',{idempotencyKey:'transfer',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));return 'Transferred';});
    await run(undefined,async claim=>{holder=claim;command=ok(await tool(claim,'run_command',{idempotencyKey:'start',actionId:action.actionId,expectedGeneration:1,command:'manifest',args:{}}));
      ok(await tool(claim,'wait_command',{idempotencyKey:'wait',actionId:action.actionId,expectedGeneration:1,commandId:command.commandId}));return 'Waiting';});
    return {action,command,holder};}
  const h={f,scope,config,file,member,output,registry,resources,options,start,tool,ok,run,revoke:()=>version++,
    port:registry.commands.manifest,close(){registry.close();f.close();}};fixtures.push(h);return h;
}
const row=(h,id)=>h.f.db.prepare('SELECT * FROM threaded_os_commands WHERE command_id=?').get(id);
const claim=(h,id)=>h.resources.getClaim(JSON.parse(row(h,id).claim_record).claimId);
try{
  assert.equal(process.platform,'darwin');
  {
    const h=await fixture('contract');
    assert.equal(loadThreadedProductionCommands(h.f.db,{...h.options,file:undefined}),null);
    assert.equal(h.registry.resolveWorkspace(h.scope),h.member);assert.match(h.registry.workspaceIdentity(h.scope),/^[a-f0-9]{64}$/);
    assert.equal(h.registry.resolveWorkspace({...h.scope,agentId:'foreign'}),null);
    assert.equal(h.port.authorization({...h.scope,threadId:'foreign'}),null);
    for(const args of [{program:'/bin/sh'},{argv:['x']},{cwd:'/tmp'},{environment:{X:'x'}},{writePath:'/tmp/x'},'echo x'])assert.throws(()=>h.port.validate(args),/ARGUMENTS_FORBIDDEN/);
    for(const mutate of [c=>c.commands[0].program='/bin/sh',c=>c.commands[0].profile='arbitrary_shell',c=>c.commands[0].writeRoot=c.commands[0].cwd=h.member,c=>c.commands[0].readPaths=[root]]){
      const changed=structuredClone(h.config);mutate(changed);const file=path.join(root,`${randomUUID()}.json`);await writeFile(file,JSON.stringify(changed));
      assert.throws(()=>loadThreadedProductionCommands(h.f.db,{...h.options,file}),/CONFIGURATION_INVALID/);
    }
    const duplicate=path.join(root,'duplicate.json');await writeFile(duplicate,JSON.stringify(h.config).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'));
    assert.throws(()=>loadThreadedProductionCommands(h.f.db,{...h.options,file:duplicate}),/CONFIGURATION_INVALID/);
    const overlap=structuredClone(h.config);overlap.projects[0].members.push({...overlap.projects[0].members[0],agentId:'api-member'});
    const overlapFile=path.join(root,'overlap.json');await writeFile(overlapFile,JSON.stringify(overlap));
    assert.throws(()=>loadThreadedProductionCommands(h.f.db,{...h.options,file:overlapFile}),/CONFIGURATION_INVALID/);
    cases.push('strict JSON duplicate/unknown keys, unregistered profile/program, foreign scope, path escape/overlap and every model argument substitution are rejected; exact canonical mapping and fingerprint are available');
  }
  {
    const h=await fixture('complete',400),{command,holder}=await h.start();
    assert.equal(h.port.authorization(holder.binding),h.port.authorization(h.scope),'full binding and normalized scope have the same authority');
    assert.equal(command.state,'running');assert.equal(h.f.resources.getClaim(holder.binding.claimId).state,'released');assert.equal(claim(h,command.commandId).state,'started');
    assert.deepEqual(claim(h,command.commandId).request.workspaces,[{path:h.member,access:'read'},{path:h.output,access:'write'}]);
    const answer=await until(async()=>{const r=await h.port.observe({commandId:command.commandId,scope:h.scope});return r.state==='completed'?r:null;});
    assert.equal(JSON.parse(answer.result).resourceReleased,true);assert.equal(claim(h,command.commandId).state,'released');
    const manifest=JSON.parse(await readFile(path.join(h.output,'manifest.json'),'utf8'));assert.equal(manifest.files[0].path,'member/source.txt');
    assert.equal(manifest.files[0].bytes,23);assert.match(manifest.files[0].sha256,/^[a-f0-9]{64}$/);
    const replay=loadThreadedProductionCommands(h.f.db,h.options);try{assert.equal((await replay.commands.manifest.start({commandId:command.commandId,binding:holder.binding,args:null})).state,'completed');}finally{replay.close();}
    assert.equal(h.f.db.prepare("SELECT COUNT(*) n FROM threaded_os_command_events WHERE kind='native_started'").get().n,1);
    cases.push('actual fixed Node/worker/cwd/empty-env process reads selected pinned inputs and writes exact receipt; separate complete read/write resource claim outlives Invocation; independent host verifier plus native group stop releases; restart retry never launches twice');
  }
  {
    const h=await fixture('cancel',3000),{command}=await h.start();const answer=await h.port.cancel({commandId:command.commandId,scope:h.scope});
    assert.equal(answer.state,'cancelled');assert.equal(JSON.parse(answer.result).resourceReleased,true);
    assert.equal(claim(h,command.commandId).state,'released');
    cases.push('actual bounded command cancellation verifies exact guardian group stopped and independently empty effect domain before releasing only the command lease');
  }
  {
    const h=await fixture('unrecognized-output',400),{command}=await h.start();await writeFile(path.join(h.output,'undeclared.txt'),'untrusted');
    await until(()=>{const r=row(h,command.commandId);return JSON.parse(r.record).groupStopped?r:null;});
    assert.equal(row(h,command.commandId).state,'unknown');assert.equal(claim(h,command.commandId).state,'unknown');
    assert.equal(JSON.parse(row(h,command.commandId).record).resourceReleased,undefined);
    assert.equal(h.port.authorization(h.scope),null);
    await rm(path.join(h.output,'undeclared.txt'));assert.equal((await h.port.observe({commandId:command.commandId,scope:h.scope})).state,'completed');
    assert.equal(claim(h,command.commandId).state,'released');
    cases.push('any unrecognized output keeps the stopped native command and independent lease unknown; only later exact independent output reconciliation releases, without a rerun or trusting model claims');
  }
  {
    const h=await fixture('pending-output',400),{command}=await h.start();await writeFile(path.join(h.output,'manifest.json.pending'),'incomplete');
    await until(()=>{const r=row(h,command.commandId);return JSON.parse(r.record).groupStopped?r:null;});
    assert.equal(row(h,command.commandId).state,'unknown');assert.equal(claim(h,command.commandId).state,'unknown');
    assert.equal(h.port.authorization(h.scope),null);await rm(path.join(h.output,'manifest.json.pending'));
    const answer=await h.port.observe({commandId:command.commandId,scope:h.scope});assert.equal(answer.state,'failed');
    assert.equal(JSON.parse(answer.result).resourceReleased,true);
    cases.push('partial output is not a trusted receipt: failed native command stays unknown and fenced until independent removal leaves an empty fully reconciled effect domain; normal success requires the exact manifest');
  }
  {
    const h=await fixture('input-drift');await writeFile(path.join(h.member,'source.txt'),'changed');
    assert.equal(h.port.authorization(h.scope),null);assert.equal(h.registry.status().state,'inputs_changed');
    assert.throws(()=>h.registry.resolveWorkspace(h.scope),/MAPPING_CHANGED/);
    cases.push('source content/inode/ctime pin drift revokes commands and mapped workspace fails closed rather than falling back to a private directory');
  }
  {
    const h=await fixture('generation-before-exec',50);let task,action,command,transfer;
    await h.run(h.f.user('Transfer an Action before the native launch authorization boundary'),async claim=>{
      task=h.ok(await h.tool(claim,'create_task',{idempotencyKey:'task',title:'Fence native launch',acceptanceCriteria:['No stale native execution']}));
      action=h.ok(await h.tool(claim,'transfer_action',{idempotencyKey:'transfer',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));return 'Transferred';});
    await h.run(undefined,async claim=>{
      h.f.beforeGuardianReady=()=>{h.f.beforeGuardianReady=undefined;transfer=h.tool(claim,'transfer_action',{idempotencyKey:'return-before-native',subject:{kind:'task',taskId:task.taskId},
        predicate:'task_done',family:'work',successorSlot:'primary',targets:['api-member'],operation:'return',expectedGeneration:1});};
      command=h.ok(await h.tool(claim,'run_command',{idempotencyKey:'start',actionId:action.actionId,expectedGeneration:1,command:'manifest',args:{}}));
      h.ok(await transfer);assert.equal(command.state,'unknown');return 'Old launch fenced';
    });
    await until(()=>JSON.parse(row(h,command.commandId).record).groupStopped);
    assert.equal(h.f.db.prepare("SELECT COUNT(*) n FROM threaded_os_command_events WHERE kind IN ('launch_authorized','native_started')").get().n,0);
    assert.equal(h.f.db.prepare('SELECT generation FROM threaded_actions WHERE id=?').get(action.actionId).generation,2);
    await assert.rejects(()=>readFile(path.join(h.output,'manifest.json')),/ENOENT/);
    cases.push('actual guardian is spawned after durable intent, then a legitimate Action return advances generation before ready: resource revalidation refuses native execution, produces unknown, never writes an artifact or replays the old operation');
  }
  {
    const h=await fixture('path-drift'),moved=h.output+'-moved';await rename(h.output,moved);await symlink(moved,h.output);
    assert.equal(h.port.authorization(h.scope),null);assert.equal(h.registry.status().state,'path_changed');
    assert.throws(()=>h.registry.workspaceIdentity(h.scope),/MAPPING_CHANGED/);
    cases.push('replaced/symlinked canonical output directory revokes registration before any spawn and rejects frozen workspace identity');
  }
  {
    const h=await fixture('config-drift');await writeFile(h.file,JSON.stringify({...h.config,version:2}));
    assert.equal(h.port.authorization(h.scope),null);assert.equal(h.registry.status().state,'configuration_changed');
    const member=await fixture('member-revoked');const before=member.port.authorization(member.scope);member.revoke();
    assert.notEqual(member.port.authorization(member.scope),before);
    cases.push('registry version/file change permanently fences the process registration; current member permission identity changes its authority fingerprint');
  }
  {
    const h=await fixture('executable-chain');
    for(const changed of ['projectManifestWorker.mjs','../execution/guardian.mjs']){
      const copied=path.join(root,`chain-${randomUUID()}`);await mkdir(path.join(copied,'threaded'),{recursive:true});await mkdir(path.join(copied,'execution'));
      await writeFile(path.join(copied,'package.json'),JSON.stringify({type:'module'}));
      for(const name of ['productionCommands.ts','projectManifestWorker.mjs','osCommands.ts','osCommandResources.ts','authority.ts','contracts.ts','collaborationTypes.ts'])
        await copyFile(new URL(`../apps/server/src/threaded/${name}`,import.meta.url),path.join(copied,'threaded',name));
      await copyFile(new URL('../apps/server/src/execution/guardian.mjs',import.meta.url),path.join(copied,'execution','guardian.mjs'));
      const {loadThreadedProductionCommands:copiedLoader}=await import(new URL(`file://${path.join(copied,'threaded','productionCommands.ts')}`));
      const registry=copiedLoader(h.f.db,h.options);
      try{assert.ok(registry.commands.manifest.authorization(h.scope));const filename=path.resolve(copied,'threaded',changed),before=await stat(filename);
        await writeFile(filename,(await readFile(filename,'utf8'))+'\n// changed after registration\n');await utimes(filename,before.atime,before.mtime);
        assert.equal(registry.commands.manifest.authorization(h.scope),null);assert.equal(registry.status().state,'path_changed');
      }finally{registry.close();}
    }
    cases.push('isolated copies of both the native worker and guardian are pinned across registration: executable-chain content changes revoke authority even when the previous mtime is restored; no live repository source is modified');
  }
  const result={ok:true,platform:process.platform,checks:cases.length,passed:cases,realNativeProcesses:4,realModelRequests:0,realModelTokens:0,
    profiles:['project_manifest_v1'],arbitraryShell:false,buildCommands:false,networkCommands:false,dailyDatabaseOpened:false};
  if(process.env.THREADED_RC03_COMMAND_OUTPUT){await mkdir(path.dirname(process.env.THREADED_RC03_COMMAND_OUTPUT),{recursive:true});await writeFile(process.env.THREADED_RC03_COMMAND_OUTPUT,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify(result,null,2));
}finally{
  for(const h of fixtures)try{h.registry.close();}catch{}await pause(650);for(const h of fixtures)try{h.close();}catch{}
  await rm(root,{recursive:true,force:true});
}
