import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { all, get } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { attemptAccess } from '../messaging/access.ts';
import { resolveEvidence } from '../runtime/evidence.ts';
import { resolveSandboxPath, workspaceRootDir } from '../tools/builtin/index.ts';
import { getBusinessState } from './business.ts';
import { businessQuiescent, canAcceptStage } from './businessGates.ts';
import { listByRun } from '../messaging/inbox.ts';
import { listExecutions } from '../execution/store.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { OrchestrationError, stableDigest } from './normalize.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { readBusinessCheckpoint, safeCheckpointPath, type BusinessCheckpoint } from './businessCheckpointStore.ts';

function fail(code: string, message: string): never { throw new OrchestrationError(409, code, message); }
/** Recomputed at preview and confirmation. No filesystem/database mutation or model call. */
export function buildBusinessCheckpoint(runId: string, rework?: { stageId: string; reportId: string; expectedVersion: number; instruction: string }): BusinessCheckpoint {
  const source = getRun(runId), snapshot = getRunOrchestrationSnapshot(runId), plan = getRunCoordinationPlan(runId);
  const state = getBusinessState(runId);
  if (!source || !(source.status === 'failed' || rework && source.status === 'waiting_for_user' && plan?.status === 'paused')
    || !plan || snapshot?.execution?.engine !== 'coordination' || state.contract?.executionMode !== 'stage_gated')
    fail('BUSINESS_CHECKPOINT_UNSUPPORTED', rework ? '返工需在逐阶段验收边界或已失败任务中明确提出；运行中或已取消任务不可返工' : '阶段续跑只支持已失败的逐阶段任务');
  if (rework && get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?', runId)) fail('CONTINUATION_EXISTS', '原任务已创建后续任务，请在后续任务处理返工');
  if (state.resolution || state.outcome === 'achieved') fail('BUSINESS_OUTCOME_FINAL', '业务结果已固定；补充目标请新建任务');
  if (!businessQuiescent(runId, true)) fail('RESULT_UNKNOWN', '仍有未收敛执行或未知调用消耗，不能迁移阶段进度');
  if (snapshot.execution.readonly !== true || listExecutions(runId).some(e => e.permissionMode !== 'readonly')
    || listToolExecutions(runId).some(t => t.replayPolicy !== 'safe')) fail('WRITE_RECONCILIATION_REQUIRED', '包含写入或幂等操作，需先核对工作区与产物；当前入口只支持公开只读阶段');
  if (listByRun(runId).some(m => m.visibility === 'private')
    || get("SELECT 1 FROM runtime_context_assemblies WHERE run_id=? AND visibility='private' LIMIT 1", runId)) fail('PRIVATE_CHECKPOINT_UNSUPPORTED', '私密阶段状态尚无跨 Run 迁移契约，不能自动汇入后续任务');
  const accepted = state.stages.filter(item => item.status === 'accepted');
  if (accepted.some((item, i) => item.stage.id !== state.stages[i]?.stage.id)) fail('CHECKPOINT_STAGE_ORDER_INVALID', '已验收阶段不是连续前缀，不能续跑');
  if (accepted.length === state.stages.length) fail('ALREADY_COMPLETED', '全部阶段已验收，无剩余任务');
  const inherited = readBusinessCheckpoint(runId);
  if (inherited && stableDigest(inherited.contract) !== stableDigest(state.contract)) fail('CHECKPOINT_CONTRACT_CHANGED', '检查点与冻结阶段契约不一致');
  const rejected = state.stages.find(s => s.status !== 'accepted');
  if (rework) {
    if (state.version !== rework.expectedVersion) fail('BUSINESS_STATE_STALE', '验收记录已改变，请刷新后重新预览返工');
    if (!rejected || rejected.stage.id !== rework.stageId || rejected.report?.id !== rework.reportId
      || rejected.report.kind !== 'delivery' || rejected.decision?.verdict !== 'reject' || !canAcceptStage(runId, rework.stageId))
      fail('STAGE_REWORK_UNAVAILABLE', '仅当前已拒绝的实质交付可以返工，需先确认执行与验收边界');
  }
  const outputs: BusinessCheckpoint['outputs'] = inherited ? structuredClone(inherited.outputs) : [];
  for (const row of all<{ id: string; step_id: string; output: string }>("SELECT id,step_id,output FROM coordination_step_attempts WHERE run_id=? AND plan_id=? AND revision=? AND status='completed' AND output IS NOT NULL ORDER BY created_at,id", runId, plan.id, plan.revision)) {
    const step = plan.steps.find(s => s.id === row.step_id && s.agentId);
    if (!step) continue;
    const stage = state.contract.stages.find(s => s.id === step.metadata.businessStageId);
    if (!stage || attemptAccess(row.id).visibility !== 'public') fail('PRIVATE_CHECKPOINT_UNSUPPORTED', '阶段产物未冻结为公开内容，不能自动迁移');
    const resolved = resolveEvidence(runId, { kind: 'attempt_output', id: row.id });
    if (!resolved.trusted || !resolved.contentSha256 || !row.output.trim()) fail('CHECKPOINT_EVIDENCE_INVALID', '已完成步骤缺少可验证交付');
    outputs.push({ attemptId: row.id, sourceRunId: runId, stageId: stage.id, stepId: step.id, agentId: step.agentId!,
      objective: String(step.metadata.objective), output: row.output, sha256: resolved.contentSha256 });
  }
  if (new Set(outputs.map(o => o.stepId)).size !== outputs.length) fail('CHECKPOINT_DUPLICATE_WORKER', '检查点包含重复成员步骤');
  let reworkArchive = inherited?.rework ? structuredClone(inherited.rework) : undefined;
  if (rework) {
    reworkArchive = { sourceRunId: runId, sourceStatus: source.status, stageId: rework.stageId, report: structuredClone(rejected!.report!),
      decision: structuredClone(rejected!.decision!), instruction: rework.instruction,
      rejectedOutputs: outputs.filter(o => o.stageId === rework.stageId) };
    // Only the accepted prefix survives. Every member in the rejected stage is explicitly rerun.
    const retained = outputs.filter(o => accepted.some(a => a.stage.id === o.stageId));
    outputs.splice(0, outputs.length, ...retained);
  } else if (state.stages.some(s => s.status === 'rejected')) fail('STAGE_REWORK_REQUIRED', '存在已拒绝交付，需要明确返工任务；不能复用为确认完成');
  const files: BusinessCheckpoint['files'] = inherited ? structuredClone(inherited.files) : [];
  for (const item of accepted) for (const evidence of item.report!.evidence) {
    const ref = evidence.resolution.ref;
    if (ref.kind === 'workspace_file' && inherited?.accepted.some(a => a.stageId === item.stage.id)) continue;
    const fresh = resolveEvidence(runId, ref, 'user');
    if (!fresh.trusted || fresh.contentSha256 !== evidence.resolution.contentSha256) fail('DELIVERY_CHANGED', '已验收交付内容发生变化，不能迁移旧验收结论');
    if (ref.kind !== 'workspace_file') continue;
    if (!safeCheckpointPath(ref.path)) fail('CHECKPOINT_PATH_UNSAFE', '已验收文件路径不可迁移');
    const context = { runId, workspace: source.workspace, workspaceScope: ref.workspaceScope };
    resolveSandboxPath(ref.path, context); // Enforce the same file/private-path policy as the tools.
    const absolute = path.resolve(realpathSync(workspaceRootDir(context)), ref.path);
    if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== absolute) fail('CHECKPOINT_PATH_UNSAFE', '文件证据包含链接，不能归档迁移');
    const bytes = readFileSync(absolute);
    if (bytes.length > 32768 || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) fail('DELIVERY_CHANGED', '归档期间文件内容变化');
    const same = files.find(file => file.path === ref.path);
    if (same && same.sha256 !== ref.sha256) fail('CHECKPOINT_FILE_CONFLICT', '不同阶段同名文件内容不同，需要核对交付版本');
    if (!same) files.push({ sourceRunId: runId, path: ref.path, ...(ref.workspaceScope ? { workspaceScope: ref.workspaceScope } : {}), sha256: ref.sha256, base64: bytes.toString('base64') });
  }
  const charge = (table: string, stageId?: string) => all<{ charged: number }>(`SELECT CASE WHEN status='settled' THEN used ELSE reserved END charged FROM ${table} WHERE run_id=?${stageId ? ' AND stage_id=?' : ''}`, runId, ...(stageId ? [stageId] : [])).reduce((sum, item) => sum + item.charged, 0);
  const pendingStages = state.contract.stages.filter(s => !accepted.some(a => a.stage.id === s.id)
    && s.execution!.assignments.some((_, i) => !outputs.some(o => o.stepId === `stage-${state.contract!.stages.indexOf(s) + 1}-work-${i + 1}`)));
  if (pendingStages.length && snapshot.request.constraints.maxTokens && charge('orchestration_token_reservations') >= snapshot.request.constraints.maxTokens) fail('CHECKPOINT_BUDGET_EXHAUSTED', '本轮输出 Token 预算已耗尽，不能通过关联续跑重置额度；请核对后明确新任务预算');
  if (pendingStages.some(s => s.execution!.maxTokens && charge('business_stage_token_reservations', s.id) >= s.execution!.maxTokens)) fail('CHECKPOINT_BUDGET_EXHAUSTED', '待续阶段的输出 Token 预算已耗尽，需明确新任务预算，不能自动重放');
  const checkpoint: BusinessCheckpoint = { version: 1, sourceRunId: runId, sourceVersion: state.version, contract: structuredClone(state.contract),
    accepted: accepted.map(item => ({ stageId: item.stage.id, report: structuredClone(item.report!), decision: structuredClone(item.decision!) })), outputs, files,
    runTokens: charge('orchestration_token_reservations'), stageTokens: state.contract.stages.map(s => ({ stageId: s.id, charged: charge('business_stage_token_reservations', s.id) })),
    ...(reworkArchive ? { rework: reworkArchive } : {}) };
  if (Buffer.byteLength(JSON.stringify(checkpoint)) > 1024 * 1024) fail('CHECKPOINT_TOO_LARGE', '产物和返工记录归档超过 1 MiB，请核对后准备范围明确的新任务');
  return checkpoint;
}
