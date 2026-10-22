import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './threadedBackendRuntimeFixture.mjs';
const [root,port,webPort,restore]=process.argv.slice(2);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),
  AGENTS_DIR:path.join(root,'agents'),HOST:'127.0.0.1',PORT:port,ACCOUNT_TRUSTED_ORIGINS:`http://127.0.0.1:${port},http://127.0.0.1:${webPort}`,THREADED_COLLABORATION_MODE:'closed'});
globalThis.fetch=async()=>{throw new Error('External network forbidden in T09 fixture');};
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../../apps/server/src/threaded/tools.ts');
let handler;
const f=await openBackendRuntimeFixture(root,'ui-t09',{restore:restore==='restore',applicationTools:THREADED_APPLICATION_TOOL_NAMES,fetch:async()=>{
  await handler?.();return new Response(JSON.stringify({id:randomUUID(),type:'message',content:[{type:'text',text:'本次调用的结果已保存。持续工作仍可继续。'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});}});
for(const c of f.configurations.values()){c.kind='api';c.backendVersion='threaded-http-v1';}
const {createThreadedStore}=await import('../../apps/server/src/threaded/store.ts');
const store=createThreadedStore(f.db);
if(restore!=='restore'){
  f.runtime.collaboration.routing.configure(f.thread.ownerId,f.thread.id,{preferred:[],defaultAgent:'api-member',groups:{team:['api-member','other-member']}},0);
  for(let i=0;i<105;i++)f.user(`历史消息 ${i+1}`,[]);
  const receipt=f.user('确认来源与三类回执',['api-member'],{attachments:[{name:'proof.txt',mediaType:'text/plain',contentBase64:Buffer.from('T09 attachment bytes').toString('base64')}]});
  const claim=f.runtime.queue.claimNext('t09-seed');
  handler=async()=>{
    const tool=async(name,input)=>{const r=JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));if(!r.ok)throw new Error(JSON.stringify(r));return r.result;};
    await tool('mark_seen',{idempotencyKey:'seen',messageIds:[receipt.message.id]});
    await tool('acknowledge_mentions',{idempotencyKey:'ack',messageIds:[receipt.message.id]});
    await tool('post_message',{idempotencyKey:'separate-post',body:'独立发送的消息',targets:['other-member']});
    await tool('hold_ball',{idempotencyKey:'timer',jobKey:'timer',seconds:3600,waitSourceRef:{kind:'thread_message',value:receipt.message.id,expectedSignal:'business_check_completed',slaUntilMs:Date.now()+7_200_000}});
    await tool('conversation_decision',{idempotencyKey:'decision',jobKey:'decision',question:'下一步优先检查哪一项？',block:'interactive',once:true});
    await tool('multi_mention',{idempotencyKey:'consult',targets:['other-member','sdk-member'],question:'给出各自不同意见',callbackTo:'api-member',overrideReason:'T09 synthetic UI acceptance'});
    if(process.env.THREADED_UI_ACTIONS==='1'){
      const task=await tool('create_task',{idempotencyKey:'ui-task',title:'T10 UI 领域任务',acceptanceCriteria:['保存可核验的交付结果']});
      await tool('transfer_action',{idempotencyKey:'ui-action',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']});
    }
    if(process.env.THREADED_UI_WORKFLOWS==='1'){
      await tool('update_sop',{idempotencyKey:'ui-sop-create',sopKey:'ui-workflow',expectedVersion:0,title:'T11 UI 协作告示',stage:'准备评审',baton:'other-member',
        checks:[{id:'attested',label:'T11 UI 自述检查',state:'attested'},{id:'unknown',label:'T11 UI 待核验检查',state:'unknown'}]});
      await tool('update_sop',{idempotencyKey:'ui-sop-version',sopKey:'ui-workflow',expectedVersion:1,stage:'评审准备'});
      const anchors=[{kind:'message',id:receipt.message.id}];
      const expired=await tool('knowledge_publish',{idempotencyKey:'ui-knowledge-v1',title:'T11 UI 过期知识',body:'T11_UI_KNOWLEDGE_V1：初始授权记录。',anchors});
      await tool('knowledge_publish',{idempotencyKey:'ui-knowledge-v2',knowledgeId:expired.knowledgeId,expectedVersion:1,title:'T11 UI 过期知识',body:'T11_UI_KNOWLEDGE_V2：第二版保留原始消息溯源。',anchors});
      await tool('knowledge_mark',{idempotencyKey:'ui-knowledge-expire',knowledgeId:expired.knowledgeId,expectedVersion:2,status:'expired',reason:'T11 隔离验收显式过期，保留版本历史。'});
      const current=await tool('knowledge_publish',{idempotencyKey:'ui-knowledge-current',title:'T11 UI 当前知识',body:'T11_UI_KNOWLEDGE_CURRENT：当前有效且有明确来源。',anchors});
      const prior=await tool('knowledge_publish',{idempotencyKey:'ui-knowledge-prior',title:'T11 UI 替代知识',body:'T11_UI_KNOWLEDGE_SUPERSEDED：由当前知识替代。',anchors});
      await tool('knowledge_mark',{idempotencyKey:'ui-knowledge-supersede',knowledgeId:prior.knowledgeId,expectedVersion:1,status:'superseded',replacementId:current.knowledgeId,reason:'T11 隔离验收显式替代。'});
    }
  };
  const result=await f.runtime.executeClaim(claim);if(result.status!=='completed')throw new Error(JSON.stringify(result));handler=undefined;
  f.user('PRIVATE_T09_OWNER_ONLY',[],{visibility:'private',audience:['api-member']});
  f.user('尚未发布的草稿',[],{state:'draft'});
  const second=store.createThread({title:'另一个持续空间',members:['api-member'].map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
  f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(second.id);
  f.runtime.collaboration.routing.configure(second.ownerId,second.id,{preferred:[],defaultAgent:'api-member'},0);
  f.runtime.messages.acceptUserMessage({ownerId:second.ownerId,threadId:second.id,clientRequestId:'second-message',body:'SECOND_THREAD_ONLY',targets:[]});
}
const {default:Fastify}=await import('../../apps/server/node_modules/fastify/fastify.js');
const {default:websocket}=await import('../../apps/server/node_modules/@fastify/websocket/index.js');
const {createThreadedAccess}=await import('../../apps/server/src/threaded/access.ts');
const {registerThreadedAccessBridge,registerThreadedRoutes}=await import('../../apps/server/src/api/threadedRoutes.ts');
const {createThreadedView}=await import('../../apps/server/src/threaded/view.ts');
const {threadedCapabilities,rejectThreadedAdmission}=await import('../../apps/server/src/threaded/policy.ts');
const management=await import('../../apps/server/src/accounts/access.ts');
let admitted=true;const access=createThreadedAccess(()=>f.thread.ownerId);
const context={store,access,messages:f.runtime.messages,lifecycle:f.runtime.lifecycle,collaboration:f.runtime.collaboration,
  onMessageNotification:f.runtime.messaging.onNotification,messageAdmission(){if(!admitted)rejectThreadedAdmission();},
  view:createThreadedView(f.db,{store,messages:f.runtime.messages,capabilities(){const c=threadedCapabilities();return {...c,implemented:{...c.implemented,admission:admitted}};}})};
const app=Fastify({logger:false});await app.register(websocket);
await app.register(async accounts=>{
  accounts.addHook('onRequest',async request=>{management.assertManagementBoundary(request);if(request.routeOptions.url!=='/api/accounts/session'||request.method!=='POST')management.requireManagementSession(request);});
  accounts.post('/api/accounts/session',async(request,reply)=>management.createManagementSession(request,reply));
  accounts.delete('/api/accounts/session',async(request,reply)=>management.deleteManagementSession(request,reply));
  await registerThreadedAccessBridge(accounts,context);
});await registerThreadedRoutes(app,context);
await app.listen({host:'127.0.0.1',port:Number(port)});
process.on('message',message=>{try{
  if(message.action==='append')f.user(message.body,[]);
  if(message.action==='admission')admitted=message.value;
  if(message.action==='count'){const count=f.db.prepare('SELECT COUNT(*) n FROM threaded_messages WHERE body=?').get(message.body).n;process.send?.({id:message.id,count});return;}
  process.send?.({id:message.id,ok:true});
}catch(e){process.send?.({id:message.id,error:e.message});}});
process.send?.({type:'ready',threadId:f.thread.id,secondId:store.listThreads(f.thread.ownerId).find(t=>t.id!==f.thread.id).id,
  decisionId:f.db.prepare("SELECT id FROM threaded_waits WHERE kind='decision'").get().id,
  ...(process.env.THREADED_UI_WORKFLOWS==='1'?{workflowSourceId:f.db.prepare("SELECT id FROM threaded_messages WHERE thread_id=? AND body='确认来源与三类回执'").get(f.thread.id).id}:{}),
});
