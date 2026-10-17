import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
import {completeScopedCoordination} from './helpers/scoped-coordination-fixture.mjs';
const env=await createDemoEnvironment(),checks=[],calls=[];
try{
  const db=env.database,{config}=await import('../apps/server/src/config.ts');
  const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(env.app);
  const releases=await import('../apps/server/src/collaboration/informationRelease.ts');
  const delivery=await import('../apps/server/src/collaboration/scopedDelivery.ts');
  const scheduler=await import('../apps/server/src/collaboration/scheduler.ts');
  const trace=await import('../apps/server/src/runs/trace.ts');
  const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
  const {inspectScopedCollaboration}=await import('./scoped-collaboration-maintenance.mjs');
  const waitFor=async fn=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('G6 timed out');};
  mockProvider.chat=async req=>{
    const context=req.messages.map(m=>m.content).join('\n');calls.push({model:req.model,context});
    const name=req.tools?.[0]?.name;
    const content=`G6_COORD_PRIVATE_${req.model.slice(5).toUpperCase()}：已逐项审查事实、依据、风险与限制，提交完整结论。`;
    if(!name)return {content,toolCalls:[],usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'end_turn',truncated:false};
    let args;
    if(name==='agent.consult_batch'){const {version,type,...action}=JSON.parse(context.slice(context.lastIndexOf('{"items":')));args=action;}
    else args={summary:name==='agent.request_release'?'G6_PRIVATE_DRAFT：已核对获准来源，建议采用已验证方案，完整依据保留私密。':'已按冻结计划核对事实、依据与限制并完成交付。'};
    return {content:'',toolCalls:[{name,input:JSON.stringify(args)}],usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'tool_use',truncated:false};
  };
  const source=await completeScopedCoordination();
  assert.equal(JSON.parse(db.get('SELECT payload FROM runtime_contracts WHERE run_id=?',source.run.id).payload).features.coordinationScopes,1);
  const catalog=releases.roomAggregateSources(source.run.conversationId);
  assert.equal(catalog.length,1);assert.equal(catalog[0].engine,'coordination');assert.equal(catalog[0].items.length,2);
  assert.doesNotMatch(JSON.stringify(catalog),/G6_COORD_PRIVATE/);checks.push('Owner 完成阶段门禁；统一来源目录含阶段结果且不含正文');
  const host={host:'localhost:3010'};
  for(const url of ['/api/accounts/scoped-delivery/capabilities',`/api/accounts/information-releases/rooms/${source.run.conversationId}/sources`])
    assert.equal((await env.app.inject({method:'GET',url,headers:host})).statusCode,401);
  const session=await env.app.inject({method:'POST',url:'/api/accounts/session',headers:{...host,'x-gand-bootstrap':'1'}});
  const headers={...host,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
  const response=await env.app.inject({method:'GET',url:`/api/accounts/information-releases/rooms/${source.run.conversationId}/sources`,headers});
  assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
  const support=(await env.app.inject({method:'GET',url:'/api/accounts/scoped-delivery/capabilities',headers})).json();
  for(const backend of support.backends)for(const c of backend.capabilities){assert.equal(c.implementationSupported,['builtin-llm','claude-sdk','codex-app-server'].includes(backend.backend));assert.equal(c.configuredAvailable,['builtin-llm','claude-sdk'].includes(backend.backend));assert.equal(c.connectionVerified,false);}
  checks.push('支持矩阵与来源目录需管理会话、禁止缓存；原生实现、部署准入与账户实测分离');
  const key=catalog[0].items.find(i=>i.target==='aa').key;
  async function start(){
    const p=releases.previewPrivateAggregate({sourceRunId:source.run.id,itemKeys:[key],aggregatorId:'summary',instruction:'仅汇总 A 的报告，保留完整原文私密。',maxTokens:8000},'owner');
    assert.match(p.sources[0].body,/G6_COORD_PRIVATE_AA/);
    const result=releases.confirmPrivateAggregate({previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()},'owner');
    scheduler.kickCollaboration(source.run.conversationId);await waitFor(()=>trace.getRun(result.runId).status==='waiting_for_user');
    return result.runId;
  }
  for(const mode of ['exact_content','deterministic_projection']){
    const id=await start();const aggregateCall=calls.filter(c=>c.model==='mock:summary'&&c.context.includes('G6_COORD_PRIVATE_AA')).at(-1);
    assert.ok(aggregateCall);assert.doesNotMatch(aggregateCall.context,/G6_COORD_PRIVATE_BB/);
    const preview=releases.previewInformationRelease(id,{expectedRevision:1,mode,access:{visibility:mode==='exact_content'?'private':'public',audience:mode==='exact_content'?['bb']:[]}},'owner');
    if(mode==='deterministic_projection')assert.deepEqual(JSON.parse(preview.body),{version:1,items:[{key,state:'completed'}]});
    const confirmation={previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()};
    const grant=releases.confirmInformationRelease(confirmation,'owner');
    assert.deepEqual(releases.confirmInformationRelease(confirmation,'owner'),grant);
    config.scopedCollaborationMode='closed';
    const inventory=inspectScopedCollaboration(db.db);assert.equal(inventory.drain.newAdmissionClosed,true);assert.ok(inventory.waitingHolds>0);assert.ok(inventory.readyGrants>0);
    const published=releases.publishInformationRelease(grant.grantId);assert.deepEqual(releases.publishInformationRelease(grant.grantId),published);
    const {recoverDurableHolds}=await import('../apps/server/src/runs/recovery.ts');recoverDurableHolds(id);scheduler.kickCollaboration(source.run.conversationId);
    await waitFor(()=>trace.getRun(id).status==='completed');
    assert.equal(db.get('SELECT COUNT(*) n FROM information_release_records WHERE run_id=?',id).n,1);
    config.scopedCollaborationMode='execute';
  }
  checks.push('阶段来源确切文字/固定状态均走完整发布闭环；关闭新准入仍可授权排空且仅发布一次');
  const pendingIntake=releases.previewPrivateAggregate({sourceRunId:source.run.id,itemKeys:[key],aggregatorId:'summary',instruction:'核对所选报告',maxTokens:8000},'owner');
  db.run('UPDATE runs SET deleted_at=? WHERE id=?',new Date().toISOString(),source.run.id);
  assert.ok(!releases.roomAggregateSources(source.run.conversationId).some(s=>s.runId===source.run.id));
  assert.throws(()=>releases.confirmPrivateAggregate({previewId:pendingIntake.id,fingerprint:pendingIntake.fingerprint,clientKey:randomUUID()},'owner'),/RELEASE_STALE/);
  db.run('UPDATE runs SET deleted_at=NULL WHERE id=?',source.run.id);
  checks.push('来源软删除后目录隐藏且已有读取预览失效，不以手工重试绕过');
  const draft={conversationId:source.run.conversationId,coordinatorId:'planner',goal:'灰度排空验收',join:'all',returnProfile:'status-only-v1',maxTokens:8000,items:[{key:'one',target:'aa',batch:1,expectation:'result',material:'独立审查指定材料，报告事实依据。'}]};
  const p=delivery.previewScopedDelivery(draft,'owner'),confirmation={previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()};
  config.scopedCollaborationMode='preview';const beforeCalls=calls.length;
  assert.throws(()=>delivery.confirmScopedDelivery(confirmation,'owner'),/预览/);assert.equal(calls.length,beforeCalls);
  config.scopedCollaborationMode='execute';const admitted=delivery.confirmScopedDelivery(confirmation,'owner');
  config.scopedCollaborationMode='closed';assert.equal(delivery.confirmScopedDelivery(confirmation,'owner'),admitted);
  assert.throws(()=>delivery.previewScopedDelivery(draft,'owner'),/未开放/);
  scheduler.kickCollaboration(source.run.conversationId);await waitFor(()=>trace.getRun(admitted).status==='completed');
  checks.push('仅预览不调用模型；关闭拒绝新任务但响应丢失重试仍返回原 Run，兼容 worker 完成既有任务');
  const entry=await import('../apps/server/src/orchestration/entry.ts');
  const input={...source.input,clientRequestId:randomUUID()};const next=await entry.previewExecutionOrchestration(input);
  const legacy=entry.submitExecutionOrchestration({...input,entryVersion:1,previewId:next.previewId,orchestrationFingerprint:next.fingerprint},source.run.conversationId);
  assert.equal(JSON.parse(db.get('SELECT payload FROM runtime_contracts WHERE run_id=?',legacy.run.id).payload).features.coordinationScopes,undefined);
  assert.equal(JSON.parse(db.get('SELECT payload FROM runtime_contracts WHERE run_id=?',source.run.id).payload).features.coordinationScopes,1);
  const {cancelCoordinationRun}=await import('../apps/server/src/coordination/runtime.ts');cancelCoordinationRun(legacy.run.id,'G6 fixture cleanup');
  const changes=db.get('SELECT total_changes() n').n;const inventory=inspectScopedCollaboration(db.db);assert.equal(db.get('SELECT total_changes() n').n,changes);
  assert.equal(inventory.readOnly,true);assert.equal(inventory.schema,17);assert.equal(inventory.foreignKeyErrors,0);assert.equal(inventory.databaseCheck,'ok');
  assert.equal(inventory.drain.noExecutingAttempts,true);assert.equal(inventory.drain.compatibleWorkerRequired,false);assert.doesNotMatch(JSON.stringify(inventory),/G6_PRIVATE|G6_COORD_PRIVATE/);
  checks.push('灰度开关只影响新 Scope 契约；只读排空清单无正文、无模型调用、无数据修改');
  const endpointP95Ms={};const countBeforeSampling=calls.length;
  for(const url of ['/api/accounts/scoped-delivery/capabilities',`/api/accounts/information-releases/rooms/${source.run.conversationId}/sources`]){
    const samples=[];
    for(let i=0;i<35;i++){const start=performance.now();const response=await env.app.inject({method:'GET',url,headers});assert.equal(response.statusCode,200);if(i>=5)samples.push(performance.now()-start);}
    endpointP95Ms[url.includes('/sources')?'sources':'capabilities']=Number(samples.sort((a,b)=>a-b)[Math.ceil(samples.length*.95)-1].toFixed(3));
  }
  assert.equal(calls.length,countBeforeSampling);checks.push('能力/来源接口各 5 次预热和 30 次本机采样，不增加模型调用');
  assert.equal(env.externalRequests,0);assert.equal((await env.nativeCalls()).length,0);
  console.log(JSON.stringify({passed:true,checks,modelCalls:calls.length,supplierRequests:0,schema:inventory.schema,endpointP95Ms},null,2));
}finally{await env.close();}
