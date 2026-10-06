import type { OrchestrationIssue, OrchestrationPreview } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, run } from '../db/database.ts';
import { OrchestrationError } from './normalize.ts';

/** Admission only. Execution, actions, approvals and recovery consult their frozen contracts. */
export function orchestrationAdmissionIssues(preview: OrchestrationPreview): OrchestrationIssue[] {
  const policy = config.orchestrationRollout; const issues: OrchestrationIssue[] = [];
  if (policy.entryMode !== 'execute') issues.push({ code: 'ORCHESTRATION_ENTRY_DISABLED', severity: 'error',
    message: policy.entryMode === 'preview' ? '新任务入口当前仅供预览；已有任务仍可继续。' : '新任务入口已关闭；已有任务仍可继续。' });
  if (!policy.enabledWorkflows.includes(preview.request.workflow)) issues.push({ code: 'WORKFLOW_NOT_ENABLED', severity: 'error', message: '当前工作流尚未开放，请选择已开放的工作流。' });
  for (const id of preview.decision.execution?.participantIds ?? []) {
    const agent = preview.capabilities.agents.find(a => a.id === id);
    if (agent && !policy.enabledDrivers.includes(agent.driver)) issues.push({ code: 'DRIVER_NOT_ENABLED', severity: 'error', agentId: id, message: `成员「${agent.name}」的执行后端尚未开放，请调整本轮对象。` });
  }
  return issues;
}
export function assertOrchestrationAdmission(preview: OrchestrationPreview): void {
  const issues = orchestrationAdmissionIssues(preview);
  if (issues.length) throw new OrchestrationError(503,issues[0]!.code,issues.map(i => i.message).join('；'));
}
export function assertLegacyAdmission(): void {
  if (!config.orchestrationRollout.legacyEntryEnabled) throw new OrchestrationError(503,'LEGACY_ENTRY_DISABLED','旧格式任务入口已关闭，请使用新版任务入口；已有任务仍可继续。');
}
export function recordEntryStatistics(endpoint: string, inputFormat: 'legacy' | 'unified', httpStatus: number): void {
  const now = new Date().toISOString(), outcome = httpStatus < 400 ? 'accepted' : 'rejected';
  run(`INSERT INTO orchestration_entry_statistics(endpoint,input_format,outcome,http_status,calls,first_at,last_at)
    VALUES (?,?,?,?,1,?,?) ON CONFLICT(endpoint,input_format,outcome,http_status)
    DO UPDATE SET calls=calls+1,last_at=excluded.last_at`,endpoint,inputFormat,outcome,httpStatus,now,now);
}
export function entryStatistics() { return all('SELECT * FROM orchestration_entry_statistics ORDER BY endpoint,input_format,http_status'); }
