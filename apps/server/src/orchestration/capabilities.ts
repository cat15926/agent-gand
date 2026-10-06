import type { AccountConnection, AgentDefinition, OrchestrationAgentCapability, OrchestrationCapabilitySnapshot } from '@agent-gand/shared';
import { backendFor } from '../accounts/resolver.ts';
import { compatibleBackends } from '../accounts/compatibility.ts';
import { implicitAccount, legacyAccounts } from '../accounts/legacy.ts';
import { getAnyAgent } from '../agents/registry.ts';
import { config } from '../config.ts';
import { get } from '../db/database.ts';
import { bidirectional } from '../execution/policy.ts';
import { listTools } from '../tools/builtin/index.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import { externalId, getExternal, isExternalWorkspace } from '../workspaces/external.ts';
import { OrchestrationError, stableDigest } from './normalize.ts';

function accountCapability(agent: AgentDefinition): OrchestrationAgentCapability['account'] {
  const id = agent.accountRef ?? implicitAccount(agent);
  const base: OrchestrationAgentCapability['account'] = { id, version: null, configVersion: null, credentialVersion: null, identityGeneration: null,
    configuration: agent.requiresAccount ? 'missing' : 'unchecked', modelTest: 'untested', compatible: !agent.requiresAccount };
  if (!id) return agent.model.startsWith('mock:') && !agent.requiresAccount ? { ...base, configuration: 'configured' } : base;
  try {
    // getAccount() decrypts credentials for its locked-status projection. Do not use it here.
    const row = get<{ version: number; config_version: number; credential_version: number | null; identity_generation: number | null; auth_type: string; provider: string; enabled: number; archived: number }>('SELECT * FROM accounts WHERE id=?', id);
    if (!row) {
      const legacy = legacyAccounts().find(account => account.id === id);
      if (!legacy) return { ...base, configuration: 'unavailable', compatible: false };
      return { ...base, version: legacy.version, configVersion: legacy.configVersion,
        configuration: legacy.authentication === 'unchecked' ? 'unchecked' : legacy.hasCredential ? 'configured' : 'missing',
        compatible: !!backendFor(agent) && legacy.compatibleBackends.includes(backendFor(agent)!),
      };
    }
    const saved = get<{ connection: string }>('SELECT connection FROM account_versions WHERE account_id=? AND version=?', id, row.config_version);
    if (!saved) return { ...base, configuration: 'unavailable', compatible: false };
    const connection = JSON.parse(saved.connection) as AccountConnection;
    const native = row.auth_type === 'native_login' ? get<{ status: string }>('SELECT status FROM account_native_identities WHERE account_id=? AND generation=?', id, row.identity_generation) : null;
    const credentialPresent = row.credential_version !== null && !!get('SELECT version FROM account_credentials WHERE account_id=? AND version=?', id, row.credential_version);
    const backend = backendFor(agent);
    const compatible = !!backend && compatibleBackends(connection, row.auth_type === 'native_login' ? row.provider === 'anthropic' ? 'claude' : 'codex' : null).includes(backend);
    const model = agent.execution?.kind === 'external' ? agent.model === 'default' ? connection.defaultModel ?? 'default' : agent.model : agent.model.slice(agent.model.indexOf(':') + 1);
    const configured = row.auth_type === 'native_login' ? native?.status === 'authenticated' : credentialPresent && model !== 'default';
    const configuration = row.archived || !row.enabled || get('SELECT account_id FROM account_revocations WHERE account_id=?', id) || !compatible ? 'unavailable' : configured ? 'configured' : 'missing';
    const check = get<{ status: 'passed' | 'failed'; config_version: number; credential_version: number | null; identity_generation: number | null }>("SELECT * FROM account_checks WHERE account_id=? AND backend=? AND model=? AND status<>'running' ORDER BY tested_at DESC,rowid DESC LIMIT 1", id, backend, model);
    const modelTest = !check ? 'untested' : check.config_version !== row.config_version || check.credential_version !== row.credential_version || check.identity_generation !== row.identity_generation || !configured ? 'stale' : check.status;
    return { id, version: row.version, configVersion: row.config_version, credentialVersion: row.credential_version,
      identityGeneration: row.identity_generation ?? null, configuration, modelTest, compatible };
  } catch {
    return { ...base, configuration: 'unavailable', compatible: false };
  }
}

export function orchestrationCapabilities(agentIds: string[], workspace: string | null): OrchestrationCapabilitySnapshot {
  const agents = agentIds.map(id => {
    const agent = getAnyAgent(id);
    if (!agent) throw new OrchestrationError(400, 'UNKNOWN_AGENT', `成员不存在: ${id}`);
    const external = agent.execution?.kind === 'external' ? agent.execution : null;
    const driver = external?.driver ?? 'builtin-llm';
    const control = external ? bidirectional(driver) : true;
    const readonlyCli = external && !control;
    const catalog = external ? external.platformTools ?? [] : listTools().map(tool => tool.name);
    const platformTools = catalog.filter(tool => !agent.disallowedTools.includes(tool)
      && (agent.permissionMode === 'readonly' ? READONLY_TOOLS.has(tool) : agent.permissionMode === 'auto' ? agent.tools.includes(tool) : true));
    const nativeTools = external?.nativeTools?.filter(tool => !agent.disallowedTools.includes(tool)) ?? [];
    const capability: OrchestrationAgentCapability = {
      id: agent.id, name: agent.name, version: agent.version, definitionDigest: stableDigest(agent), enabled: agent.enabled,
      model: agent.model, capabilities: [...agent.capabilities], driver, permissionMode: agent.permissionMode,
      platformTools, nativeTools, deniedTools: [...agent.disallowedTools],
      supports: { control, resume: !!external && control && !!external.sessionPolicy && external.sessionPolicy !== 'turn',
        nativeWrite: !!external && control && agent.permissionMode !== 'readonly' && (agent.permissionMode === 'confirm' || driver === 'codex-app-server' || nativeTools.some(tool => ['Write', 'Edit', 'Bash'].includes(tool))),
        hardTokenLimit: !external, coordinationSteps: !external || control },
      legacyModes: readonlyCli ? ['pipeline'] : ['pipeline', 'collaboration', 'supervisor'],
      account: accountCapability(agent),
    };
    return capability;
  });
  let registrationDigest: string | null = null;
  if (workspace) {
    if (isExternalWorkspace(workspace)) {
      const registration = getExternal(externalId(workspace)!);
      if (!registration) throw new OrchestrationError(400, 'INVALID_WORKSPACE', '外部工作区未注册');
      registrationDigest = stableDigest(registration);
    } else if (!/^[\w-]{1,32}$/.test(workspace)) throw new OrchestrationError(400, 'INVALID_WORKSPACE', 'workspace 只允许字母/数字/下划线/连字符，长度 1-32');
  }
  return { schemaVersion: 1, agents, workspace: { name: workspace, kind: !workspace ? 'per_run' : isExternalWorkspace(workspace) ? 'external' : 'named', registrationDigest },
    driverDetection: 'not_performed', testedModel: false, maximumTargets: config.collaboration.maxTargets };
}
