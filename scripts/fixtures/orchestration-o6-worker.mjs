import { appendFileSync } from 'node:fs';
globalThis.fetch = async () => { throw new Error('O6 fixture prohibits provider traffic'); };
const database = await import('../../apps/server/src/db/database.ts');
const { migrateRoomPreferences } = await import('../../apps/server/src/db/orchestrationMigrations.ts');
const trace = await import('../../apps/server/src/runs/trace.ts');
const host = await import('../../apps/server/src/execution/host.ts');
const { mockProvider } = await import('../../apps/server/src/llm/provider.ts');
const target = process.env.O6_RUN_ID;
const mode = process.env.O6_WORKER_MODE;
process.on('message',async message => {
  if (message?.action === 'approve') {
    (await import('../../apps/server/src/hitl/approvals.ts')).decide(message.id,{decision:'approve',by:'O6 fixture'});
    (await import('../../apps/server/src/runs/recovery.ts')).recoverDurableHolds(target);
  }
});
if (process.env.O6_HOLD_PROCESS === '1' || process.env.O6_HANG_CALL === '1' || process.env.O6_HANG_WRITE === '1') setInterval(() => {},1000);
const record = data => appendFileSync(process.env.O6_LOG,JSON.stringify({...data,pid:process.pid,time:Date.now()})+'\n');
if (process.env.O6_KILL_AFTER_RESULT === '1') {
  const originalExec=database.db.exec.bind(database.db);
  database.db.exec=sql=>{const value=originalExec(sql);
    if(sql==='COMMIT'&&database.get("SELECT id FROM run_checkpoints WHERE run_id=? AND kind='agent_turn' AND phase='completed'",target))process.kill(process.pid,'SIGKILL');
    return value;};
}
if(process.env.O6_HANG_WRITE==='1') {
  const {getTool}=await import('../../apps/server/src/tools/builtin/index.ts');const tool=getTool('fs.write');const original=tool.run;
  tool.run=async(...args)=>{const value=await original(...args);record({event:'write',runId:target});await new Promise(()=>{});return value;};
}
mockProvider.chat = async req => {
  const text = req.messages.map(m => m.content).join('\n');
  record({event:'call',runId:target,model:req.model});
  if (process.env.O6_HANG_CALL === '1') await new Promise(() => {});
  const tool = process.env.O6_APPROVAL === '1' && !req.messages.some(m => m.role === 'tool' || m.content.includes('【工具结果】fs.write'));
  const content = req.model === 'mock:reviewer' ? JSON.stringify({verdict:'PASS',summary:'基于当前固定结果评审通过',issues:[]}) : '完整的 O6 fixture 交付结果，提供已验证的分析结论。';
  return {content:tool?'':content,toolCalls:tool?[{name:'fs.write',input:JSON.stringify({path:'o6-approval.txt',content:'O6 approved write fixture\n'})}]:[],stopReason:tool?'tool_use':'end_turn',usage:{tokensIn:1,tokensOut:2,costUsd:0}};
};
const waitFor = async (fn,timeout=20000) => { const end=Date.now()+timeout; while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw new Error('O6 worker timed out'); };
try {
  if (mode === 'boot') {
    const {backfillConversations} = await import('../../apps/server/src/conversations/service.ts'); backfillConversations();
    console.log(JSON.stringify({migration:migrateRoomPreferences(database.db)}));
  } else if (mode === 'api') {
    const {default:Fastify} = await import('../../apps/server/node_modules/fastify/fastify.js');
    const {registerRoutes} = await import('../../apps/server/src/api/routes.ts');
    const app=Fastify();await registerRoutes(app);
    const input=JSON.parse(process.env.O6_API_REQUEST); const response=await app.inject(input);
    console.log(JSON.stringify({status:response.statusCode,data:response.json(),headers:response.headers}));
    await app.close();
  } else {
    host.claimRuntimeHost();
    const recovery=await import('../../apps/server/src/runs/recovery.ts');
    setInterval(()=>recovery.recoverDurableHolds(),1000).unref();
    const {enqueueConversationRun,recoverPendingConversationRuns} = await import('../../apps/server/src/conversations/dispatcher.ts');
    if (mode === 'recover' || mode === 'resume') {
      await (await import('../../apps/server/src/execution/recovery.ts')).recoverExternalExecutions();
      (await import('../../apps/server/src/execution/memberAdmission.ts')).recoverMemberAdmissions();
      (await import('../../apps/server/src/tasks/attempts.ts')).interruptRunningAttempts();
      (await import('../../apps/server/src/runtime/taskAdapter.ts')).reopenInterruptedTaskResponsibilities();
      (await import('../../apps/server/src/collaboration/store.ts')).interruptExpiredAttempts({onlyExpired:true});
      (await import('../../apps/server/src/messaging/tasks.ts')).recoverInterruptedTasks();
      (await import('../../apps/server/src/coordination/store.ts')).recoverInterruptedCoordinationSteps();
      if (mode === 'resume') await (await import('../../apps/server/src/orchestration/actions.ts')).applyRunAction(target,'resume');
      recoverPendingConversationRuns();
      (await import('../../apps/server/src/runs/recovery.ts')).recoverDurableHolds();
      (await import('../../apps/server/src/collaboration/scheduler.ts')).recoverCollaborationRuns();
      (await import('../../apps/server/src/runs/recovery.ts')).recoverDurableRuns();
    } else enqueueConversationRun(target);
    record({event:'ready',runId:target});
    if (process.env.O6_HOLD_PROCESS === '1') await new Promise(() => {});
    else {
      const expected = (process.env.O6_EXPECT_STATUS ?? 'completed').split(',');
      const result = await waitFor(() => {const item=trace.getRun(target);return expected.includes(item?.status)?item:null;});
      // A second boot cannot find anything to re-dispatch after completion.
      await new Promise(r=>setTimeout(r,150));
      console.log(JSON.stringify({runId:target,status:result.status}));
    }
    host.releaseRuntimeHost();
  }
} catch(error) { console.error(error.message); process.exitCode=1; }
database.closeDatabase();
process.exit(process.exitCode ?? 0);
