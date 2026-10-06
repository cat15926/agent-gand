import { ORCHESTRATION_WORKFLOWS } from '@agent-gand/shared';
export const ORCHESTRATION_DRIVERS = ['builtin-llm','claude-sdk','codex-app-server','claude-cli','codex-exec'] as const;
export function parseOrchestrationRollout(env: NodeJS.ProcessEnv) {
  const mode = env.ORCHESTRATION_ENTRY_MODE ?? 'execute';
  if (!['execute','preview','closed'].includes(mode)) throw new Error('ORCHESTRATION_ENTRY_MODE 必须是 execute|preview|closed');
  const list = <T extends string>(key: string, supported: readonly T[]): T[] => {
    const raw = env[key];
    if (raw === undefined) return [...supported];
    const values = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (values.some(s => !supported.includes(s as T))) throw new Error(`${key} 包含未知值`);
    return [...new Set(values)] as T[];
  };
  const legacy = env.ORCHESTRATION_LEGACY_ENTRY_ENABLED ?? 'true';
  if (!['true','false'].includes(legacy)) throw new Error('ORCHESTRATION_LEGACY_ENTRY_ENABLED 必须是 true|false');
  return { entryMode: mode as 'execute' | 'preview' | 'closed', legacyEntryEnabled: legacy === 'true',
    enabledWorkflows: list('ORCHESTRATION_ENABLED_WORKFLOWS',ORCHESTRATION_WORKFLOWS),
    enabledDrivers: list('ORCHESTRATION_ENABLED_DRIVERS',ORCHESTRATION_DRIVERS),
    existingRunsContinue: true as const };
}
