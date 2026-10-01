import type { RuntimeAdmissionProfile, RunStatus } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, get } from '../db/database.ts';
import { loadRuntimeContract, resolveRunPolicy } from './runPolicy.ts';

const TERMINAL = new Set<RunStatus>(['completed', 'failed', 'cancelled']);
const LEGACY_ALIASES = ['agent.send_message', 'agent.ask_many', 'agent.wait_for_user'] as const;

export type RuntimeCompatibilityBlockerKind =
  | 'missing_contract'
  | 'ambiguous_or_invalid_policy'
  | 'legacy_authority'
  | 'shadow_state'
  | 'atomic_compat'
  | 'tool_api_v1'
  | 'legacy_alias_checkpoint'
  | 'non_execute_admission';

export interface RuntimeCompatibilityBlocker {
  runId: string;
  status: RunStatus;
  kind: RuntimeCompatibilityBlockerKind;
  detail: string;
}

export interface RuntimeCompatibilityInventory {
  observedAt: string;
  configuredAdmissionProfile: RuntimeAdmissionProfile;
  activeCollaborationRuns: number;
  activeProfiles: Partial<Record<RuntimeAdmissionProfile | 'unknown', number>>;
  legacyAliasCheckpointCount: number;
  blockers: RuntimeCompatibilityBlocker[];
  canRetireLegacyAliases: boolean;
  canRetireLegacyFinalization: boolean;
  canRetireAtomicCompat: boolean;
  readyForCompatibilityRemoval: boolean;
}

function addProfile(target: RuntimeCompatibilityInventory['activeProfiles'], profile: RuntimeAdmissionProfile | 'unknown'): void {
  target[profile] = (target[profile] ?? 0) + 1;
}

/**
 * 兼容代码删除前的库存门禁。只读扫描活跃 Collaboration Run 与未完成 checkpoint；
 * 终态历史记录不会阻止清理，且始终由旧 Contract parser 保留解释能力。
 */
export function inspectRuntimeCompatibilityInventory(): RuntimeCompatibilityInventory {
  const rows = all<{ id: string; status: RunStatus }>(
    "SELECT id,status FROM runs WHERE mode='collaboration' ORDER BY created_at,id");
  const active = rows.filter((row) => !TERMINAL.has(row.status));
  const activeProfiles: RuntimeCompatibilityInventory['activeProfiles'] = {};
  const blockers: RuntimeCompatibilityBlocker[] = [];
  if (config.collaboration.runtimeAdmissionProfile !== 'execute') {
    blockers.push({ runId: '__admission__', status: 'pending', kind: 'non_execute_admission',
      detail: `当前 admission=${config.collaboration.runtimeAdmissionProfile} 仍允许创建新的兼容 Run` });
  }

  for (const item of active) {
    try {
      const contract = loadRuntimeContract(item.id);
      if (!contract) {
        addProfile(activeProfiles, 'unknown');
        blockers.push({ runId: item.id, status: item.status, kind: 'missing_contract',
          detail: '活跃历史 Run 没有冻结 Runtime Contract，不能猜测升级或删除 legacy 恢复路径' });
        continue;
      }
      const policy = resolveRunPolicy(item.id);
      addProfile(activeProfiles, policy.profile);
      if (policy.authority === 'legacy') blockers.push({ runId: item.id, status: item.status, kind: 'legacy_authority',
        detail: `活跃 Run 仍由 ${policy.profile} finalization 拥有终局权` });
      if (policy.runtimeStateMode === 'shadow') blockers.push({ runId: item.id, status: item.status, kind: 'shadow_state',
        detail: '活跃 Run 仍需 Shadow observer 兼容路径' });
      if (policy.profile === 'atomic_compat') blockers.push({ runId: item.id, status: item.status, kind: 'atomic_compat',
        detail: '活跃 Run 仍需 custody_v1 原子兼容路径' });
      if (policy.toolApiVersion === 1) blockers.push({ runId: item.id, status: item.status, kind: 'tool_api_v1',
        detail: '活跃 Run 的冻结 Tool API 仍为 v1' });
    } catch (error) {
      addProfile(activeProfiles, 'unknown');
      blockers.push({ runId: item.id, status: item.status, kind: 'ambiguous_or_invalid_policy',
        detail: error instanceof Error ? error.message : String(error) });
    }
  }

  let legacyAliasCheckpointCount = 0;
  for (const item of active) {
    const checkpoint = get<{ count: number }>(`SELECT COUNT(*) count FROM run_checkpoints
      WHERE run_id=? AND status IN ('active','waiting')
        AND (${LEGACY_ALIASES.map(() => 'instr(state,?)>0').join(' OR ')})`, item.id, ...LEGACY_ALIASES);
    if ((checkpoint?.count ?? 0) > 0) {
      legacyAliasCheckpointCount += checkpoint!.count;
      blockers.push({ runId: item.id, status: item.status, kind: 'legacy_alias_checkpoint',
        detail: `${checkpoint!.count} 个未完成 checkpoint 仍引用旧工具别名` });
    }
  }

  const has = (kind: RuntimeCompatibilityBlockerKind) => blockers.some((item) => item.kind === kind);
  const canRetireLegacyAliases = !has('missing_contract') && !has('ambiguous_or_invalid_policy')
    && !has('tool_api_v1') && !has('legacy_alias_checkpoint') && !has('non_execute_admission');
  const canRetireLegacyFinalization = !has('missing_contract') && !has('ambiguous_or_invalid_policy')
    && !has('legacy_authority') && !has('shadow_state') && !has('non_execute_admission');
  const canRetireAtomicCompat = !has('missing_contract') && !has('ambiguous_or_invalid_policy')
    && !has('atomic_compat') && !has('non_execute_admission');
  return { observedAt: new Date().toISOString(), configuredAdmissionProfile: config.collaboration.runtimeAdmissionProfile,
    activeCollaborationRuns: active.length, activeProfiles,
    legacyAliasCheckpointCount, blockers, canRetireLegacyAliases, canRetireLegacyFinalization,
    canRetireAtomicCompat,
    readyForCompatibilityRemoval: canRetireLegacyAliases && canRetireLegacyFinalization && canRetireAtomicCompat };
}
