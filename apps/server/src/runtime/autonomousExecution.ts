import {AsyncLocalStorage} from 'node:async_hooks';
import type {AutonomousGrantBinding,AutonomousTaskPolicyV1} from '@agent-gand/shared';
import {assertAutonomousGrant} from './autonomousTasks.ts';
import {autonomousFail,loadAutonomousTaskPolicy} from './autonomousPolicy.ts';
import {get} from '../db/database.ts';

const current=new AsyncLocalStorage<AutonomousGrantBinding>();
export function withAutonomousExecution<T>(binding:AutonomousGrantBinding,operation:()=>T):T {
  assertAutonomousGrant(binding);
  return current.run({...binding},operation);
}
/** Every paid call retains the same root and the live Attempt authority, even after awaits. */
export function assertAutonomousModelAdmission(runId:string,agentId:string,attemptId?:string,model?:string,backend?:string):AutonomousTaskPolicyV1|null {
  const binding=current.getStore();
  if(binding&&binding.runId!==runId)return autonomousFail('AUTONOMOUS_AUTHORITY_INVALID');
  const policy=loadAutonomousTaskPolicy(runId);
  if(!policy){
    if(binding||get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_valid(payload) AND (json_extract(payload,'$.features.controlActionVersion')=4 OR json_type(payload,'$.features.autonomousCollaboration') IS NOT NULL)",runId))return autonomousFail('AUTONOMOUS_AUTHORITY_INVALID');
    return null;
  }
  if(!binding||binding.attemptId!==attemptId)return autonomousFail('AUTONOMOUS_AUTHORITY_INVALID');
  const {grant}=assertAutonomousGrant(binding);
  const member=policy.members.find(m=>m.agentId===agentId);
  if(grant.agentId!==agentId||model!==undefined&&member?.model!==model||backend!==undefined&&member?.driver!==backend)return autonomousFail('AUTONOMOUS_AUTHORITY_INVALID');
  if(get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND (pause_requested=1 OR recovery_attention=1)',runId))return autonomousFail('AUTONOMOUS_AUTHORITY_INVALID');
  return policy;
}
