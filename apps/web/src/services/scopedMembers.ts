import type {AgentDefinition,ScopedCollaborationSupport} from '@agent-gand/shared';
export function scopedMemberSelectable(agent:AgentDefinition,support:ScopedCollaborationSupport|null|undefined):boolean {
  if(!agent.enabled)return false;
  if(agent.execution?.kind!=='external')return true;
  const driver=agent.execution.driver;
  return !!agent.accountRef&&!!support?.backends.find(backend=>backend.backend===driver)?.capabilities.some(cap=>cap.package==='scoped-control-v1'&&cap.configuredAvailable);
}
