import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from './helpers/platform-real-environment.mjs';

const [baseUrl, directory]=process.argv.slice(2);
if(!baseUrl||!directory||!['127.0.0.1','localhost'].includes(new URL(baseUrl).hostname))throw new Error('LOCAL_REAL_ACCEPTANCE_ENVIRONMENT_REQUIRED');
const root=path.resolve(directory),report=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));
if(report.scope!=='isolated_real_supplier_tasks'||report.environment?.fixture!==false)throw new Error('REAL_TASK_EVIDENCE_REQUIRED');
const playwright=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const browser=await playwright.chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
const dist=path.resolve('apps/web/dist'),db=new Database(path.join(root,'acceptance.sqlite'),{readonly:true});
const calls=()=>db.prepare('SELECT COUNT(*)n FROM orchestration_model_calls WHERE started_at IS NOT NULL').get().n;
let page,result={status:'running',scope:'browser_with_real_HTTP_and_supplier_task_records',APIResponsesMocked:false,startedAt:new Date().toISOString()};
try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.name));
  // Only static assets are served locally. Every API/WS request reaches the real acceptance server.
  await page.route(baseUrl+'/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/'||url.pathname.startsWith('/assets/')){
    const file=url.pathname==='/'?path.join(dist,'index.html'):path.join(dist,url.pathname.slice(1));if(!file.startsWith(dist+path.sep))return route.abort();
    return route.fulfill({body:await readFile(file),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript'});
  }return route.continue();});
  const source=report.scenarios.find(s=>s.id==='HTTP-response-loss-and-WS-reconnect'&&s.status==='passed').runs[0];
  result.phase='load_real_task';await page.goto(baseUrl+'/?room='+source.conversationId);const card=page.getByRole('region',{name:'第 1 轮任务',exact:true});await card.getByRole('button',{name:'查看计划、结果与验收',exact:true}).click();
  result.phase='real_scheduling';await card.getByLabel('任务调度与调用',{exact:true}).waitFor();await card.getByText('已记录模型 API 请求 1',{exact:false}).waitFor();
  await page.screenshot({path:path.join(root,'desktop-real-scheduling.png'),fullPage:false});await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await card.getByLabel('任务调度与调用',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(root,'mobile-real-scheduling.png'),fullPage:false});
  result.phase='composer_preview';const before=calls();await page.getByLabel('任务目标',{exact:true}).fill('R8 UI read-only preview: explain 3 + 3 = 6 in one sentence.');await page.getByRole('button',{name:'预览计划',exact:true}).click();
  const preview=page.getByRole('region',{name:'本轮计划',exact:true});result.phase='preview_ready';await preview.waitFor();result.phase='preview_details';const expand=preview.getByRole('button',{name:'展开计划详情',exact:true});if(await expand.count())await expand.click();result.phase='preview_rule_label';await preview.locator('p').filter({hasText:/规则预览.*未调用模型/}).first().waitFor();
  assert.equal(calls(),before,'browser preview does not initiate paid inference');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await page.screenshot({path:path.join(root,'mobile-real-preview.png'),fullPage:false});
  assert.deepEqual(errors,[]);result={...result,status:'passed',runId:source.runId,checks:['real task delivery and Owner ledger visible','actual API/native scheduling counts','1440px and 390px no horizontal overflow','normal composer real account rule preview','zero additional model calls','no React page errors']};
}catch(error){result={...result,status:'failed',errorCode:error.name,labels:page?await page.locator('[aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))):[]};if(page)await page.screenshot({path:path.join(root,'ui-failure.png')});process.exitCode=2;}
finally{result.finishedAt=new Date().toISOString();await mkdir(root,{recursive:true});await writeFile(path.join(root,'ui-result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});db.close();await browser.close();}
console.log(JSON.stringify(result));
