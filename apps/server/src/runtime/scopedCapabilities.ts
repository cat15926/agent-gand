import { config } from '../config.ts';
import type { AgentDefinition, ScopedCollaborationCapability, ScopedCollaborationSupport } from '@agent-gand/shared';
import {getAccount} from '../accounts/store.ts';

export function scopedNativeAgentSupported(agent:AgentDefinition,configured=true):boolean {
  if(agent.execution?.kind!=='external'||!['claude-sdk','codex-app-server'].includes(agent.execution.driver)||!agent.accountRef)return false;
  if(configured&&(!config.scopedNativeDrivers.includes(agent.execution.driver)||!config.orchestrationRollout.enabledDrivers.includes(agent.execution.driver)))return false;
  try {
    const account=getAccount(agent.accountRef);
    return account.source==='managed'&&account.enabled&&!account.archived&&account.compatibleBackends.includes(agent.execution.driver)
      &&(agent.execution.driver==='claude-sdk'?account.authType==='api_key':account.authType==='api_key'||account.nativeClient==='codex');
  } catch {return false;}
}

export function scopedCollaborationAdmission(): ScopedCollaborationSupport['admissionMode'] {
  if (!config.orchestrationRollout.enabledDrivers.includes('builtin-llm') || [config.orchestrationRollout.entryMode,config.scopedCollaborationMode].includes('closed')) return 'closed';
  if ([config.orchestrationRollout.entryMode,config.scopedCollaborationMode].includes('preview')) return 'preview';
  return 'execute';
}
export function scopedCollaborationSupport(): ScopedCollaborationSupport {
  return { admissionMode:scopedCollaborationAdmission(),
    backends:[['builtin-llm','模型 API'],['claude-sdk','Claude SDK'],['codex-app-server','Codex app-server'],['readonly-cli','只读 CLI']].map(([backend,label])=>({backend:backend!,label:label!,capabilities:scopedCollaborationCapabilities(backend!)})),
    limits:{maxBatchItems:Math.min(3,config.collaboration.maxTargets),maxItems:6,maxTokens:config.collaboration.maxTokens} };
}

/** Driver availability and per-account connection evidence are separate claims. */
export function scopedCollaborationCapabilities(backend: string): ScopedCollaborationCapability[] {
  return (['scoped-control-v1', 'scoped-release-v1'] as const).map(name => ({
    package: name, boundaryVersion: 2, toolApiVersion: 3,
    foundationImplemented: ['builtin-llm','claude-sdk','codex-app-server'].includes(backend), implementationSupported: ['builtin-llm','claude-sdk','codex-app-server'].includes(backend),
    configuredAvailable: (backend==='builtin-llm'||config.scopedNativeDrivers.includes(backend)&&config.orchestrationRollout.enabledDrivers.includes(backend as 'claude-sdk'|'codex-app-server')) && scopedCollaborationAdmission() === 'execute', connectionVerified: false, verifiedAt: null,
    reason: backend === 'builtin-llm' ? name === 'scoped-control-v1' ? 'Owner-confirmed text envelopes, all/readonly-any joins and status-only returns; connection not verified' : 'Explicit private aggregation, exact text or status-receipts-v1, single-use owner grant; connection not verified' : backend==='claude-sdk'?'Cold scopes and controlled artifact tools; requires an enabled managed Anthropic API Key account; account connection evidence is separate':backend==='codex-app-server'?'Cold scopes and controlled artifact tools implemented; live Codex verification deferred; disabled by default':'Scoped backend integration is not implemented',
  }));
}
