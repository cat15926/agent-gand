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
    await tool('hold_ball',{idempotencyKey:'timer',jobKey:'timer',seconds:3600,waitSourceRef:'timer:followup'});
    await tool('conversation_decision',{idempotencyKey:'decision',jobKey:'decision',question:'下一步优先检查哪一项？',block:'interactive',once:true});
    await tool('multi_mention',{idempotencyKey:'consult',targets:['other-member','sdk-member'],question:'给出各自不同意见',callbackTo:'api-member',overrideReason:'T09 synthetic UI acceptance'});
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
  decisionId:f.db.prepare("SELECT id FROM threaded_waits WHERE kind='decision'").get().id});
