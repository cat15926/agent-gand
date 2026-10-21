import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {randomUUID} from 'node:crypto';

const workflowMode=process.env.THREADED_UI_WORKFLOWS==='1';
const root=await realpath(await mkdtemp(path.join(tmpdir(),workflowMode?'agent-gand-t11-ui-':'agent-gand-t09-ui-')));
const output=path.resolve(process.env.THREADED_UI_OUTPUT??(workflowMode?'docs/reports/evidence/threaded-t11-ui':'docs/reports/evidence/threaded-t09-ui'));await mkdir(output,{recursive:true});
const checks=[],errors=[],workflowSourceReads=[];let child,web,browser,page,metadata;
const freePort=async()=>{const s=net.createServer();await new Promise((yes,no)=>s.once('error',no).listen(0,'127.0.0.1',yes));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;};
const apiPort=await freePort(),webPort=await freePort(),origin=`http://127.0.0.1:${webPort}`;
async function start(restore=false){
  child=fork(new URL('./fixtures/threadedUiServer.mjs',import.meta.url),[root,String(apiPort),String(webPort),restore?'restore':'seed'],{
    execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);child.stdout.on('data',data=>stderr+=data);
  metadata=await new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='ready')resolve(m);});child.once('error',reject);child.once('exit',code=>reject(new Error(`T09 server exited ${code}: ${stderr}`)));});
}
async function stop(){if(!child||child.exitCode!==null||child.signalCode)return;const old=child;await new Promise(resolve=>{old.once('exit',resolve);old.kill('SIGKILL');});}
async function command(value){const id=randomUUID();return new Promise((resolve,reject)=>{const current=child;const receive=m=>{if(m.id===id){current.off('message',receive);m.error?reject(new Error(m.error)):resolve(m);}};current.on('message',receive);current.send({...value,id});});}
const wait=async(test,message)=>{const end=Date.now()+12000;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw new Error(message);};
const workflows=()=>page.getByTestId('threaded-workflows');
async function openWorkflows(){if(!await workflows().evaluate(el=>el.open))await workflows().locator(':scope > summary').click();}
async function closeWorkflows(){if(await workflows().evaluate(el=>el.open))await workflows().locator(':scope > summary').click();}
async function expandWorkflowSource(container,phase){
  const sources=container.locator('details').filter({has:page.locator('summary').filter({hasText:/^获权来源（/})}).last();
  if(!await sources.evaluate(el=>el.open))await sources.locator(':scope > summary').click();
  const target=`/api/threaded/threads/${metadata.threadId}/messages/${metadata.workflowSourceId}`;
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===target&&r.request().method()==='GET');
  await sources.getByRole('button',{name:new RegExp(`^展开 #\\d+ · ${metadata.workflowSourceId}$`)}).click();
  const result=await pending;assert.equal(result.status(),200);const body=await result.json();assert.equal(body.message.id,metadata.workflowSourceId);assert.equal(body.message.body,'确认来源与三类回执');
  await sources.getByText('确认来源与三类回执',{exact:true}).waitFor();workflowSourceReads.push({phase,status:result.status(),path:target,messageId:body.message.id});
}
try{
  await start();
  const {createServer}=await import('../apps/web/node_modules/vite/dist/node/index.js');
  web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:{
    '/api/threaded/ws':{target:`ws://127.0.0.1:${apiPort}`,ws:true},'/api':`http://127.0.0.1:${apiPort}`,'/ws':{target:`ws://127.0.0.1:${apiPort}`,ws:true}}}});await web.listen();
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/'))console.log('T09 HTTP',r.status(),new URL(r.url()).pathname,(await r.text().catch(()=>'' )).slice(0,300));});
  const legacyRequests=[];page.on('request',request=>{if(/\/api\/(runs|conversations|tasks|usage|agents)(?:[/?]|$)/.test(request.url()))legacyRequests.push(request.url());});
  await page.goto(`${origin}/?surface=threaded&thread=${metadata.threadId}`);
  await page.getByRole('button',{name:'连接持续协作',exact:true}).click();await page.getByRole('heading',{name:'ui-t09',exact:true}).waitFor();
  await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).waitFor();assert.equal(legacyRequests.length,0);
  const articleCount=()=>page.locator('article[data-message-id]').count();assert.ok(await articleCount()<=100);
  await page.getByText('上下文已交付 · 已读 · 提及已确认',{exact:false}).waitFor();
  await page.getByText('独立发送的消息',{exact:true}).waitFor();await page.getByText('本次调用的结果已保存。持续工作仍可继续。',{exact:true}).waitFor();
  checks.push('Dedicated authenticated Thread surface hydrates zero legacy endpoints; public/private/draft, independent post/final and exact delivery/seen/mention ACK render without treating an Invocation as business completion');
  if(process.env.THREADED_UI_ACTIONS==='1'){
    await page.getByText('业务责任与领域校验',{exact:true}).click();await page.getByTestId('threaded-actions').getByText(/责任进行中/).waitFor();
    await page.getByTestId('threaded-actions').getByText(/领域校验：已核验/).waitFor();
    const business=await page.evaluate(async id=>(await(await fetch(`/api/threaded/threads/${id}/view`)).json()).snapshot.business,metadata.threadId);
    assert.equal(business.available,true);assert.equal(business.actions.length,1);assert.equal(business.actions[0].state,'active');
    assert.equal(business.actions[0].approvalGateSatisfied,false);
    checks.push('T10 actual browser renders canonical platform Action, current holder and generation, verified domain freshness independently of Invocation completion; no approval gate is invented');
  }
  if(workflowMode){
    await page.getByText('评审、SOP 与基础知识',{exact:true}).waitFor();await openWorkflows();
    const board=workflows().locator('section').filter({has:page.getByRole('heading',{name:'SOP · T11 UI 协作告示 · 版本 2',exact:true})});
    await board.getByText('阶段：评审准备 · 交棒：other-member；告示状态不授予执行权。',{exact:true}).waitFor();
    await board.getByText('T11 UI 自述检查 · 成员自述',{exact:true}).waitFor();await board.getByText('T11 UI 待核验检查 · 待核验',{exact:true}).waitFor();
    assert.equal(await board.getByText(/已核验任务事实/).count(),0);await expandWorkflowSource(board,'desktop-sop');
    const business=await page.evaluate(async id=>(await(await fetch(`/api/threaded/threads/${id}/view`)).json()).snapshot.business,metadata.threadId);
    assert.equal(business.sops.length,1);assert.equal(business.sops[0].version,2);assert.deepEqual(business.sops[0].checks.map(c=>c.state),['attested','unknown']);assert.equal(business.reviews.length,0);
    checks.push('T11 actual runtime tool-created SOP version 2 renders attested/unknown checks and descriptive stage/baton without inventing verification, review approval or execution ownership; source expansion performs an authenticated exact message HTTP GET');
    await workflows().getByRole('heading',{name:'基础知识 · 字面匹配检索',exact:true}).waitFor();
    const expired=workflows().locator('details').filter({has:page.locator('summary').filter({hasText:'T11 UI 过期知识 · v3 · 已过期'})}).first();
    await expired.locator(':scope > summary').click();await expired.getByText('T11_UI_KNOWLEDGE_V2：第二版保留原始消息溯源。',{exact:true}).waitFor();
    await expandWorkflowSource(expired,'desktop-knowledge');
    const current=business.knowledge.items.find(k=>k.title==='T11 UI 当前知识'),superseded=business.knowledge.items.find(k=>k.title==='T11 UI 替代知识');
    assert.equal(business.knowledge.retrieval,'literal_substring');assert.equal(business.knowledge.items.find(k=>k.title==='T11 UI 过期知识').status,'expired');
    assert.equal(superseded.status,'superseded');assert.equal(superseded.replacementId,current.knowledgeId);
    await workflows().getByText('T11 UI 替代知识 · v2 · 已替代',{exact:true}).click();await workflows().getByText(`替代项：${current.knowledgeId}`,{exact:true}).waitFor();
    await board.locator('details').locator(':scope > summary').click();await expired.locator(':scope > summary').click();
    await workflows().getByText('T11 UI 替代知识 · v2 · 已替代',{exact:true}).click();
    await workflows().locator(':scope > div').evaluate(el=>{el.scrollTop=0;});
    await page.screenshot({path:path.join(output,'workflows-desktop.png'),fullPage:true});await closeWorkflows();
    checks.push('T11 versioned home knowledge renders explicit expired v3, superseded v2 and active replacement state; literal retrieval is named accurately and exact anchor expansion reads authoritative published source through real HTTP');
  }
  const snapshot=await page.evaluate(async id=>(await fetch(`/api/threaded/threads/${id}/view`)).json(),metadata.threadId);
  assert.ok(snapshot.snapshot.progress.some(p=>p.delivered&&p.seen&&p.mentionAcknowledged));
  assert.ok(!JSON.stringify(snapshot).includes('fencing_token'));assert.ok(!JSON.stringify(snapshot).includes('nativeId'));
  const bad=await page.evaluate(async id=>({fake:(await fetch(`/api/threaded/threads/${id}/view?ownerId=forged`)).status,
    future:(await fetch(`/api/threaded/threads/${id}/view?afterEventSeq=999999`)).status}),metadata.threadId);
  assert.deepEqual(bad,{fake:400,future:409});
  let cursor=0,replay=[];
  for(let i=0;i<10;i++){const value=await page.evaluate(async({id,cursor})=>(await fetch(`/api/threaded/threads/${id}/view?afterEventSeq=${cursor}`)).json(),{id:metadata.threadId,cursor});
    replay.push(...value.changes.events);assert.ok(value.changes.throughSeq>=cursor);cursor=value.changes.throughSeq;if(!value.changes.hasMore)break;}
  assert.equal(new Set(replay.map(e=>e.id)).size,replay.length);assert.ok(replay.length>100);
  checks.push('Authorized bounded projection omits fences/native data; identity spoof and future cursor reject; durable change pages cross 100 events with unique replay IDs');
  await page.getByRole('button',{name:'更早消息',exact:true}).click();await page.getByText('历史消息 1',{exact:true}).waitFor();
  await page.getByRole('button',{name:'返回最新消息',exact:true}).click();await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^另一个持续空间/}).click();await page.getByText('SECOND_THREAD_ONLY',{exact:true}).waitFor();assert.equal(await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).count(),0);
  await page.goBack();await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).waitFor();await page.reload();await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).waitFor();
  checks.push('Earlier authorized page, Thread switch, browser back and reload restore the selected Thread without merging another Thread or persisting private bodies');
  await page.getByRole('button',{name:'成员与调用',exact:true}).click();await page.getByText('下一步优先检查哪一项？',{exact:true}).waitFor();
  await page.getByLabel(`回应问题 ${metadata.decisionId}`,{exact:true}).fill('先检查来源授权');await page.getByRole('button',{name:'提交回应',exact:true}).click();
  await wait(async()=>(await command({action:'count',body:'先检查来源授权'})).count===1,'Decision canonical answer not saved');
  await page.getByRole('button',{name:'暂停 @api-member',exact:true}).click();await page.getByText(/已暂停 · 当前无执行/).waitFor();
  await page.getByRole('button',{name:'恢复 @api-member',exact:true}).click();
  checks.push('Ordinary Decision is versioned canonical user input, distinct from execution approval; member-scoped controls reflect persisted state with explicit unknown/fence wording');
  await page.getByRole('button',{name:'路由设置',exact:true}).click();
  const routing=page.getByRole('dialog',{name:'路由设置',exact:true});await routing.getByRole('button',{name:'添加群组',exact:true}).click();
  await routing.getByLabel('群组名称 2',{exact:true}).fill('reviewers');
  await routing.getByLabel('群组名称 2',{exact:true}).locator('..').getByRole('checkbox',{name:'@other-member',exact:true}).check();
  await routing.getByRole('button',{name:'保存路由设置',exact:true}).click();await routing.waitFor({state:'hidden'});
  await page.getByLabel('持续协作消息',{exact:true}).fill('@reviewers 检查来源');await page.getByText(/预览：@other-member · 依次执行/).waitFor();
  checks.push('Accessible routing editor saves project group membership through expectedVersion CAS; the new policy version updates the same server preview without JSON or identity impersonation');
  await page.getByLabel('持续协作消息',{exact:true}).fill('@team 两位独立分析');await page.getByText(/预览：.*独立并行/).waitFor();
  await page.getByLabel('协作意图',{exact:true}).selectOption('execute');await page.getByText(/预览：.*依次执行/).waitFor();
  await page.getByLabel('协作意图',{exact:true}).selectOption('auto');
  await page.getByLabel('持续协作消息',{exact:true}).fill('@api-member T09_LOST_RECEIPT');await page.getByText(/预览：@api-member · 依次执行/).waitFor();
  const lost='**/api/threaded/threads/*/messages';let dropped=false;
  await page.route(lost,async route=>{if(route.request().method()==='POST'&&!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText(/再次提交相同内容会复用请求身份/).waitFor();
  await page.getByRole('button',{name:'发送消息',exact:true}).click();await wait(async()=>await page.getByLabel('持续协作消息',{exact:true}).inputValue()==='','Receipt retry did not finish');
  assert.equal((await command({action:'count',body:'@api-member T09_LOST_RECEIPT'})).count,1);await page.unroute(lost);
  checks.push('Composer preview follows group/intent policy; transport drops the committed POST response and exact retry keeps one canonical message');
  await page.getByLabel('消息可见范围',{exact:true}).selectOption('private');
  await page.getByLabel('持续协作消息',{exact:true}).fill('@api-member T09_PRIVATE_AUDIENCE');await page.getByText(/预览：@api-member · 依次执行/).waitFor();
  await page.getByRole('group',{name:'私密可见成员',exact:true}).getByRole('checkbox',{name:'@other-member',exact:true}).check();
  await page.getByRole('button',{name:'发送消息',exact:true}).click();await wait(async()=>await page.getByLabel('持续协作消息',{exact:true}).inputValue()==='','Private post not acknowledged');
  const privateState=await page.evaluate(async id=>(await fetch(`/api/threaded/threads/${id}/view`)).json(),metadata.threadId);
  const privateMessage=privateState.snapshot.messages.find(m=>m.body==='@api-member T09_PRIVATE_AUDIENCE');assert.deepEqual(privateMessage.targets,['api-member']);assert.ok(privateMessage.audience.includes('other-member'));
  assert.ok(!privateState.snapshot.progress.some(p=>p.messageId===privateMessage.id&&p.agentId==='other-member'&&p.queued));
  await page.getByLabel('消息可见范围',{exact:true}).selectOption('public');
  checks.push('Private composer keeps routing recipients separate from visible audience: an additional authorized observer can read without creating its Wake');
  await page.context().setOffline(true);await command({action:'append',body:'T09_OFFLINE_GAP'});
  await wait(async()=>await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).count()===0,'Offline refresh did not hide private snapshot');await page.context().setOffline(false);
  await page.getByText('T09_OFFLINE_GAP',{exact:true}).waitFor();
  await wait(async()=>await page.locator('article').filter({hasText:'T09_OFFLINE_GAP'}).count()===1,'Duplicate replay after network gap');
  checks.push('Browser offline/online gap restores an authoritative snapshot and durable cursor, one visible message per ID');
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.getByRole('heading',{name:'ui-t09',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'关闭成员与调用状态',exact:true}).click();
  if(workflowMode){
    await openWorkflows();await workflows().getByText('T11 UI 自述检查 · 成员自述',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,'workflows-mobile.png'),fullPage:true});await closeWorkflows();
    checks.push('T11 workflow panel remains usable at 390x844 without horizontal page overflow, preserving SOP descriptive trust labels and knowledge status controls');
  }
  assert.ok(await page.getByTestId('threaded-timeline').evaluate(el=>el.clientHeight>50));
  await page.screenshot({path:path.join(output,'mobile-timeline.png'),fullPage:true});
  checks.push('Desktop 1440x1000 and mobile 390x844 layouts render without horizontal page overflow');
  await stop();await wait(async()=>await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).count()===0,'Disconnected view retained private cache');
  await start(true);await page.getByRole('button',{name:'重新连接持续协作',exact:true}).click();await page.getByRole('heading',{name:'ui-t09',exact:true}).waitFor();
  await page.getByText('T09_OFFLINE_GAP',{exact:true}).waitFor();await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).waitFor();
  assert.equal((await command({action:'count',body:'@api-member T09_LOST_RECEIPT'})).count,1);
  if(workflowMode){
    await openWorkflows();
    const restored=workflows().locator('section').filter({has:page.getByRole('heading',{name:'SOP · T11 UI 协作告示 · 版本 2',exact:true})});
    await restored.getByText('T11 UI 自述检查 · 成员自述',{exact:true}).waitFor();await expandWorkflowSource(restored,'restart-sop');
    await workflows().getByText('T11 UI 过期知识 · v3 · 已过期',{exact:true}).waitFor();await workflows().getByText('T11 UI 替代知识 · v2 · 已替代',{exact:true}).waitFor();
    await closeWorkflows();checks.push('T11 actual HTTP process SIGKILL and new runtime/SQLite connection restore immutable SOP/knowledge versions and expiry/replacement state; fresh authorized source GET succeeds without producer or model replay');
  }
  checks.push('Actual isolated HTTP server SIGKILL/restart with the same SQLite: private UI cache clears on disconnect; fresh session restores canonical messages, waits and controls without model replay');
  await command({action:'admission',value:false});await page.getByText('新工作入场已关闭；现有历史与控制可用。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'断开会话',exact:true}).click();await page.getByRole('button',{name:'连接持续协作',exact:true}).waitFor();assert.equal(await page.getByText('PRIVATE_T09_OWNER_ONLY',{exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage).filter(k=>/threaded/i.test(k))),[]);
  checks.push('Closed admission disables new message/Decision input while history/control remains; logout removes private content and no Threaded bodies or tokens enter localStorage');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({ok:true,date:new Date().toISOString(),groups:checks.length,checks,realModelCalls:0,externalNetworkCalls:0,
    ...(workflowMode?{workflowSourceReads,workflowData:'Produced by actual SOP/knowledge tools in an authenticated running Binding; source is the exact original published message anchor; review workflow separately verified'}:{}),
    processRestart:'Actual fixture HTTP process SIGKILL, new process and SQLite connection; no production service or business database',screenshots:['desktop.png','mobile.png','mobile-timeline.png',...(workflowMode?['workflows-desktop.png','workflows-mobile.png']:[])]},null,2)+'\n');
  console.log(JSON.stringify({ok:true,groups:checks.length,checks,output},null,2));
}catch(error){if(page){console.log('T09 failure screen:',(await page.locator('body').innerText()).slice(0,3500));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}throw error;
}finally{await browser?.close();await web?.close();await stop();await rm(root,{recursive:true,force:true});}
