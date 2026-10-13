import { randomUUID } from 'node:crypto';
import { run } from '../db/database.ts';

/** Admission records are not supplier invoices; SDK internals remain unobservable. */
export function queueModelCall(runId:string,agentId:string,model:string,backend:string,attemptId?:string):string {
  const id=randomUUID();run("INSERT INTO orchestration_model_calls(id,run_id,attempt_id,agent_id,model,backend,status,queued_at) VALUES(?,?,?,?,?,?,'waiting',?)",id,runId,attemptId??null,agentId,model,backend,new Date().toISOString());return id;
}
export function modelCallWaiting(id:string,reason:'tokens'|'cost'):void {run("UPDATE orchestration_model_calls SET waiting_reason=? WHERE id=? AND status='waiting'",reason,id);}
export function startModelCall(id:string):void {run("UPDATE orchestration_model_calls SET status='started',waiting_reason=NULL,started_at=? WHERE id=? AND status='waiting'",new Date().toISOString(),id);}
export function finishModelCall(id:string,success:boolean):void {run("UPDATE orchestration_model_calls SET status=CASE WHEN started_at IS NULL THEN 'admission_blocked' WHEN ? THEN 'completed' ELSE 'unknown' END,finished_at=? WHERE id=? AND status IN ('waiting','started')",success?1:0,new Date().toISOString(),id);}
