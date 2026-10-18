import type {AutonomousTaskPolicyV1,AgentDefinition} from '@agent-gand/shared';
import {config} from '../config.ts';
import {get} from '../db/database.ts';
import {scopedNativeAgentSupported} from './scopedCapabilities.ts';

/** Admission flags do not revoke a frozen AC6 task. Stop/revocation remain explicit runtime facts. */
export function autonomousExecutionAvailable(runId:string):boolean {
 return config.autonomousCollaborationMode==='execute'||!!get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_extract(payload,'$.features.autonomousCollaboration.rolloutVersion')=1",runId);
}
export function autonomousRoomAllowed(roomId?:string):boolean{return config.autonomousRoomIds===null||!!roomId&&config.autonomousRoomIds.includes(roomId);}
export function autonomousAdmissionDrivers():string[]{return ['builtin-llm',...(config.autonomousNativeDrivers.includes('claude-sdk')&&config.scopedNativeDrivers.includes('claude-sdk')&&config.orchestrationRollout.enabledDrivers.includes('claude-sdk')?['claude-sdk']:[])];}
export function autonomousCoordinatorDrivers():string[]{return autonomousAdmissionDrivers().filter(driver=>driver==='builtin-llm'||config.autonomousNativeCoordinatorDrivers.includes(driver));}
export function autonomousDriverAllowed(policy:AutonomousTaskPolicyV1,driver:string):boolean{return (policy.executionDrivers??['builtin-llm']).includes(driver);}
export function autonomousAgentEligible(agent:AgentDefinition):boolean{return agent.execution?.kind!=='external'||agent.execution.driver==='claude-sdk'&&autonomousAdmissionDrivers().includes('claude-sdk')&&scopedNativeAgentSupported(agent);}
