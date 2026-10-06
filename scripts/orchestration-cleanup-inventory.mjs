import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditOrchestration } from './orchestration-maintenance.mjs';

/** Read-only evidence for a later, explicit compatibility removal decision. */
export function cleanupInventory(dbPath) {
  const audit = auditOrchestration(dbPath);
  const statistics = audit.entryStatistics;
  return { readOnly: true, providerRequests: 0, checkedAt: new Date().toISOString(),
    migration: { ok: audit.ok, pendingVersions: audit.pendingMigrations, pendingRoomCount: audit.pendingRoomIds.length,
      mappedRoomCount: audit.counts.roomMappings, roomCount: audit.counts.rooms, issues: audit.issues, warnings: audit.warnings },
    frozenTasks: { activeRuns: audit.activeRuns, inspectionRequiredRunIds: audit.inspectionRequiredRunIds },
    traffic: { available: statistics.length > 0, legacyCalls: statistics.filter(item => item.input_format === 'legacy').reduce((n, item) => n + item.calls, 0),
      unifiedCalls: statistics.filter(item => item.input_format === 'unified').reduce((n, item) => n + item.calls, 0), statistics,
      limitation: 'Counters do not identify callers; absent or recently created counters do not prove there are no legacy clients.' },
    cleanup: { canRemoveCompatibility: false, userConfirmationRecorded: false, realAccountsVerifiedByThisCommand: false,
      candidates: ['旧建房/消息/Run 格式的 API 包装', '旧 Coordination 与 followup preview 请求格式', '前端未使用的旧 REST 导出', '旧格式入场分支'],
      preserve: ['历史 mode 列与读取投影', '有效冻结 Run 的执行/审批/恢复适配', '未知副作用证据与隔离状态', '旧格式兼容回归'],
      requiredEvidence: ['迁移核对通过', '约定观察期内旧格式调用方完成迁移', '真实 Claude SDK 与 Codex app-server 验收通过', '用户明确确认兼容分支清理'] } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('用法：orchestration:cleanup-inventory [--output 文件]');
    const result = cleanupInventory();
    if (args.length) { const output = path.resolve(args[1]); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
    console.log(JSON.stringify(result, null, 2));
    if (!result.migration.ok) process.exitCode = 2;
  } catch (error) { console.error(error.code ? `清理盘点失败：${error.code}` : error.message); process.exitCode = 1; }
}
