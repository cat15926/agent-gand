import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t12-production-ui-'))),output=path.resolve(process.env.THREADED_PRODUCTION_UI_OUTPUT??'docs/reports/evidence/threaded-t12-production-ui');await mkdir(output,{recursive:true});
let child,web,browser,page,metadata;const checks=[],errors=[],requests=[],screenshots=[];
const freePort=async()=>{const s=net.createServer();await new Promise((yes,no)=>s.once('error',no).listen(0,'127.0.0.1',yes));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;};
const apiPort=await freePort(),webPort=await freePort(),origin=`http://127.0.0.1:${webPort}`;
async function start(pack,mode){child=fork(new URL('./fixtures/threadedProductionUiServer.mjs',import.meta.url),[root,String(apiPort),String(webPort),pack,mode],{
  execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','pipe','pipe','ipc']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  metadata=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`UI fixture ${code}: ${logs}`)));});}
async function stop(){if(child&&child.exitCode===null&&!child.signalCode){const old=child;await new Promise(resolve=>{old.once('exit',resolve);old.kill('SIGKILL');});}}
async function command(action='snapshot'){const id=randomUUID(),current=child;return new Promise((resolve,reject)=>{const receive=m=>{if(m.id===id){current.off('message',receive);m.error?reject(new Error(m.error)):resolve(m.snapshot);}};current.on('message',receive);current.send({id,action});});}
async function connect(){await page.goto(`${origin}/?surface=threaded`);await page.getByRole('button',{name:'连接持续协作',exact:true}).click();await page.getByRole('region',{name:'持续协作工作台',exact:true}).waitFor();}
async function operations(){const details=page.locator('aside > details').filter({has:page.locator('summary').filter({hasText:'工作入场与排空'})});if(!await details.evaluate(el=>el.open))await details.locator(':scope > summary').click();return details;}
async function screenshot(name){await page.screenshot({path:path.join(output,name),fullPage:true});screenshots.push(name);}
async function wait(predicate,label){const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(label);}
async function request(method,url,body){return page.evaluate(async({method,url,body})=>{const session=await(await fetch('/api/threaded/session')).json(),r=await fetch(url,{method,headers:{'content-type':'application/json','x-gand-csrf':session.csrfToken},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},{method,url,body});}
try{
  await start('no-pack','execute');
  const {createServer}=await import('../apps/web/node_modules/vite/dist/node/index.js');web=await createServer({root:path.resolve('apps/web'),configFile:path.resolve('apps/web/vite.config.ts'),cacheDir:path.join(root,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:webPort,strictPort:true,
    proxy:{'/api/threaded/ws':{target:`ws://127.0.0.1:${apiPort}`,ws:true},'/api':`http://127.0.0.1:${apiPort}`,'/ws':{target:`ws://127.0.0.1:${apiPort}`,ws:true}}}});await web.listen();
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().includes('/api/threaded/')&&r.method()!=='GET')requests.push({method:r.method(),path:new URL(r.url()).pathname,...(r.postDataJSON()?{body:r.postDataJSON()}:{} )});});
  await connect();await page.getByText('新建空间尚未开放',{exact:true}).waitFor();assert.equal(await page.getByLabel('新空间名称',{exact:true}).count(),0);
  const denied=await request('POST','/api/threaded/threads',{title:'Cannot bypass pack',clientRequestId:randomUUID()});assert.equal(denied.status,403);
  const noPack=await command();assert.equal(noPack.admission.configured,false);assert.equal(noPack.admission.canCreate,false);assert.equal(noPack.threads.length,0);assert.equal(noPack.injectedModelCalls,0);assert.equal(noPack.credentialResolutions,0);
  await screenshot('no-pack-desktop.png');checks.push('Actual Chrome + production HTTP factory: execute mode without operator pack offers no create form, direct authenticated creation rejects, no Thread/credential resolution/model request occurs');
  await stop();await start('pack','execute');await connect();await operations();
  await page.getByRole('button',{name:'开放新工作',exact:true}).click();await page.getByLabel('新空间名称',{exact:true}).waitFor();
  await page.getByLabel('新空间名称',{exact:true}).fill('T12 Chrome 固定成员空间');
  const creation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/threaded/threads'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'新建空间',exact:true}).click();const created=await creation;assert.equal(created.status(),200);const {thread}=await created.json();
  const payload=created.request().postDataJSON();assert.deepEqual(Object.keys(payload).sort(),['clientRequestId','title']);assert.equal(payload.title,'T12 Chrome 固定成员空间');
  await page.getByRole('heading',{name:'T12 Chrome 固定成员空间',exact:true}).waitFor();const afterCreate=await command();assert.deepEqual(afterCreate.threads[0].members,metadata.members);
  assert.equal(afterCreate.admission.control.admissionOpen,true);assert.equal(afterCreate.admission.control.dispatchOpen,true);assert.equal(afterCreate.injectedModelCalls,0);assert.equal(afterCreate.credentialResolutions,0);
  const spoof=await request('POST','/api/threaded/threads',{title:'Forged roster',clientRequestId:randomUUID(),members:[{agentId:'unregistered'}]});assert.equal(spoof.status,400);
  await screenshot('created-desktop.png');checks.push('Actual title-only Chrome creation posts exactly title/clientRequestId; server freezes both pinned pack members and rejects client roster injection without resolving credentials or invoking a model');
  await operations();await page.getByRole('button',{name:'暂停后续执行',exact:true}).click();await operations();
  await wait(async()=>{const s=await command();return s.release.control.admissionOpen&&!s.release.control.dispatchOpen;},'Dispatch pause must preserve ingress');
  await wait(()=>page.getByRole('button',{name:'继续已有工作',exact:true}).isEnabled(),'Pause control UI refresh must settle before editing the new composer');
  await page.getByLabel('持续协作消息',{exact:true}).fill('@pinned-alpha T12_UI_HISTORY_PRESERVED');await page.getByText(/预览：@pinned-alpha · 依次执行/).waitFor();await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByText('@pinned-alpha T12_UI_HISTORY_PRESERVED',{exact:true}).waitFor();const paused=await command();assert.equal(paused.injectedModelCalls,0);assert.equal(paused.terminals.length,0);
  await operations();await page.getByRole('button',{name:'停止新工作',exact:true}).click();await page.getByText('新建空间尚未开放',{exact:true}).waitFor();
  await page.getByText('新工作入场已关闭；现有历史与控制可用。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);
  await page.reload();await page.getByRole('heading',{name:'T12 Chrome 固定成员空间',exact:true}).waitFor();await page.getByText('@pinned-alpha T12_UI_HISTORY_PRESERVED',{exact:true}).waitFor();
  const closed=await command();assert.equal(closed.release.control.admissionOpen,false);assert.equal(closed.release.control.dispatchOpen,false);assert.equal(closed.threads.length,1);assert.deepEqual(closed.threads[0].members,metadata.members);
  await screenshot('closed-history-desktop.png');checks.push('Pause future dispatch preserves open ingress and accepts a durable message without model execution; closing ingress then persists across Chrome reload, hides creation/disables sending and retains Thread/roster/history');
  await operations();await page.getByRole('button',{name:'继续已有工作',exact:true}).click();await page.getByText('T12_UI_ACCEPTED_WORK_COMPLETED',{exact:true}).waitFor();
  const continued=await command();assert.equal(continued.release.control.admissionOpen,false);assert.equal(continued.release.control.dispatchOpen,true);assert.equal(continued.injectedModelCalls,1);assert.equal(continued.terminals.length,1);assert.equal(continued.terminals[0].status,'completed');
  await operations();await page.getByRole('button',{name:'暂停后续执行',exact:true}).click();await operations();const repaused=await command();assert.equal(repaused.release.control.admissionOpen,false);assert.equal(repaused.release.control.dispatchOpen,false);
  checks.push('Continue accepted work changes dispatch alone while ingress remains closed; one actual production scheduler request uses injected transport and completes the persisted message; pausing again preserves the independent ingress control');
  await page.getByRole('button',{name:'开放新工作',exact:true}).click();await page.getByLabel('新空间名称',{exact:true}).waitFor();await operations();const beforeObserve=await command();assert.equal(beforeObserve.release.control.admissionOpen,true);assert.equal(beforeObserve.release.control.dispatchOpen,true);
  await stop();await start('pack','observe');await connect();await page.getByRole('heading',{name:'T12 Chrome 固定成员空间',exact:true}).waitFor();await page.getByText('T12_UI_ACCEPTED_WORK_COMPLETED',{exact:true}).waitFor();await operations();
  const observationBefore=await command();assert.equal(observationBefore.admission.mode,'observe');assert.equal(observationBefore.admission.canCreate,false);assert.equal(await page.getByLabel('新空间名称',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'开放新工作',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'继续已有工作',exact:true}).isDisabled(),true);
  for(const name of ['停止新工作','暂停后续执行','路由设置'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  await page.getByText('空间控制 ▾',{exact:true}).click();for(const name of ['暂停空间','停止空间工作','恢复空间'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  await page.getByText('空间控制 ▾',{exact:true}).click();await page.getByRole('button',{name:'成员与调用',exact:true}).click();
  for(const member of metadata.members)for(const name of [`暂停 @${member}`,`停止 @${member}`,`恢复 @${member}`])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  await page.getByText('@pinned-alpha · 本次调用已结束',{exact:true}).click();for(const name of ['暂停此调用','停止此调用','恢复此调用'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'收起成员与调用',exact:true}).click();
  const immutable=await request('POST','/api/threaded/release/controls',{expectedVersion:observationBefore.release.control.version,requestId:randomUUID(),reason:'Readonly browser rejection',admissionOpen:false,dispatchOpen:false});assert.equal(immutable.status,403);assert.equal(immutable.body.code,'THREADED_RELEASE_OBSERVE_ONLY');
  const createObserve=await request('POST','/api/threaded/threads',{title:'Observe cannot create',clientRequestId:randomUUID()});assert.equal(createObserve.status,403);
  const controlObserve=await request('POST',`/api/threaded/threads/${thread.id}/controls`,{action:'pause',requestId:randomUUID()});assert.equal(controlObserve.status,403);
  const observationAfter=await command();assert.equal(observationAfter.databaseHash,observationBefore.databaseHash);assert.equal(observationAfter.injectedModelCalls,0);assert.equal(observationAfter.credentialResolutions,0);assert.equal(observationAfter.terminals.length,1);
  await screenshot('observe-desktop.png');await page.setViewportSize({width:390,height:844});
  const mobileOperations=page.locator('aside > details').filter({has:page.locator('summary').filter({hasText:'工作入场与排空'})});if(await mobileOperations.evaluate(el=>el.open))await mobileOperations.locator(':scope > summary').click();
  assert.ok(await page.getByTestId('threaded-timeline').evaluate(el=>el.clientHeight>50));await page.getByText('T12_UI_ACCEPTED_WORK_COMPLETED',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await screenshot('observe-mobile.png');
  checks.push('Actual HTTP process SIGKILL/restart in observe mode retains prior history/control data, disables create/send/release/space/member/Invocation/routing mutations, rejects authenticated release/Thread writes with 403, changes no database row and resolves no credentials or model requests; 390px view has no horizontal overflow and keeps a nonzero historical timeline');
  assert.deepEqual(errors,[]);
  const report={ok:true,date:new Date().toISOString(),groups:checks.length,checks,browser:await browser.version(),platform:process.platform,
    modelEvidence:'One actual production scheduler request, injected Anthropic-compatible transport; no supplier network or real credential access',injectedModelCalls:continued.injectedModelCalls,realModelCalls:0,realModelTokens:0,realExternalWrites:0,
    productionAuthority:true,fixtureDatabase:true,processRestart:'Actual isolated HTTP fixture SIGKILL and new process on same SQLite',creationPayload:payload,pinnedMembers:metadata.members,
    observeDatabaseUnchanged:true,requests,screenshots};await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:true,groups:checks.length,checks,output},null,2));
}catch(error){if(page){console.log('Production UI failure:',(await page.locator('body').innerText()).slice(0,4500));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();await web?.close();await stop();await rm(root,{recursive:true,force:true});}
