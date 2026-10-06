import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { OrchestrationPreview, OrchestrationPreviewInput, OrchestrationSource, RunOrchestrationSnapshot } from '@agent-gand/shared';
import { validateRoomPreferences } from '../conversations/entry.ts';
import { getAnyAgent } from '../agents/registry.ts';
import { get, run, tx } from '../db/database.ts';
import { createConversation, getConversation, nextTurnNo, touchConversation } from '../conversations/service.ts';
import { createRun, listRunAgentSnapshots } from '../runs/trace.ts';
import { post, listByRun } from '../messaging/inbox.ts';
import { getExternal, externalId } from '../workspaces/external.ts';
import { config } from '../config.ts';
import { providerForAgent } from '../llm/router.ts';
import { savePlanningResult, activateCoordinationPlan, getRunCoordinationPlan, applyCoordinationPlanRevision, getCoordinationDraft } from '../coordination/store.ts';
import { prepareOrchestration, type LegacySubmissionResult } from './service.ts';
import { objectInput, OrchestrationError, semanticRequest, stableDigest } from './normalize.ts';
import { resolveExecutableOrchestration } from './resolver.ts';
import { compileWorkflow } from './workflows.ts';
import { getSubmissionSnapshot, saveSubmissionSnapshot, getRunOrchestrationSnapshot } from './store.ts';
import { parseDecomposition, type DecomposedTask } from './supervisor.ts';
import { saveCheckpoint } from '../runs/checkpoints.ts';
import { assertCoordinationRecoveryReady } from '../coordination/runtime.ts';
import { getRun } from '../runs/trace.ts';
import { assertOrchestrationAdmission, orchestrationAdmissionIssues } from './rollout.ts';

const fields = ['goal','conversationId','agentIds','recipientIds','strategy','workflow','workspace','supervisorId',
  'defaultReviewerId','aggregatorId','replyTo','taskId','clientRequestId','constraints','wholeTeam','planning'];
interface StoredPreview { preview: OrchestrationPreview; configurationFingerprint: string; decomposition?: DecomposedTask[] }
function invalid(code: string, message: string, status = 409): never { throw new OrchestrationError(status, code, message); }
const hasErrors = (preview: OrchestrationPreview) => preview.decision.issues.some(i => i.severity === 'error');
const shape = (preview: OrchestrationPreview) => preview.plan?.plan.steps.map(({ id, protocol, type, agentId, dependsOn, metadata, toolPolicy, maxAttempts, tokenBudget, timeoutMs }) =>
  ({ id, protocol, type, agentId, dependsOn, metadata, toolPolicy, maxAttempts, tokenBudget, timeoutMs })) ?? null;

function prepare(value: Record<string, unknown>, source: OrchestrationSource): StoredPreview {
  const room = typeof value.conversationId === 'string' ? getConversation(value.conversationId) : null;
  if (room?.preferencesIssue && value.revisionRunId === undefined) invalid('ROOM_PREFERENCES_INVALID',room.preferencesIssue);
  const defaults = room?.preferences;
  const input = { ...(defaults ?? {}), ...value, strategy: value.strategy ?? defaults?.strategy ?? 'auto', workflow: value.workflow ?? defaults?.workflow ?? 'routine' } as unknown as OrchestrationPreviewInput;
  const old = prepareOrchestration(input, source);
  const replied = input.replyTo && input.conversationId
    ? get<{ from_agent: string }>('SELECT from_agent FROM messages WHERE id=?', input.replyTo)?.from_agent : null;
  const decision = resolveExecutableOrchestration(old.request, old.capabilities, replied, value.workflow !== undefined || Boolean(defaults));
  const preview: OrchestrationPreview = { ...old, decision, comparisonOnly: false, plan: null,
    planning: { kind: 'rules', model: null, tokensIn: 0, tokensOut: 0, calls: 0 } };
  const add = (code: string, message: string) => decision.issues.push({ code, message, severity: 'error' });
  const nativeWriter = !decision.execution!.readonly && decision.execution!.participantIds.some(id => old.capabilities.agents.find(a => a.id === id)?.driver !== 'builtin-llm');
  const needsGit = nativeWriter || !decision.execution!.readonly && ['development_review','supervisor_decomposition'].includes(old.request.workflow);
  if (needsGit) {
    const registration = old.request.workspace && getExternal(externalId(old.request.workspace) ?? '');
    if (!registration || config.externalAgents.workspaceMode !== 'isolated') add('REGISTERED_GIT_WORKSPACE_REQUIRED', '编码任务需要已注册的 Git 根工作区及隔离工作区模式，请先选择工作区');
    else try {
      const result = execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','rev-parse','--show-toplevel','HEAD'],
        { cwd: registration.absPath, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), encoding: 'utf8', timeout: 3000, stdio: ['ignore','pipe','pipe'] }).trim().split('\n');
      if (realpathSync(result[0]!) !== realpathSync(registration.absPath) || !result[1]) throw new Error('not root');
    } catch { add('REGISTERED_GIT_WORKSPACE_REQUIRED', '请选择已有提交的 Git 根工作区，不能将普通目录当成编码工作树'); }
  }
  if (old.request.workflow === 'development_review' && old.request.constraints.readonly === true) add('WORKFLOW_READONLY_CONFLICT', '开发与评审包含实现写入，请移除只读限制或选择分析工作流');
  if (!hasErrors(preview) && decision.execution!.engine === 'coordination' && !decision.execution!.plannerRequired) {
    preview.plan = compileWorkflow(old.request, decision, decision.execution!.participantIds.map(id => getAnyAgent(id)!));
    for (const issue of preview.plan.plan.validationIssues) decision.issues.push({ code: issue.code, message: issue.message, severity: issue.severity });
  }
  const { legacy: _legacy, ...semantic } = semanticRequest(preview.request);
  const configurationFingerprint = stableDigest({ request: semantic, capabilities: preview.capabilities, decision });
  preview.fingerprint = stableDigest({ configurationFingerprint, steps: shape(preview) });
  return { preview, configurationFingerprint };
}

export async function previewExecutionOrchestration(value: unknown, source: OrchestrationSource = 'unified_preview'): Promise<OrchestrationPreview> {
  const body = objectInput(value);
  if (Object.keys(body).some(key => ![...fields,'revisionRunId'].includes(key))) invalid('UNKNOWN_FIELD','预览请求包含未知字段',400);
  const revisionRun = typeof body.revisionRunId === 'string' ? getRun(body.revisionRunId) : null;
  if (body.revisionRunId !== undefined && (!revisionRun || revisionRun.conversationId !== body.conversationId
    || revisionRun.status !== 'waiting_for_user' || getRunCoordinationPlan(revisionRun.id)?.status !== 'paused'
    || getRunOrchestrationSnapshot(revisionRun.id)?.execution?.engine !== 'coordination')) invalid('REVISION_UNSUPPORTED','修订预览需要属于当前房间的已暂停步骤图');
  if (body.planning !== undefined && !['rules','detailed'].includes(String(body.planning))) invalid('INVALID_PLANNING','planning 必须为 rules 或 detailed',400);
  const stored = prepare(body, source), preview = stored.preview;
  if (revisionRun) {
    const original=getRunOrchestrationSnapshot(revisionRun.id)!;
    assertCoordinationRecoveryReady(revisionRun.id);
    if (preview.request.workflow !== original.request.workflow
      || preview.request.workspace !== (original.legacyExecution.workspace ?? original.request.workspace)
      || stableDigest(preview.request.constraints) !== stableDigest(original.request.constraints)) {
      invalid('REVISION_POLICY_CONFLICT','修订预览必须保留原任务的工作流、工作区和预算；修改这些设置请创建新任务');
    }
  }
  if (body.planning === 'detailed' && !revisionRun) assertOrchestrationAdmission(preview);
  if (body.planning === 'detailed' && !preview.decision.execution!.plannerRequired) invalid('DETAILED_PLANNING_NOT_REQUIRED','详细规划只用于主管拆解；当前工作流使用确定性模板',400);
  if (body.planning === 'detailed' && !hasErrors(preview)) {
    const agents = preview.decision.execution!.participantIds.map(id => getAnyAgent(id)!);
    const supervisor = agents.find(a => a.id === preview.request.supervisorId)!;
    const workers = agents.filter(a => preview.decision.targetIds.includes(a.id));
    const prompt = ['__AGENT_GAND_O4_DAG__', `目标：${preview.request.goal}`,
      `可执行成员：${JSON.stringify(workers.map(a => ({ id: a.id, description: a.description })))}`,
      `可用评审者：${JSON.stringify(agents.filter(a => a.capabilities.includes('review')).map(a => a.id))}`,
      '只生成计划，不执行工具、不写文件。严格输出 1～5 个任务的 JSON，标题唯一，依赖无环，必须给出具体任务和验收标准：',
      '{"tasks":[{"title":"标题","body":"工作内容","assignee":"成员id","reviewer":"独立评审者id","reviewRequired":true,"acceptanceCriteria":["验收条件"],"blockedBy":["前置任务标题"]}]}',
      '任务按依赖形成实际步骤图；每个下游必须等待前置任务及其评审通过。无需评审时明确设置 reviewRequired:false。'].join('\n');
    preview.planning = { kind: 'detailed', model: supervisor.model, tokensIn: 0, tokensOut: 0, calls: 1 };
    try {
      const response = await providerForAgent(supervisor).chat({ model: supervisor.model,
        messages: [{ role: 'system', content: supervisor.systemPrompt }, { role: 'user', content: prompt }],
        tools: [], maxTokens: 4000, signal: AbortSignal.timeout(Math.min(config.externalAgents.timeoutMs,30000)) });
      preview.planning.tokensIn = response.usage.tokensIn; preview.planning.tokensOut = response.usage.tokensOut;
      if (response.truncated || response.toolCalls.length) throw new Error('规划结果不完整或试图调用工具');
      const raw = JSON.parse(response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
      if (!Array.isArray(raw.tasks) || raw.tasks.some((task: any) => typeof task.body !== 'string' || !task.body.trim()
        || !Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.length
        || task.acceptanceCriteria.some((v: unknown) => typeof v !== 'string' || !v.trim())
        || typeof task.reviewRequired !== 'boolean')) throw new Error('每个任务必须明确内容、验收标准和评审要求');
      const specs = parseDecomposition(JSON.stringify(raw), workers, agents, preview.request.defaultReviewerId);
      if (!specs || specs.some(s => !s.body?.trim() || s.title.length > 200 || s.body.length > 8000 || s.acceptanceCriteria.length > 12)) throw new Error('规划未形成合法的任务、角色、验收标准及依赖图');
      stored.decomposition = specs;
      preview.plan = compileWorkflow(preview.request, preview.decision, agents, specs);
      preview.plan.draft.planning = { source: 'model', model: supervisor.model, attempts: 1, tokensIn: response.usage.tokensIn,
        tokensOut: response.usage.tokensOut, costUsd: response.usage.costUsd, fallbackReason: null };
      for (const issue of preview.plan.plan.validationIssues) preview.decision.issues.push({ code: issue.code, severity: issue.severity, message: issue.message });
    } catch (error) {
      preview.decision.issues.push({ code: 'DETAILED_PLAN_INVALID', severity: 'error', message: `详细规划未通过：${error instanceof Error ? error.message : String(error)}。请重新生成或调整团队。` });
    }
    if (prepare(body, source).configurationFingerprint !== stored.configurationFingerprint) invalid('PREVIEW_STALE','规划期间团队、账户或工作区已变化，请重新预览');
    preview.fingerprint = stableDigest({ configurationFingerprint: stored.configurationFingerprint, steps: shape(preview) });
  }
  preview.previewId = randomUUID();
  run('INSERT INTO orchestration_previews(id,fingerprint,payload,created_at) VALUES (?,?,?,?)', preview.previewId, preview.fingerprint, JSON.stringify(stored), new Date().toISOString());
  // Rollout conditions are absent from frozen fingerprints. Already admitted graph revisions
  // remain available when new entry is closed; submission still checks its own gate.
  if (!revisionRun) preview.decision.issues.push(...orchestrationAdmissionIssues(preview));
  return preview;
}

/** Shared transaction for new tasks from rooms, messages and direct Run compatibility endpoints. */
export function submitExecutionOrchestration(value: unknown, conversationId?: string,
  source: 'room_create' | 'conversation_message' | 'direct_run' = conversationId ? 'conversation_message' : 'room_create'): LegacySubmissionResult {
  const body = objectInput(value);
  if (conversationId && body.conversationId !== undefined && body.conversationId !== conversationId) invalid('ROOM_REFERENCE_CONFLICT','conversationId 与请求路径不一致',400);
  conversationId ??= typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const allowed = [...fields,'entryVersion','previewId','orchestrationFingerprint','body','clientMessageId','mode','roomTitle','roomPreferences'];
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid('UNKNOWN_FIELD','提交包含未知字段',400);
  if (body.entryVersion !== undefined && body.entryVersion !== 1) invalid('INVALID_ENTRY_VERSION','entryVersion 必须为 1',400);
  const input = Object.fromEntries(fields.filter(key => body[key] !== undefined).map(key => [key,body[key]]));
  input.goal = body.goal ?? body.body;
  if (conversationId) input.conversationId = conversationId;
  input.clientRequestId = body.clientRequestId ?? body.clientMessageId;
  if (typeof input.clientRequestId !== 'string' || input.clientRequestId.length < 8 || input.clientRequestId.length > 100) invalid('INVALID_IDEMPOTENCY_KEY','clientRequestId 长度必须为 8～100',400);
  if (typeof input.goal !== 'string' || !input.goal.trim()) invalid('MISSING_GOAL','goal 必填',400);
  const scope = conversationId ? `conversation:${conversationId}` : `entry:${source}`;
  if (conversationId && (body.roomTitle !== undefined || body.roomPreferences !== undefined)) invalid('INVALID_ROOM_SETTINGS','房间设置需要通过独立入口修改',400);
  if (body.roomTitle !== undefined && (typeof body.roomTitle !== 'string' || !body.roomTitle.trim() || body.roomTitle.length > 80)) invalid('INVALID_TITLE','房间名称长度应为 1～80',400);
  const roomPreferences = body.roomPreferences !== undefined ? validateRoomPreferences(body.roomPreferences, input.agentIds as string[]) : undefined;
  const submissionDigest = stableDigest({ entryVersion: 1, input, previewId: body.previewId ?? null, roomTitle: body.roomTitle, roomPreferences });
  return tx(() => {
    const existing = getSubmissionSnapshot(scope, input.clientRequestId as string);
    if (existing) {
      if (existing.submissionDigest !== submissionDigest) invalid('IDEMPOTENCY_CONFLICT','同一请求 ID 已用于不同任务或计划');
      const currentRun = getRun(existing.runId), room = getConversation(existing.conversationId);
      if (!currentRun || !room) invalid('SUBMISSION_RECORD_INCOMPLETE','既有提交记录不完整');
      return { run: currentRun, conversation: room, message: listByRun(currentRun.id).find(m => m.kind === 'user') ?? null,
        plan: getRunCoordinationPlan(currentRun.id) ?? null, deduplicated: true };
    }
    const fresh = prepare(input, source);
    assertOrchestrationAdmission(fresh.preview);
    let prepared = fresh.preview;
    if (typeof body.previewId === 'string') {
      const row = get<{ payload: string }>('SELECT payload FROM orchestration_previews WHERE id=?', body.previewId);
      if (!row) invalid('PREVIEW_NOT_FOUND','预览不存在，请重新生成');
      const stored = JSON.parse(row.payload) as StoredPreview;
      if (stored.configurationFingerprint !== fresh.configurationFingerprint || body.orchestrationFingerprint !== stored.preview.fingerprint) invalid('PREVIEW_STALE','目标、团队、账户、约束或工作区已变化，请重新预览并确认');
      if (hasErrors(stored.preview)) invalid('PREVIEW_INVALID','当前预览存在阻断项，不能执行');
      prepared = stored.preview;
    } else if (prepared.decision.requiresConfirmation) invalid('PLAN_CONFIRMATION_REQUIRED','请先预览并确认本轮工作流；提交 previewId 与 orchestrationFingerprint');
    if (hasErrors(prepared)) invalid(prepared.decision.issues.find(i => i.severity === 'error')!.code, prepared.decision.issues.filter(i => i.severity === 'error').map(i => i.message).join('；'));
    if (prepared.decision.execution!.plannerRequired && !prepared.plan) invalid('DETAILED_PLAN_REQUIRED','请显式生成详细主管计划并确认后执行');
    const request = { ...prepared.request, source, clientRequestId: input.clientRequestId as string };
    const decision = prepared.decision;
    const room = conversationId ? getConversation(conversationId)! : createConversation({ title: typeof body.roomTitle === 'string' ? body.roomTitle.trim() : request.goal.slice(0,80),
      preferences: roomPreferences, stableWorkspace: true,
      mode: 'collaboration', agentIds: request.agentIds, workspace: request.workspace,
      supervisorId: request.supervisorId, defaultReviewerId: request.defaultReviewerId });
    const currentRun = createRun(request.goal, decision.execution!.engine === 'collaboration' ? 'collaboration' : 'pipeline',
      decision.execution!.participantIds, room.workspace, null, room.id, nextTurnNo(room.id), decision.execution!.participantIds.includes(request.defaultReviewerId ?? '') ? request.defaultReviewerId : null);
    const message = post({ runId: currentRun.id, from: 'user', to: request.recipientIds.join(',') || 'all', kind: 'user', body: request.goal,
      replyTo: request.replyTo, taskId: request.taskId, clientMessageId: request.clientRequestId!, deliveryStatus: 'queued',
      meta: { orchestrationSource: source, entryVersion: 1 } });
    let plan = null;
    if (prepared.plan) {
      const actors = listRunAgentSnapshots(currentRun.id);
      if (actors.length !== decision.execution!.participantIds.length) invalid('SNAPSHOT_INCOMPLETE','执行成员快照不完整');
      const planning = structuredClone(prepared.plan);
      // Previews are reusable. Each Run owns fresh plan/draft IDs and execution state.
      planning.snapshot.id = randomUUID(); planning.draft.id = randomUUID(); planning.plan.id = randomUUID();
      planning.draft.capabilitySnapshotId = planning.snapshot.id; planning.plan.capabilitySnapshotId = planning.snapshot.id;
      planning.plan.draftId = planning.draft.id;
      savePlanningResult(planning.snapshot, planning.draft, planning.plan);
      plan = activateCoordinationPlan(planning.plan.id, currentRun.id) ?? null;
      if (!plan) invalid('PLAN_ADMISSION_FAILED','无法准入已确认计划');
    }
    const frozen: RunOrchestrationSnapshot = { ...prepared, request, schemaVersion: 1, requestId: randomUUID(), runId: currentRun.id,
      conversationId: room.id, createdAt: currentRun.createdAt, submissionDigest, executionAuthority: 'orchestration',
      execution: { engine: decision.execution!.engine, planId: plan?.id ?? null, readonly: decision.execution!.readonly,
        deadlineAt: request.constraints.deadlineMs ? new Date(new Date(currentRun.createdAt).getTime() + request.constraints.deadlineMs).toISOString() : null },
      legacyExecution: { mode: currentRun.mode, agentIds: [...currentRun.agentIds], workspace: currentRun.workspace ?? null,
        supervisorId: null, defaultReviewerId: currentRun.defaultReviewerId ?? null, coordinationPlanId: plan?.id ?? null } };
    saveSubmissionSnapshot(scope, frozen); touchConversation(room.id);
    return { run: currentRun, conversation: room, message, plan, deduplicated: false };
  });
}

export function usesExecutionEntry(body: Record<string, unknown>): boolean {
  return ['entryVersion','strategy','workflow','constraints','aggregatorId','previewId','planning'].some(key => body[key] !== undefined);
}

/** Confirmed graph revision, with the original Run policy and frozen actors retained. */
export function reviseExecutionOrchestration(runId: string, value: unknown) {
  const body = objectInput(value);
  if (Object.keys(body).some(key => !['previewId','orchestrationFingerprint','instruction'].includes(key))
    || typeof body.previewId !== 'string' || typeof body.orchestrationFingerprint !== 'string'
    || typeof body.instruction !== 'string' || !body.instruction.trim()) invalid('INVALID_REVISION','修订需要 previewId、orchestrationFingerprint 和 instruction',400);
  const instruction = (body.instruction as string).trim(), confirmationDigest = stableDigest(body);
  return tx(() => {
    const accepted = get<{payload:string}>("SELECT payload FROM coordination_plan_revisions WHERE plan_id IN (SELECT id FROM coordination_plans WHERE run_id=?) AND json_extract(payload,'$.confirmationPreviewId')=?",runId,body.previewId);
    if (accepted) {
      const prior = JSON.parse(accepted.payload);
      if (prior.confirmationDigest !== confirmationDigest) invalid('REVISION_CONFIRMATION_CONFLICT','同一预览确认已用于不同修订');
      return {plan:prior.plan,draft:getCoordinationDraft(prior.plan.draftId)!};
    }
    const original = getRunOrchestrationSnapshot(runId), currentRun = getRun(runId), current = getRunCoordinationPlan(runId);
    if (!original || original.executionAuthority !== 'orchestration' || original.execution?.engine !== 'coordination' || !current || !currentRun) invalid('REVISION_UNSUPPORTED','仅统一入口的步骤图支持已确认修订');
    if (current.status !== 'paused' || currentRun.status !== 'waiting_for_user') invalid('REVISION_REQUIRES_PAUSE','请先暂停到安全步骤边界');
    assertCoordinationRecoveryReady(runId);
    if (get("SELECT 1 FROM coordination_step_attempts WHERE run_id=? AND status='running'",runId)) invalid('REVISION_REQUIRES_SAFE_BOUNDARY','仍有运行步骤，不能修订');
    const row = get<{payload:string}>('SELECT payload FROM orchestration_previews WHERE id=?',body.previewId);
    if (!row) invalid('PREVIEW_NOT_FOUND','修订预览不存在');
    const stored = JSON.parse(row.payload) as StoredPreview, candidate = stored.preview;
    if (candidate.fingerprint !== body.orchestrationFingerprint || hasErrors(candidate) || !candidate.plan) invalid('REVISION_PREVIEW_INVALID','修订预览未通过校验或未生成完整图');
    if (candidate.request.conversationId !== currentRun.conversationId || candidate.request.workspace !== (original.legacyExecution.workspace ?? original.request.workspace)
      || candidate.request.workflow !== original.request.workflow || candidate.decision.execution?.engine !== 'coordination'
      || stableDigest(candidate.request.constraints) !== stableDigest(original.request.constraints)
      || candidate.decision.execution.readonly !== original.execution.readonly) invalid('REVISION_POLICY_CONFLICT','本轮工作流、工作区、预算和读写政策已冻结；改变这些设置请创建新任务');
    if (prepare(candidate.request as unknown as Record<string,unknown>,'unified_preview').configurationFingerprint !== stored.configurationFingerprint) invalid('PREVIEW_STALE','角色、账户或聊天室在预览后发生变化');
    for (const id of candidate.decision.execution.participantIds) {
      if (!currentRun.agentIds.includes(id) || stableDigest(original.capabilities.agents.find(a=>a.id===id)) !== stableDigest(candidate.capabilities.agents.find(a=>a.id===id))) invalid('REVISION_ACTOR_CONFLICT','修订只能使用本 Run 原来冻结的成员和账户；新成员或新配置需要新任务');
    }
    // Resetting a graph must never replay already-started writes.
    if (!original.execution.readonly && get('SELECT 1 FROM coordination_step_attempts WHERE run_id=? LIMIT 1',runId)) invalid('WRITE_REVISION_REQUIRES_NEW_RUN','已有写入任务开始执行，不能用重建图重放副作用；请检查制品并创建新任务');
    const planning = structuredClone(candidate.plan);
    planning.snapshot.id = randomUUID(); planning.draft.id = randomUUID(); planning.plan.capabilitySnapshotId = planning.snapshot.id;
    planning.draft.capabilitySnapshotId = planning.snapshot.id; planning.plan.draftId = planning.draft.id;
    const revised = applyCoordinationPlanRevision({current,snapshot:planning.snapshot,draft:planning.draft,candidate:planning.plan,instruction});
    run("UPDATE coordination_plan_revisions SET payload=json_set(payload,'$.confirmationPreviewId',?,'$.confirmationDigest',?) WHERE plan_id=? AND revision=?",body.previewId,confirmationDigest,revised.id,revised.revision);
    saveCheckpoint({runId,kind:'coordination',phase:'waiting_for_user',status:'waiting',state:{planId:revised.id,revision:revised.revision,contextGoal:candidate.request.goal,reason:'confirmed_o4_revision'}});
    return {plan:revised,draft:planning.draft};
  });
}
