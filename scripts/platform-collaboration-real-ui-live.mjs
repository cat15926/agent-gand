import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir}from'node:fs/promises';
import path from'node:path';
import {pathToFileURL}from'node:url';
import {parsePlatformRealArgs}from'./platform-collaboration-real-acceptance.mjs';
import {realEnvironment}from'./helpers/platform-real-environment.mjs';
import {httpClient,waitUntil}from'./helpers/orchestration-acceptance.mjs';
import {ownerClient}from'./helpers/platform-real-scenarios.mjs';

const options=parsePlatformRealArgs(process.argv.slice(2));
if(!options.execute)throw new Error('EXPLICIT_EXECUTE_REQUIRED');
if(options.maxStarts!==3)throw new Error('LIVE_UI_ACCEPTANCE_REQUIRES_THREE_START_LIMIT');
await mkdir(options.outputDir,{recursive:true,mode:0o700});
const report={scope:'isolated_real_browser_supplier_tasks',status:'running',startedAt:new Date().toISOString(),APIResponsesMocked:false,maximumPlatformStarts:3,runs:[]};
const save=()=>writeFile(path.join(options.outputDir,'ui-live-result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await save();
let environment,browser,page;
try{
  environment=await realEnvironment(options);await environment.start();
  const request=httpClient(environment.baseUrl),owner=ownerClient(environment.baseUrl),room=(await request('/api/conversations/empty',{title:'R8 real browser rejection and acceptance',agentIds:['r8-api'],workspace:null,preferences:{strategy:'serial',workflow:'routine',constraints:{readonly:true}}})).conversation;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.name));const dist=path.resolve('apps/web/dist');
  await page.route(environment.baseUrl+'/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/'||u.pathname.startsWith('/assets/')){const file=u.pathname==='/'?path.join(dist,'index.html'):path.join(dist,u.pathname.slice(1));if(!file.startsWith(dist+path.sep))return route.abort();return route.fulfill({body:await readFile(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript'});}return route.continue();});
  const count=()=>environment.read('SELECT COUNT(*)n FROM orchestration_model_calls WHERE started_at IS NOT NULL')[0].n;
  const ready=async(runId,index)=>waitUntil(async()=>{const s=await owner(`/api/accounts/business/${runId}`);return s.stages[index].execution?.canAccept?s:null;},'REAL_UI_STAGE',options.timeoutMs+5000);
  const stage=(card,index)=>card.getByLabel('业务阶段验收',{exact:true}).locator('details').filter({has:page.locator('summary').filter({hasText:new RegExp(`^${index+1}\\. `)})}).first();
  const candidate=async(panel,title)=>{await panel.getByLabel(title+' 证据',{exact:true}).selectOption({index:1});await panel.getByRole('button',{name:'登记交付候选',exact:true}).click();};
  report.phase='edit_contract';await page.goto(environment.baseUrl+'/?room='+room.id);await page.getByLabel('任务目标',{exact:true}).fill('R8 read-only verification: first explain 2 + 2 = 4 with an example, then summarize the accepted result and one recovery limitation. Follow the stage gates.');
  await page.getByRole('button',{name:'执行设置',exact:true}).click();await page.getByLabel('本任务启用阶段验收').check();await page.getByLabel('阶段执行方式').selectOption('stage_gated');await page.getByLabel('启用差异化批量任务',{exact:true}).check();
  for(const [i,title,deliverable,objective,criterion]of[[1,'算术核对','算术解释','Explain 2 + 2 = 4 with one concrete addition example. At most 40 words, no ordinary tools.','给出数字 4 和具体加法依据'],[2,'恢复建议','建议结论','Summarize the accepted arithmetic result and one concrete limitation of recovery. At most 60 words, no ordinary tools.','包含已验收结论及一个具体限制']]){
    if(i===2)await page.getByRole('button',{name:'添加阶段（最多 8 个）',exact:true}).click();await page.getByLabel(`阶段 ${i} 名称`,{exact:true}).fill(title);await page.getByLabel(`阶段 ${i} 交付项 1`,{exact:true}).fill(deliverable);await page.getByLabel(`阶段 ${i} 任务 1 成员`,{exact:true}).selectOption('r8-api');await page.getByLabel(`阶段 ${i} 任务 1 内容`,{exact:true}).fill(objective);await page.getByLabel(`阶段 ${i} 验收标准`,{exact:true}).fill(criterion);
  }
  await page.getByRole('button',{name:'关闭执行设置',exact:true}).click();await page.getByRole('button',{name:'预览计划',exact:true}).click();const preview=page.getByRole('region',{name:'本轮计划',exact:true});await preview.waitFor();assert.equal(count(),0);await page.screenshot({path:path.join(options.outputDir,'desktop-live-preview.png')});
  report.phase='execute_and_reject';await preview.getByRole('button',{name:'确认并执行本任务',exact:true}).click();
  const source=await waitUntil(async()=>{const r=(await request(`/api/conversations/${room.id}`)).runs;return r[0]??null;},'UI_FIRST_RUN');report.runs.push(source.id);await save();await ready(source.id,0);
  const card=page.getByRole('region',{name:'第 1 轮任务',exact:true});await card.getByRole('button',{name:'查看计划、结果与验收',exact:true}).click();const first=stage(card,0);await candidate(first,'算术解释');await first.getByLabel('算术核对 说明',{exact:true}).fill('补充更具体的加法反例和边界，再交付修订结果。');await first.getByRole('button',{name:'拒绝候选，重新登记',exact:true}).click();
  const rework=card.getByLabel('算术核对 阶段返工',{exact:true});await rework.getByLabel('算术核对 返工要求',{exact:true}).fill('保持 2 + 2 = 4 的正确结论，补充具体例子和一个边界，不执行后续阶段。');await rework.getByRole('button',{name:'预览阶段返工',exact:true}).click();const reworkPreview=rework.getByLabel('阶段返工预览',{exact:true});await reworkPreview.waitFor();assert.equal(count(),1);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await reworkPreview.getByRole('button',{name:'确认并执行返工',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(options.outputDir,'mobile-live-rework.png')});
  await reworkPreview.getByRole('button',{name:'确认并执行返工',exact:true}).click();
  await page.getByRole('dialog',{name:'任务详情',exact:true}).getByRole('button',{name:'关闭任务详情',exact:true}).click();
  const next=await waitUntil(async()=>{const r=(await request(`/api/conversations/${room.id}`)).runs;return r.find(r=>r.id!==source.id)??null;},'UI_REWORK_RUN');report.runs.push(next.id);await save();await ready(next.id,0);
  report.phase='accept_first_and_continue';const nextCard=page.getByRole('region',{name:'第 2 轮任务',exact:true});await nextCard.getByRole('button',{name:'查看计划、结果与验收',exact:true}).click();const nextFirst=stage(nextCard,0);await candidate(nextFirst,'算术解释');await nextFirst.getByRole('checkbox',{name:'给出数字 4 和具体加法依据',exact:true}).check();await nextFirst.getByRole('button',{name:'验收通过并继续执行',exact:true}).click();
  await ready(next.id,1);const second=stage(nextCard,1);await candidate(second,'建议结论');await second.getByRole('checkbox',{name:'包含已验收结论及一个具体限制',exact:true}).check();await second.getByRole('button',{name:/^(确认验收本阶段|验收通过并继续执行)$/}).click();
  await waitUntil(async()=>{const s=await owner(`/api/accounts/business/${next.id}`);return s.outcome==='achieved'?s:null;},'UI_ACHIEVED');assert.equal(count(),3);assert.deepEqual(errors,[]);await nextCard.getByText('业务目标：目标已达成',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await page.screenshot({path:path.join(options.outputDir,'mobile-live-accepted.png')});
  report.status='passed';report.platformStarts=3;report.checks=['real browser contract edit and zero-model preview','browser starts actual API stage','rejection and rework preview cause no inference','mobile confirmation creates one successor','mobile acceptance starts only next stage','three actual API calls and achieved business outcome'];
}catch(error){report.status='failed';report.errorCode=error.code??error.name;if(page)await page.screenshot({path:path.join(options.outputDir,'ui-live-failure.png')});process.exitCode=2;}
finally{if(environment){for(const r of environment.read("SELECT id FROM runs WHERE status NOT IN ('completed','failed','cancelled')"))try{await httpClient(environment.baseUrl)(`/api/runs/${r.id}/actions`,{action:'cancel'});}catch{}await environment.stop();}if(browser)await browser.close();report.finishedAt=new Date().toISOString();await save();}
console.log(JSON.stringify(report));
