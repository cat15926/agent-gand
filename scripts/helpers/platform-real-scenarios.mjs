import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AcceptanceError, httpClient, submitConfirmedTask, waitUntil } from './orchestration-acceptance.mjs';

export function ownerClient(baseUrl) {
  let session;
  return async function request(endpoint, payload, method = payload === undefined ? 'GET' : 'POST') {
    if (!session) {
      const response = await fetch(baseUrl + '/api/accounts/session', { method: 'POST', headers: { 'x-gand-bootstrap': '1' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new AcceptanceError('OWNER_SESSION_UNAVAILABLE', response.status);
      session = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-gand-csrf': (await response.json()).csrfToken };
    }
    const response = await fetch(baseUrl + endpoint, { method, headers: { ...session, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (response.status === 401) { session = null; return request(endpoint, payload, method); }
    const data = await response.json();
    if (!response.ok) throw new AcceptanceError(data.code || 'OWNER_HTTP_REJECTED', response.status);
    return data;
  };
}
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const team = ['r8-sdk', 'r8-api', 'r8-codex'];
export function realContract(stages) {
  return { version: 3, revision: 1, executionMode: 'stage_gated', stages: stages.map((s, i) => ({ id: s.id ?? `s${i + 1}`, title: s.title ?? `R8 stage ${i + 1}`,
    deliverables: [{ id: 'result', title: '实质结论', kind: 'text' }], criteria: ['结果满足冻结分工且有具体依据'], execution: s.execution,
  })) };
}
export async function runRealScenarios({ environment, options, report, save, onProgress = () => {} }) {
  const request = httpClient(environment.baseUrl), owner = ownerClient(environment.baseUrl);
  const allRuns = [...new Set(report.scenarios.flatMap(s=>s.runs.map(r=>r.runId)).filter(Boolean))], readiness = {}, began = Date.now();
  const starts = () => environment.read('SELECT COUNT(*) n FROM orchestration_model_calls WHERE started_at IS NOT NULL')[0].n;
  function cap(expected) { if (starts() + expected > options.maxStarts || Date.now() - began > options.totalTimeoutMs) throw new AcceptanceError('ACCEPTANCE_EXECUTION_LIMIT'); }
  const recordRun = async (item, ids) => { Object.assign(item, ids); if (ids.runId && !allRuns.includes(ids.runId)) allRuns.push(ids.runId); await save(); };
  async function caseRun(id, action) {
    const old=report.scenarios.find(s=>s.id===id);
    if(old&&(old.status==='passed'||!['mixed-reject-partial-rework','cold-restart-failure-continuation',...(options.retryPublicFault?['real-upstream-failure-continuation-final']:[])].includes(id)&&old.runs.length))return old;
    const item = old??{ id, runs: [], checks: [] };Object.assign(item,{status:'running',startedAt:new Date().toISOString()});delete item.errorCode;if(!old)report.scenarios.push(item); await save(); onProgress({ scenario: id, status: 'running' });
    try { await action(item); item.status = 'passed'; }
    catch (error) { item.status = error instanceof AcceptanceError && error.code.startsWith('DEPENDENCY_') ? 'not_verified' : 'failed'; item.errorCode = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_ASSERTION_FAILED'; }
    finally { item.finishedAt = new Date().toISOString(); item.elapsedMs = Date.parse(item.finishedAt) - Date.parse(item.startedAt); await save(); onProgress({ scenario: id, status: item.status, errorCode: item.errorCode }); }
    return item;
  }
  async function submit(item, contract, { ids = team, visibility = 'public', audience = [], goal = 'R8 isolated acceptance. Follow only the assigned stage objective. Do not use ordinary tools, delegate or ask questions.', readonly = true, conversationId,workspace=null } = {}) {
    const calls = contract.executionMode==='stage_gated'?contract.stages.reduce((n, s) => n + s.execution.assignments.length + (s.execution.join ? 1 : 0), 0):1; cap(calls);
    if (!conversationId) conversationId = (await request('/api/conversations/empty', { title: `R8 ${item.id}`, agentIds: ids, workspace, preferences: { strategy: 'serial', workflow: 'routine', constraints: { readonly } } })).conversation.id;
    const result = await submitConfirmedTask(request, { conversationId, agentIds: ids, recipientIds: [], strategy: 'serial', workflow: 'routine', goal, visibility, audience,...(workspace?{workspace}:{}),
      businessContract: contract, constraints: { readonly, deadlineMs: options.totalTimeoutMs, firstResponseTimeoutMs: options.timeoutMs, idleTimeoutMs: options.timeoutMs,
        costPolicy: { version: 1, currency: 'USD', mode: 'estimate', maxCost: options.maxStarts * 0.1, unknownAction: 'reserve', unknownReserve: 0.1, prices: [] } } }, async values => { item.runs.push({ ...values }); await recordRun(item.runs.at(-1), values); });
    return result;
  }
  async function stageReady(runId, id) {
    return waitUntil(async () => {
      const [detail, state] = await Promise.all([request(`/api/runs/${runId}`), owner(`/api/accounts/business/${runId}`)]);
      if (['failed', 'cancelled'].includes(detail.run.status)) {
        const failure = await request(`/api/runs/${runId}/failures`), encoded = JSON.stringify(failure);
        if (/401|auth_required|认证|authentication/i.test(encoded)) throw new AcceptanceError('SUPPLIER_AUTHENTICATION_FAILED');
        if (/403|not allowed/i.test(encoded)) throw new AcceptanceError('SUPPLIER_REQUEST_FORBIDDEN');
        if (/timeout|超时/i.test(encoded)) throw new AcceptanceError('SUPPLIER_OR_PLATFORM_TIMEOUT');
        throw new AcceptanceError('REAL_STAGE_FAILED');
      }
      return state.stages.find(s => s.stage.id === id)?.execution?.canAccept ? state : null;
    }, 'REAL_STAGE', options.timeoutMs + 30_000);
  }
  async function command(runId, body) {
    const state = await owner(`/api/accounts/business/${runId}`);
    return owner(`/api/accounts/business/${runId}`, { ...body, expectedVersion: state.version, clientRequestId: `r8-${randomUUID()}` });
  }
  async function decide(runId, stageId, verdict) {
    const refs = (await owner(`/api/accounts/business/${runId}/evidence`)).choices.filter(r => r.stageId === stageId);
    assert.ok(refs.length, 'substantive evidence required');
    const reported = await command(runId, { action: 'report', stageId, kind: 'delivery', note: 'R8 核对实际阶段交付', evidence: [{ deliverableId: 'result', ref: refs.at(-1).ref }] });
    const reportId = reported.stages.find(s => s.stage.id === stageId).report.id;
    const state = await command(runId, { action: 'decide', stageId, reportId, verdict, checkedCriteria: verdict === 'accept' ? [0] : [], reason: verdict === 'accept' ? '按实际结果核对标准通过' : 'R8 验收要求补充边界和反例' });
    return { reportId, state };
  }
  const output = runId => environment.read("SELECT step_id,output FROM coordination_step_attempts WHERE run_id=? AND status='completed' ORDER BY started_at", runId);
  async function completed(runId) { return waitUntil(async () => { const d = await request(`/api/runs/${runId}`); return d.run.status === 'completed' ? d : null; }, 'REAL_COMPLETION', 15_000); }
  function requireReady(...ids) { if (ids.some(id => !readiness[id])) throw new AcceptanceError('DEPENDENCY_BACKEND_NOT_READY'); }
  if(options.campaign==='core'){
  // Real bound tasks, rather than account tests, establish readiness once per backend.
  for (const id of team) {
    const item = await caseRun(`backend-${id}`, async item => {
      const created = await submit(item, realContract([{ execution: { assignments: [{ agentId: id, objective: 'Compute 2 + 2, give the answer 4 and one mathematical explanation. At most 40 words, no ordinary tools. This is the entire deliverable.' }], concurrency: 1 } }]), { ids: [id] });
      await stageReady(created.run.id, 's1'); assert.match(output(created.run.id).map(o => o.output).join('\n'), /4/);
      const executions = await request(`/api/runs/${created.run.id}/executions`);
      if (id !== 'r8-api') assert.ok(executions.some(e => e.status === 'completed' && e.executionBinding?.runId === created.run.id && e.permissionMode === 'readonly'));
      await decide(created.run.id, 's1', 'accept'); await completed(created.run.id);
      item.checks.push('real_substantive_output', 'frozen_run_binding', 'owner_gate');
    }); readiness[id] = item.status === 'passed';
  }
  await caseRun('mixed-reject-partial-rework', async item => {
    requireReady(...team);
    const created = item.runs[0]?.runId?{run:{id:item.runs[0].runId}}:await submit(item, realContract([
      { execution: { concurrency: 2, assignments: [{ agentId: 'r8-sdk', objective: 'Explain why idempotent submission prevents duplicated execution. Include an example, at most 60 words.', dependsOn: [] }, { agentId: 'r8-api', objective: 'Explain why accepted immutable results should be retained after a branch fails. Include an example, at most 60 words.', dependsOn: [] }], join: { agentId: 'r8-codex', objective: 'Combine only the two supplied results into two invariants and one limitation. At most 100 words.', sourceAgentIds: ['r8-sdk', 'r8-api'] } } },
      { execution: { assignments: [{ agentId: 'r8-api', objective: 'Check the accepted invariants and list a concrete recovery acceptance checklist in 3 items, at most 100 words.', dependsOn: [] }] } },
    ]));
    if(!options.resume)await stageReady(created.run.id, 's1');
    const sourceA = output(created.run.id).find(o => o.step_id === 'stage-1-work-2'); assert.ok(sourceA);
    const existingState=await owner(`/api/accounts/business/${created.run.id}`),existingStage=existingState.stages.find(s=>s.stage.id==='s1');
    const rejected = existingStage.status==='rejected'?{reportId:existingStage.report.id,state:existingState}:await decide(created.run.id, 's1', 'reject'); cap(3);
    const body = { stageId: 's1', reportId: rejected.reportId, expectedVersion: rejected.state.version, instruction: '补充一个具体失败反例和防止重复调用的边界，再重新汇合。', selectedAgentIds: ['r8-sdk'] };
    const preview = await owner(`/api/accounts/business/${created.run.id}/rework-preview`, body);
    assert.deepEqual(preview.checkpoint.impact.redo.filter(i=>i.stageId==='s1').map(i => i.agentId).sort(), ['r8-codex', 'r8-sdk']);
    const confirm = { ...body, previewId: preview.preview.previewId, orchestrationFingerprint: preview.preview.fingerprint };
    const next = await owner(`/api/accounts/business/${created.run.id}/reworks`, confirm); item.runs.push({ runId: next.run.id }); await recordRun(item.runs.at(-1), { runId: next.run.id });
    assert.equal((await owner(`/api/accounts/business/${created.run.id}/reworks`, confirm)).run.id, next.run.id);
    await stageReady(next.run.id, 's1'); assert.equal(output(next.run.id).filter(o => o.step_id.startsWith('stage-1')).length, 2);
    const kept = environment.read('SELECT manifest FROM orchestration_run_continuations WHERE target_run_id=?', next.run.id)[0]; assert.ok(kept);
    await decide(next.run.id, 's1', 'accept'); await stageReady(next.run.id, 's2'); await decide(next.run.id, 's2', 'accept'); await completed(next.run.id);
    item.checks.push('real_mixed_parallel_join', 'rejected_output_reworked', 'unaffected_api_branch_not_replayed', 'single_successor', 'next_stage_after_owner_acceptance');
  });
  await caseRun('private-scopes-and-public-followup', async item => {
    requireReady('r8-sdk', 'r8-api');
    const sdkSecret = `R8SDK_${randomUUID().replaceAll('-', '')}`, apiSecret = `R8API_${randomUUID().replaceAll('-', '')}`;
    const created = await submit(item, realContract([{ execution: { concurrency: 2, assignments: [
      { agentId: 'r8-sdk', objective: `Private task: quote ${sdkSecret} exactly once and explain that it belongs only to this assignment. At most 40 words.`, dependsOn: [], visibility: 'private', audience: ['r8-sdk'] },
      { agentId: 'r8-api', objective: `Private task: quote ${apiSecret} exactly once and explain that it belongs only to this assignment. At most 40 words.`, dependsOn: [], visibility: 'private', audience: ['r8-api'] },
    ] } }]), { ids: ['r8-sdk', 'r8-api'] });
    await stageReady(created.run.id, 's1'); const rows = output(created.run.id); assert.match(rows.find(r => r.step_id === 'stage-1-work-1').output, new RegExp(sdkSecret)); assert.doesNotMatch(rows.find(r => r.step_id === 'stage-1-work-1').output, new RegExp(apiSecret));
    assert.match(rows.find(r => r.step_id === 'stage-1-work-2').output, new RegExp(apiSecret)); assert.doesNotMatch(rows.find(r => r.step_id === 'stage-1-work-2').output, new RegExp(sdkSecret));
    const scoped = environment.read("SELECT from_agent,visibility,audience,body FROM messages WHERE run_id=? AND kind='agent'", created.run.id);
    assert.ok(scoped.every(m => m.visibility === 'private')); await decide(created.run.id, 's1', 'accept'); await completed(created.run.id);
    const publicRun = await submit(item, realContract([{ execution: { assignments: [{ agentId: 'r8-sdk', objective: 'This is a new public assignment. Explain 3 + 3 = 6 in one sentence. Do not quote unrelated private identifiers.', dependsOn: [] }] } }]), { ids: ['r8-sdk', 'r8-api'], conversationId: created.conversation.id });
    await stageReady(publicRun.run.id, 's1'); const publicOutput = output(publicRun.run.id).map(r => r.output).join('\n'); assert.doesNotMatch(publicOutput, new RegExp(`${sdkSecret}|${apiSecret}`));
    const native = await request(`/api/runs/${publicRun.run.id}/executions`); assert.ok(native.every(e => e.sessionMode === 'cold'));
    await decide(publicRun.run.id, 's1', 'accept'); await completed(publicRun.run.id);
    item.canaries = { sdkHash: digest(sdkSecret), apiHash: digest(apiSecret) }; item.checks.push('private_outputs_scoped', 'independent_private_assignments', 'public_followup_cold_session', 'no_private_canary_in_public_output');
  });
  await caseRun('cold-restart-failure-continuation', async item => {
    requireReady('r8-sdk', 'r8-api');
    const created = item.runs[0]?.runId?{run:{id:item.runs[0].runId}}:await submit(item, realContract([
      { execution: { assignments: [{ agentId: 'r8-sdk', objective: 'Explain 7 + 8 = 15 in one sentence. At most 40 words.', dependsOn: [] }] } },
      { execution: { assignments: [{ agentId: 'r8-api', objective: 'Give a concrete argument for immutable recovery checkpoints and one failure counterexample, at most 100 words.', dependsOn: [] }] } },
    ]), { ids: ['r8-sdk', 'r8-api'] });
    if(!options.resume){await stageReady(created.run.id, 's1'); const before = starts();
    await environment.stop(); await environment.start(); assert.equal(starts(), before, 'restart at gate must not infer');
    await decide(created.run.id, 's1', 'accept');
    await waitUntil(() => starts() > before, 'SECOND_STAGE_STARTED', 15_000);
    await environment.stop('SIGKILL'); await environment.start();
    const afterCrash = starts(); await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(starts(), afterCrash, 'cold host must not replay unknown calls');}
    const current=await request(`/api/runs/${created.run.id}`);if(!['completed','failed','cancelled'].includes(current.run.status))await request(`/api/runs/${created.run.id}/actions`,{action:'cancel'});
    await assert.rejects(()=>owner(`/api/accounts/business/${created.run.id}/continuation-preview`,{}),e=>e.code==='USER_CANCELLED');
    item.checks.push('real_server_restart_at_owner_gate','SIGKILL_during_real_API_request','unknown_call_not_auto_replayed','user_cancelled_run_not_implicitly_continued');
  });
  await caseRun('private-controlled-file',async item=>{
    requireReady('r8-sdk','r8-api');
    const canary=`R8FILE_${randomUUID().replaceAll('-','')}`,content=`${canary}\nControlled file acceptance: immutable scoped bytes.\n`;
    const created=await submit(item,realContract([{execution:{assignments:[{agentId:'r8-writer',objective:`Use only the platform fs.write tool to write reports/r8-private.txt with these exact UTF-8 bytes: ${JSON.stringify(content)}. Do not use native Write, shell or network. Then report the path and the actual write result.`,dependsOn:[]},{agentId:'r8-reader',objective:'Use platform fs.read to read reports/r8-private.txt and quote the first line exactly. Report the actual read result; do not guess missing bytes.',dependsOn:['r8-writer']}],concurrency:1}}]),{ids:['r8-writer','r8-reader'],visibility:'private',audience:['r8-writer','r8-reader'],readonly:false,goal:'R8 private controlled file verification. Only the two frozen file assignments are authorized. No ordinary native filesystem or network tools.'});
    await stageReady(created.run.id,'s1');
    const files=(await owner(`/api/accounts/artifacts/rooms/${created.conversation.id}`)).files.filter(f=>f.runId===created.run.id&&f.path==='reports/r8-private.txt');assert.equal(files.length,1);assert.equal(files[0].visibility,'private');
    const read=await owner(`/api/accounts/artifacts/${files[0].id}/content`);assert.equal(Buffer.from(read.contentBase64,'base64').toString(),content);
    const tools=await request(`/api/runs/${created.run.id}/tool-executions`);assert.equal(tools.filter(t=>t.toolName==='fs.write'&&t.status==='completed').length,1);assert.ok(tools.some(t=>t.toolName==='fs.read'&&t.status==='completed'));
    assert.match(output(created.run.id).find(o=>o.step_id==='stage-1-work-2').output,new RegExp(canary));
    await decide(created.run.id,'s1','accept');await completed(created.run.id);item.file={id:files[0].id,sha256:digest(content)};item.checks.push('actual_SDK_scoped_write','actual_API_scoped_read','encrypted_private_artifact','one_completed_write_ledger');
  });
  await caseRun('owner-outcome-separation',async item=>{
    requireReady('r8-api');
    const contract={version:1,stages:[{id:'s1',title:'已交付分析',criteria:['解释 2 + 2 = 4'],deliverables:[{id:'result',title:'算术解释',kind:'text'}]},{id:'s2',title:'尚未交付文件',criteria:['有实际文件'],deliverables:[{id:'file',title:'文件',kind:'file'}]}]};
    for(const outcome of ['partial_accepted','user_ended']){
      const created=await submit(item,contract,{ids:['r8-api'],goal:'Only explain 2 + 2 = 4 in one sentence. This is the current read-only deliverable; do not create any files or claim the later file stage has been delivered.'});await completed(created.run.id);
      if(outcome==='partial_accepted'){
        const refs=(await owner(`/api/accounts/business/${created.run.id}/evidence`)).choices;assert.ok(refs.length);
        const state=await command(created.run.id,{action:'report',stageId:'s1',kind:'delivery',note:'核对实际算术输出',evidence:[{deliverableId:'result',ref:refs.at(-1).ref}]});
        await command(created.run.id,{action:'decide',stageId:'s1',reportId:state.stages[0].report.id,verdict:'accept',checkedCriteria:[0],reason:'算术正确，后续文件仍未交付'});
      }
      const state=await command(created.run.id,{action:'resolve',outcome,reason:'R8 仅验收当前范围并记录结束原因'});assert.equal(state.outcome,outcome);assert.notEqual(state.outcome,'achieved');assert.equal((await request(`/api/runs/${created.run.id}`)).run.status,'completed');
    }
    item.checks.push('execution_completion_distinct_from_goal_achievement','partial_acceptance_preserves_missing_stage','user_ended_has_separate_business_outcome');
  });
  await caseRun('HTTP-response-loss-and-WS-reconnect',async item=>{
    requireReady('r8-api');cap(1);
    const socket=new WebSocket(environment.baseUrl.replace('http:','ws:')+'/ws'),events=[];socket.addEventListener('message',e=>{try{events.push(JSON.parse(String(e.data)));}catch{}});
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    try{
      const contract=realContract([{execution:{assignments:[{agentId:'r8-api',objective:'Explain 10 - 4 = 6 in one sentence with a concrete subtraction example.',dependsOn:[]}]}}]);
      const room=(await request('/api/conversations/empty',{title:'R8 lost HTTP response',agentIds:['r8-api'],workspace:null,preferences:{strategy:'serial',workflow:'routine',constraints:{readonly:true}}})).conversation;
      const input={conversationId:room.id,agentIds:['r8-api'],recipientIds:[],goal:'R8 read-only subtraction verification',workflow:'routine',strategy:'serial',constraints:{readonly:true,deadlineMs:options.timeoutMs},businessContract:contract};
      const preview=await request('/api/orchestration/preview',input);assert.equal(preview.decision.issues.filter(i=>i.severity==='error').length,0);
      const body={...input,entryVersion:1,clientRequestId:`r8-${randomUUID()}`,previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint},before=starts();
      await new Promise((resolve,reject)=>{const r=http.request(environment.baseUrl+`/api/conversations/${room.id}/requests`,{method:'POST',headers:{'content-type':'application/json'}},response=>{response.destroy();r.destroy();resolve();});r.once('error',e=>e.code==='ECONNRESET'?resolve():reject(e));r.end(JSON.stringify(body));});
      const recovered=await request(`/api/conversations/${room.id}/requests`,body);item.runs.push({runId:recovered.run.id,conversationId:room.id,clientRequestId:body.clientRequestId});await recordRun(item.runs.at(-1),item.runs.at(-1));
      await stageReady(recovered.run.id,'s1');await decide(recovered.run.id,'s1','accept');await completed(recovered.run.id);assert.equal(starts()-before,1);
      await waitUntil(()=>events.some(e=>e.type==='run.updated'&&e.run?.id===recovered.run.id&&e.run.status==='completed'),'REAL_WS_TERMINAL',5000);
      socket.close();const reconnected=new WebSocket(environment.baseUrl.replace('http:','ws:')+'/ws');await new Promise((resolve,reject)=>{reconnected.addEventListener('open',resolve,{once:true});reconnected.addEventListener('error',reject,{once:true});});reconnected.close();assert.equal((await request(`/api/runs/${recovered.run.id}`)).run.status,'completed');
      item.checks.push('committed_HTTP_response_destroyed','exact_confirmation_retry_same_run','one_actual_model_call','real_WS_terminal_and_reconnect');
    }finally{socket.close();}
  });
  if(!report.scenarios.some(s=>s.id==='mixed-reject-partial-rework'&&s.status==='passed'))await caseRun('mixed-partial-rework-final',async item=>{
    requireReady(...team);
    const created=await submit(item,realContract([{execution:{concurrency:2,assignments:[{agentId:'r8-sdk',objective:'Explain one concrete idempotency invariant and an example, at most 60 words.',dependsOn:[]},{agentId:'r8-api',objective:'Explain one immutable evidence invariant and an example, at most 60 words.',dependsOn:[]}]}},{execution:{assignments:[{agentId:'r8-codex',objective:'Combine the accepted idempotency and evidence results into three recovery checks and one limitation, at most 100 words.',dependsOn:[]}]}}]));
    await stageReady(created.run.id,'s1');const rejected=await decide(created.run.id,'s1','reject');cap(2);
    const input={stageId:'s1',reportId:rejected.reportId,expectedVersion:rejected.state.version,instruction:'为幂等性补一个反例；保留独立证据分析，随后交由 Codex 汇总。',selectedAgentIds:['r8-sdk']},p=await owner(`/api/accounts/business/${created.run.id}/rework-preview`,input);
    assert.deepEqual(p.checkpoint.impact.redo.filter(t=>t.stageId==='s1').map(t=>t.agentId),['r8-sdk']);
    const body={...input,previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint},next=await owner(`/api/accounts/business/${created.run.id}/reworks`,body);item.runs.push({runId:next.run.id});await recordRun(item.runs.at(-1),{runId:next.run.id});
    assert.equal((await owner(`/api/accounts/business/${created.run.id}/reworks`,body)).run.id,next.run.id);
    await stageReady(next.run.id,'s1');assert.equal(output(next.run.id).filter(o=>o.step_id.startsWith('stage-1')).length,1);await decide(next.run.id,'s1','accept');await stageReady(next.run.id,'s2');await decide(next.run.id,'s2','accept');await completed(next.run.id);
    item.checks.push('real_SDK_API_parallel','owner_rejection_and_selected_rework','confirmed_API_branch_not_replayed','Codex_after_accepted_inputs','single_successor');
    const historical=report.scenarios.find(s=>s.id==='mixed-reject-partial-rework');if(historical?.status==='failed'){historical.previousErrorCode=historical.errorCode;historical.status='superseded';historical.supersededBy=item.id;}
  });
  }else {readiness['r8-sdk']=true;readiness['r8-api']=true;report.readinessSource='source campaign configurations; each scenario must execute actual bound calls';}
  if(options.campaign!=='codex-write')await caseRun('real-upstream-failure-continuation-final',async item=>{
    requireReady('r8-sdk','r8-api');
    const created=await submit(item,realContract([{execution:{assignments:[{agentId:'r8-sdk',objective:'Explain 9 + 6 = 15 in one sentence. At most 40 words.',dependsOn:[]}]}},{execution:{assignments:[{agentId:'r8-api',objective:'Explain how an immutable accepted result prevents duplicated recovery work and give one concrete check, at most 80 words.',dependsOn:[]}]}}]),{ids:['r8-sdk','r8-api']});
    await stageReady(created.run.id,'s1');const before=starts();await environment.stop();await environment.start();assert.equal(starts(),before);
    await writeFile(path.join(environment.root,'upstream-fault.json'),JSON.stringify({agentId:'r8-api'}),{mode:0o600});await decide(created.run.id,'s1','accept');
    await waitUntil(async()=>{const d=await request(`/api/runs/${created.run.id}`);return d.run.status==='failed'?d:null;},'CONTROLLED_UPSTREAM_FAILURE',options.timeoutMs+5000);
    const fault=JSON.parse(await readFile(path.join(environment.root,'upstream-fault-result.json'),'utf8'));assert.equal(fault.runId,created.run.id);assert.equal(fault.receivedUpstreamHeaders,true);item.fault=fault;
    await environment.stop();await environment.start();assert.equal(starts(),before+1);cap(1);
    const p=await owner(`/api/accounts/business/${created.run.id}/continuation-preview`,{});assert.ok(p.checkpoint.business.acceptedStages.some(s=>s.id==='s1'));
    const body={previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint},next=await owner(`/api/accounts/business/${created.run.id}/continuations`,body);item.runs.push({runId:next.run.id});await recordRun(item.runs.at(-1),{runId:next.run.id});assert.equal((await owner(`/api/accounts/business/${created.run.id}/continuations`,body)).run.id,next.run.id);
    await stageReady(next.run.id,'s2');assert.ok(output(next.run.id).every(o=>o.step_id!=='stage-1-work-1'));await decide(next.run.id,'s2','accept');await completed(next.run.id);
    item.checks.push('actual_upstream_response_lost','cold_restart_at_gate_and_after_failure','no_automatic_unknown_replay','accepted_SDK_result_inherited','Owner_confirmed_single_continuation');
    const historical=report.scenarios.find(s=>s.id==='cold-restart-failure-continuation');if(historical?.status==='failed'){historical.previousErrorCode=historical.errorCode;historical.status='superseded';historical.supersededBy=item.id;}
  });
  if(['recovery','codex-write'].includes(options.campaign))await caseRun(options.campaign==='codex-write'?'codex-private-write-response-loss-recovery':'private-write-response-loss-recovery',async item=>{
    requireReady('r8-sdk','r8-api');const writer=options.campaign==='codex-write'?'r8-codex-writer':'r8-writer',content=`R8RECOVERY_${randomUUID().replaceAll('-','')}\nVerified private bytes; never repeat the completed write.\n`,filePath='reports/r8-recovery.txt';
    await writeFile(path.join(environment.root,'upstream-fault.json'),JSON.stringify({agentId:writer,afterFile:filePath,type:'native_after_write'}),{mode:0o600});
    const created=await submit(item,realContract([{execution:{assignments:[{agentId:writer,objective:`Call platform fs.write exactly once to create ${filePath} with exact UTF-8 bytes ${JSON.stringify(content)}. No native file or shell tools. Then give the path and actual write confirmation.`,dependsOn:[]},{agentId:'r8-reader',objective:`Read ${filePath} using platform fs.read and quote the first line exactly. Do not write anything or guess.`,dependsOn:[writer]}]}}]),{ids:[writer,'r8-reader'],visibility:'private',audience:[writer,'r8-reader'],readonly:false,workspace:environment.prepared.workspace,goal:'R8 controlled private write and subsequent readonly verification. Native filesystem, shell and network tools are prohibited.'});
    await waitUntil(async()=>{const d=await request(`/api/runs/${created.run.id}`);return d.run.status==='failed'?d:null;},'PRIVATE_WRITE_RESPONSE_LOSS',options.timeoutMs+15000);
    const fault=JSON.parse(await readFile(path.join(environment.root,'upstream-fault-result.json'),'utf8'));assert.equal(fault.runId,created.run.id);assert.equal(fault.afterFile,filePath);assert.equal(fault.kind,'native_process_group_terminated_after_write');
    const files=(await owner(`/api/accounts/artifacts/rooms/${created.conversation.id}`)).files.filter(f=>f.runId===created.run.id&&f.path===filePath);assert.equal(files.length,1);assert.equal(files[0].visibility,'private');
    const bytes=await owner(`/api/accounts/artifacts/${files[0].id}/content`);assert.equal(Buffer.from(bytes.contentBase64,'base64').toString(),content);
    const inspection=await owner(`/api/accounts/business/${created.run.id}/recovery-inspection`,{});assert.equal(inspection.requiresReview,true);
    await assert.rejects(()=>owner(`/api/accounts/business/${created.run.id}/continuation-preview`,{}),e=>e.code==='WRITE_RECONCILIATION_REQUIRED');
    const steps=inspection.steps.filter(s=>s.state==='unknown').map(s=>({stepId:s.stepId,verdict:'completed',reason:'Owner 核对实际加密文件版本、字节与唯一完成的 fs.write 账本。',output:`Owner 已核对 ${filePath} 内容哈希 ${digest(content)}。文件已经完整写入；仅让后续成员只读核对，禁止重复写入。`}));assert.ok(steps.length);
    await owner(`/api/accounts/business/${created.run.id}/recovery-reviews`,{fingerprint:inspection.fingerprint,clientRequestId:`r8-${randomUUID()}`,reason:'核对一次受控写入和原生进程收敛，后继只执行读取。',externalEffectsChecked:true,steps});cap(2);
    const p=await owner(`/api/accounts/business/${created.run.id}/continuation-preview`,{}),body={previewId:p.preview.previewId,orchestrationFingerprint:p.preview.fingerprint};
    const next=await owner(`/api/accounts/business/${created.run.id}/continuations`,body);item.runs.push({runId:next.run.id});await recordRun(item.runs.at(-1),{runId:next.run.id});assert.equal((await owner(`/api/accounts/business/${created.run.id}/continuations`,body)).run.id,next.run.id);
    await stageReady(next.run.id,'s1');const tools=await request(`/api/runs/${next.run.id}/tool-executions`);assert.equal(tools.filter(t=>t.toolName==='fs.write').length,0);assert.ok(tools.some(t=>t.toolName==='fs.read'&&t.status==='completed'));
    const newFiles=(await owner(`/api/accounts/artifacts/rooms/${created.conversation.id}`)).files.filter(f=>f.runId===next.run.id&&f.path===filePath);assert.equal(newFiles.length,1);assert.equal(Buffer.from((await owner(`/api/accounts/artifacts/${newFiles[0].id}/content`)).contentBase64,'base64').toString(),content);
    await decide(next.run.id,'s1','accept');await completed(next.run.id);item.fileHash=digest(content);item.checks.push('real_SDK_write_then_native_response_lost','owned_process_group_quiesced','encrypted_bytes_verified_by_Owner','automatic_replay_refused','unknown_writer_reconciled_once','new_isolated_run_reads_preserved_bytes','zero_repeated_write');
  });
  // Always inspect actual outcomes and budget records, including failed tasks.
  report.runs=[];
  for (const runId of allRuns) {
    const callRows = environment.read('SELECT backend,status,queued_at,started_at,finished_at FROM orchestration_model_calls WHERE run_id=?', runId);
    const [detail, schedule, fees] = await Promise.all([request(`/api/runs/${runId}`), owner(`/api/accounts/business/${runId}/scheduling`), owner(`/api/accounts/business/${runId}/cost-budget`)]);
    report.runs.push({ runId, status: detail.run.status, terminalDisposition: detail.run.terminalDisposition ?? null, scheduling: schedule,
      calls: callRows, costBudget: fees.budget, outputDigests: output(runId).map(o => ({ stepId: o.step_id, sha256: digest(o.output), characters: o.output.length })) });
    if (!['completed', 'failed', 'cancelled'].includes(detail.run.status)) { await request(`/api/runs/${runId}/actions`, { action: 'cancel' }); }
  }
  report.readiness = readiness; report.platformStarts = starts();
  report.status = report.scenarios.every(s => ['passed','superseded'].includes(s.status)) ? 'passed' : report.scenarios.some(s => s.status === 'failed') ? 'failed' : 'incomplete';
  report.notVerified = ['supplier_invoice_accuracy', 'native_supplier_internal_request_count',...(report.scenarios.some(s=>s.id==='private-write-response-loss-recovery'&&s.status==='passed')?[]:['private_unknown_write_recovery']), 'desktop_mobile_real_task_interaction'];
  return report;
}
