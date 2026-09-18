import type { ToolExecution, ToolReplayPolicy } from '@agent-gand/shared';
import { createHash, randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';

interface Row { id:string; run_id:string; agent_id:string; task_id:string|null; attempt_id:string|null; tool_name:string; idempotency_key:string; input:string; replay_policy:string; status:string; output:string|null; error:string|null; span_id:string|null; created_at:string; started_at:string; ended_at:string|null }
const map=(r:Row):ToolExecution=>({id:r.id,runId:r.run_id,agentId:r.agent_id,taskId:r.task_id,attemptId:r.attempt_id,toolName:r.tool_name,idempotencyKey:r.idempotency_key,input:r.input,replayPolicy:r.replay_policy as ToolReplayPolicy,status:r.status as ToolExecution['status'],output:r.output,error:r.error,spanId:r.span_id,createdAt:r.created_at,startedAt:r.started_at,endedAt:r.ended_at});

export function toolExecutionKey(parts: { runId:string; scope:string; round:number; index:number; toolName:string; input:string }): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function listToolExecutions(runId:string):ToolExecution[]{ return all<Row>('SELECT * FROM tool_executions WHERE run_id = ? ORDER BY created_at',runId).map(map); }

export async function executeToolOnce(input: { runId:string; agentId:string; taskId?:string; attemptId?:string; toolName:string; input:string; idempotencyKey:string; replayPolicy:ToolReplayPolicy; spanId:string; execute:()=>Promise<string> }):Promise<{output:string; replayed:boolean}> {
  let existing=get<Row>('SELECT * FROM tool_executions WHERE idempotency_key = ?',input.idempotencyKey);
  if(existing?.status==='completed') return {output:existing.output ?? '',replayed:true};
  if(existing?.status==='running' && existing.replay_policy==='manual') {
    run("UPDATE tool_executions SET status='needs_attention', error=?, ended_at=? WHERE id=?",'服务中断后无法安全自动重放',new Date().toISOString(),existing.id);
    throw new Error(`工具 ${input.toolName} 的上次执行结果不确定，需要人工处理`);
  }
  const now=new Date().toISOString();
  const id=existing?.id ?? randomUUID();
  tx(()=>{
    if(existing) run("UPDATE tool_executions SET status='running', error=NULL, span_id=?, started_at=?, ended_at=NULL WHERE id=?",input.spanId,now,id);
    else run(`INSERT INTO tool_executions (id,run_id,agent_id,task_id,attempt_id,tool_name,idempotency_key,input,replay_policy,status,span_id,created_at,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?)`,id,input.runId,input.agentId,input.taskId??null,input.attemptId??null,input.toolName,input.idempotencyKey,input.input,input.replayPolicy,input.spanId,now,now);
  });
  try { const output=await input.execute(); run("UPDATE tool_executions SET status='completed', output=?, error=NULL, ended_at=? WHERE id=?",output,new Date().toISOString(),id); return {output,replayed:Boolean(existing)}; }
  catch(err){ const message=err instanceof Error?err.message:String(err); run("UPDATE tool_executions SET status='failed', error=?, ended_at=? WHERE id=?",message,new Date().toISOString(),id); throw err; }
}
