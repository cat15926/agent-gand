import { randomUUID } from 'node:crypto';
import { get, run, tx } from '../db/database.ts';
import {assertAutonomousModelAdmission} from '../runtime/autonomousExecution.ts';
import {autonomousFail} from '../runtime/autonomousPolicy.ts';

/** Admission records are not supplier invoices; SDK internals remain unobservable. */
export function queueModelCall(runId:string,agentId:string,model:string,backend:string,attemptId?:string):string {
  const id=randomUUID();run("INSERT INTO orchestration_model_calls(id,run_id,attempt_id,agent_id,model,backend,status,queued_at) VALUES(?,?,?,?,?,?,'waiting',?)",id,runId,attemptId??null,agentId,model,backend,new Date().toISOString());return id;
}
export function modelCallWaiting(id:string,reason:'tokens'|'cost'):void {run("UPDATE orchestration_model_calls SET waiting_reason=? WHERE id=? AND status='waiting'",reason,id);}
export function startModelCall(id:string):void {tx(()=>{
  const call=get<{run_id:string;agent_id:string;attempt_id:string|null;model:string;backend:string}>('SELECT run_id,agent_id,attempt_id,model,backend FROM orchestration_model_calls WHERE id=?',id);
  if(call){
    const autonomous=assertAutonomousModelAdmission(call.run_id,call.agent_id,call.attempt_id??undefined,call.model,call.backend);
    if(autonomous&&(get<{n:number}>("SELECT COUNT(*) n FROM orchestration_model_calls WHERE run_id=? AND status='started'",call.run_id)?.n??0)>=autonomous.budget.maxConcurrency)autonomousFail('AUTONOMOUS_LIMIT_EXCEEDED');
  }
  const scoped=get<{attempt_id:string|null}>(`SELECT c.attempt_id FROM orchestration_model_calls c JOIN scoped_delivery_plans p ON p.run_id=c.run_id WHERE c.id=?`,id);
  if(scoped && (!scoped.attempt_id || !get(`SELECT 1 FROM collaboration_attempts a JOIN runs r ON r.id=a.run_id JOIN collaboration_dispatches d ON d.id=a.dispatch_id WHERE a.id=? AND a.status='running' AND d.status='running' AND r.status='running' AND a.lease_expires_at>?`,scoped.attempt_id,new Date().toISOString())))throw new Error('SCOPED_MODEL_ATTEMPT_INACTIVE');
  if(get<{status:string}>('SELECT status FROM orchestration_model_calls WHERE id=?',id)?.status!=='waiting')throw new Error('MODEL_CALL_ALREADY_STARTED');
  run("UPDATE orchestration_model_calls SET status='started',waiting_reason=NULL,started_at=? WHERE id=? AND status='waiting'",new Date().toISOString(),id);});}
export function finishModelCall(id:string,success:boolean):void {run("UPDATE orchestration_model_calls SET status=CASE WHEN started_at IS NULL THEN 'admission_blocked' WHEN ? THEN 'completed' ELSE 'unknown' END,finished_at=? WHERE id=? AND status IN ('waiting','started')",success?1:0,new Date().toISOString(),id);}
