import { writeFileSync, existsSync } from 'node:fs';
import * as f from './scoped-recovery-fixture.mjs';
const [mode,roomId,runId,argument]=process.argv.slice(2);
const crash=()=>process.kill(process.pid,'SIGKILL');
if(process.env.G4_BARRIER){writeFileSync(process.env.G4_BARRIER+'.'+process.pid,'ready');while(!existsSync(process.env.G4_BARRIER))await new Promise(r=>setTimeout(r,5));}
// Injection exists only in this isolated worker; production code has no crash hooks.
const prepare=f.db.db.prepare.bind(f.db.db);let envelopes=0;
f.db.db.prepare=sql=>{
  const stmt=prepare(sql),execute=stmt.run.bind(stmt);
  stmt.run=(...args)=>{
    if(mode==='reserved'&&sql.startsWith("UPDATE orchestration_model_calls SET status='started'"))crash();
    const result=execute(...args);
    if(mode==='batch_before'&&sql.startsWith('INSERT INTO scoped_delivery_envelopes')&&++envelopes===2)crash();
    if(mode==='complete_before'&&sql.startsWith('INSERT INTO runtime_action_commands')&&args[2]==='complete')crash();
    if(mode==='wake_before'&&sql.startsWith('INSERT INTO runtime_action_commands')&&args[2]==='wake')crash();
    if(mode==='output'&&sql.startsWith('UPDATE orchestration_model_calls SET status=CASE'))crash();
    return result;
  };return stmt;
};
try{
  let result;
  if(mode==='claim'){f.store.claimNextDispatch(roomId,'g4-child');crash();}
  else if(mode==='publish_before'){f.db.tx(()=>{f.releases.publishInformationRelease(argument);crash();});}
  else if(mode==='publish'||mode==='publish_after'){result=f.releases.publishInformationRelease(argument);if(mode==='publish_after')crash();}
  else if(mode==='stop')f.stop(runId);
  else if(mode==='revoke')f.releases.revokeInformationRelease(argument);
  else if(mode==='wake'||mode==='wake_before'||mode==='wake_after'){result=f.recovery.recoverDurableHolds(runId);if(mode==='wake_after')crash();}
  else if(mode==='hold_claim'){f.holds.claimReadyDurableHolds({claimOwner:'g4-crash',runId});crash();}
  else if(mode==='reconcile')result=f.runner.reconcileScopedBatch(argument);
  else if(mode==='reconcile_before'){f.db.tx(()=>{f.runner.reconcileScopedBatch(argument);crash();});}
  else if(mode==='reconcile_after'){f.runner.reconcileScopedBatch(argument);crash();}
  else {
    if(mode==='issued')f.mockProvider.chat=async()=>crash();
    if(mode==='complete_race')f.mockProvider.chat=async req=>{writeFileSync(process.env.G4_OUTPUT_GATE+'.'+process.pid,'ready');while(!existsSync(process.env.G4_OUTPUT_GATE))await new Promise(r=>setTimeout(r,5));return f.response(req);};
    result=await f.step(roomId);
    if(['batch_before','batch_after','complete_before','complete_after','reserved','output'].includes(mode))crash();
  }
  console.log(JSON.stringify({ok:true,result,networkAttempts:f.networkAttempts}));process.exit(0);
}catch(error){console.log(JSON.stringify({ok:false,error:error.message,networkAttempts:f.networkAttempts}));process.exit(0);}
