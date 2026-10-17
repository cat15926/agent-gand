import { randomUUID } from 'node:crypto';
import type { BusinessAuditEntry, BusinessCommand, BusinessDecision, BusinessEvidenceChoice, BusinessReport, BusinessState, RuntimeEvidenceRef } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { getRun, listRunAgentSnapshots } from '../runs/trace.ts';
import { emit } from '../messaging/bus.ts';
import { createWorkspaceFileEvidence, redactSensitive, resolveEvidence } from '../runtime/evidence.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { objectInput, OrchestrationError, stableDigest } from './normalize.ts';
import { assertStageEvidence, businessQuiescent, canAcceptStage, stageExecutionState } from './businessGates.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { checkpointSummary, readBusinessCheckpoint } from './businessCheckpointStore.ts';
import { buildArtifactSnapshot, saveArtifactSnapshot } from '../artifacts/snapshots.ts';
import { getManagedArtifact } from '../artifacts/store.ts';
import { loadRuntimeContract } from '../runtime/runPolicy.ts';

interface LedgerEvent {
  action: 'report' | 'decide' | 'resolve'; stageId?: string;
  report?: BusinessReport; decision?: BusinessDecision; resolution?: BusinessState['resolution'];
}
function fail(code: string, message: string, status = 409): never { throw new OrchestrationError(status, code, message); }
const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

function settled(runId: string, status: string): boolean {
  return terminal(status) && businessQuiescent(runId);
}

export function getBusinessState(runId: string, includeEvidence = true): BusinessState {
  const source = getRun(runId); if (!source) fail('RUN_NOT_FOUND', '任务不存在', 404);
  const contract = getRunOrchestrationSnapshot(runId)?.request.businessContract ?? null;
  const rows = all<{ version: number; payload: string }>(`SELECT version,${includeEvidence ? 'payload' : "json_set(payload,'$.report.evidence',json('[]')) AS payload"} FROM business_acceptance_events WHERE run_id=? ORDER BY version`, runId);
  const events = rows.map(row => JSON.parse(row.payload) as LedgerEvent);
  const checkpoint = readBusinessCheckpoint(runId);
  const successor = get<{ target_run_id: string }>('SELECT target_run_id FROM orchestration_run_continuations WHERE source_run_id=?', runId);
  const stages: BusinessState['stages'] = (contract?.stages ?? []).map(stage => {
    const inherited = checkpoint?.accepted.find(item => item.stageId === stage.id);
    const reports = events.filter(e => e.action === 'report' && e.stageId === stage.id);
    const report = inherited ? { ...inherited.report, evidence: includeEvidence ? inherited.report.evidence : [] } : reports.at(-1)?.report ?? null;
    const decision = inherited?.decision ?? events.find(e => e.action === 'decide' && e.decision?.reportId === report?.id)?.decision ?? null;
    return { stage, report, decision, ...(contract?.executionMode === 'stage_gated' ? { execution: stageExecutionState(runId, stage) } : {}), status: decision?.verdict === 'accept' ? 'accepted' : decision ? 'rejected'
      : report?.kind === 'delivery' ? 'awaiting_acceptance' : report ? 'acknowledged' : 'pending' };
  });
  stages.forEach((stage, index) => { if (!stage.report && stages.slice(0, index).some(previous => previous.status !== 'accepted')) stage.status = 'blocked'; });
  const resolution = events.find(e => e.action === 'resolve')?.resolution ?? null;
  const isSettled = settled(runId, source.status);
  const outcome: BusinessState['outcome'] = resolution?.outcome ?? (!contract ? 'unverified'
    : stages.every(s => s.status === 'accepted') ? 'achieved'
    : stages.some(s => s.execution?.canAccept) ? 'awaiting_acceptance'
    : !terminal(source.status) || !isSettled ? 'in_progress' : 'awaiting_acceptance');
  return { runId, version: rows.at(-1)?.version ?? 0, contract, outcome, settled: isSettled, stages, resolution,
    ...(checkpoint ? { checkpoint: checkpointSummary(checkpoint) } : {}), ...(successor ? { successorRunId: successor.target_run_id } : {}) };
}

export function businessSummary(runId: string) {
  const state = getBusinessState(runId, false);
  return { version: state.version, outcome: state.outcome, contractPresent: Boolean(state.contract),
    acceptedStages: state.stages.filter(s => s.status === 'accepted').length, totalStages: state.stages.length };
}

function parseRef(value: unknown): RuntimeEvidenceRef {
  const raw = objectInput(value);
  if (raw.kind === 'message' || raw.kind === 'attempt_output') {
    if (Object.keys(raw).some(k => !['kind', 'id'].includes(k)) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 100) fail('INVALID_EVIDENCE', '消息或输出证据标识无效', 400);
    return { kind: raw.kind, id: raw.id };
  }
  if (raw.kind === 'workspace_file') {
    if (Object.keys(raw).some(k => !['kind', 'path', 'sha256', 'workspaceScope','artifactId','artifactVersion'].includes(k)) || typeof raw.path !== 'string' || !raw.path || raw.path.length > 500
      || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)
      || raw.artifactId !== undefined && (typeof raw.artifactId !== 'string' || raw.artifactId.length > 100 || !Number.isSafeInteger(raw.artifactVersion) || (raw.artifactVersion as number)<1)
      || raw.artifactVersion !== undefined && raw.artifactId === undefined
      || raw.workspaceScope !== undefined && (typeof raw.workspaceScope !== 'string' || raw.workspaceScope.length > 100)) fail('INVALID_EVIDENCE', '文件证据无效', 400);
    return raw as unknown as RuntimeEvidenceRef;
  }
  return fail('INVALID_EVIDENCE', '交付证据只支持本任务的成员消息、已完成输出及工作区文件', 400);
}

function deliveryEvidence(runId: string, ref: RuntimeEvidenceRef, kind: 'text' | 'file') {
  if ((kind === 'file') !== (ref.kind === 'workspace_file')) fail('DELIVERABLE_KIND_MISMATCH', '交付项与证据类型不一致');
  if (ref.kind === 'message') {
    const message = get<{ kind: string; from_agent: string }>('SELECT kind,from_agent FROM messages WHERE id=?', ref.id);
    if (message?.kind !== 'agent' || !getRun(runId)?.agentIds.includes(message.from_agent)) fail('AGENT_DELIVERY_REQUIRED', '用户需求、系统状态或非本任务成员不能作为交付');
  }
  const resolved = resolveEvidence(runId, ref, 'user');
  if (!resolved.trusted || !resolved.contentSha256 || !resolved.excerpt?.trim()) fail('DELIVERY_UNTRUSTED', resolved.reason ?? '交付证据为空或未完成');
  if (kind === 'text' && /^(收到|已收到|确认收到|好的|明白|准备好了|ok|ack|acknowledged|ready)[\s.!！。]*$/iu.test(resolved.excerpt.trim())) fail('RECEIPT_IS_NOT_DELIVERY', '此输出仅确认收到，不能替代实质交付');
  return resolved;
}

/** Owner-only ledger boundary. The HTTP/recovery scheduler wakes an accepted nonterminal gate. */
export function applyBusinessCommand(runId: string, value: unknown): BusinessState {
  const raw = objectInput(value);
  const common = ['action', 'expectedVersion', 'clientRequestId'];
  const fields = raw.action === 'report' ? ['stageId', 'kind', 'note', 'evidence'] : raw.action === 'decide' ? ['stageId', 'reportId', 'verdict', 'checkedCriteria', 'reason'] : raw.action === 'resolve' ? ['outcome', 'reason'] : [];
  if (!fields.length || Object.keys(raw).some(k => ![...common, ...fields].includes(k)) || !Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 0
    || typeof raw.clientRequestId !== 'string' || raw.clientRequestId.length < 8 || raw.clientRequestId.length > 100) fail('INVALID_BUSINESS_COMMAND', '验收操作、版本或请求标识无效', 400);
  const command = raw as unknown as BusinessCommand;
  const digest = stableDigest(raw);
  return tx(() => {
    const duplicate = get<{ command_digest: string }>('SELECT command_digest FROM business_acceptance_events WHERE run_id=? AND client_request_id=?', runId, command.clientRequestId);
    if (duplicate) { if (duplicate.command_digest !== digest) fail('IDEMPOTENCY_CONFLICT', '同一请求标识已用于不同验收操作'); return getBusinessState(runId); }
    if (get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?', runId)) fail('SOURCE_CONTINUED', '本轮已建立关联续跑，原验收账本保持不变；请在后续任务处理剩余阶段');
    const state = getBusinessState(runId);
    if (!state.contract) fail('BUSINESS_CONTRACT_REQUIRED', '本任务没有冻结阶段验收清单；执行结束仍为目标未验收');
    if (state.version !== command.expectedVersion) fail('BUSINESS_STATE_STALE', '验收记录已改变，请刷新后重试');
    if (state.resolution || state.outcome === 'achieved') fail('BUSINESS_OUTCOME_FINAL', '业务结果已确定，不能改写；补充事项请新建任务');
    const now = new Date().toISOString();
    const text = (value: unknown, required = false) => {
      if (typeof value !== 'string' || value.length > 2000 || required && !value.trim()) fail('INVALID_BUSINESS_NOTE', '说明应为不超过 2000 字的文本，拒绝或结束时不可为空', 400);
      return value.trim();
    };
    let event: LedgerEvent;
    if (command.action === 'resolve') {
      if (!['not_achieved', 'partial_accepted', 'user_ended'].includes(command.outcome)) fail('INVALID_BUSINESS_OUTCOME', '业务结果无效', 400);
      if (!state.settled) fail('EXECUTION_NOT_SETTLED', '请先取消或等待执行结束，并核对未知工具或进程结果');
      if (command.outcome === 'partial_accepted' && !state.stages.some(s => s.status === 'accepted')) fail('ACCEPTED_STAGE_REQUIRED', '接受部分结果至少需要一个已验收阶段');
      event = { action: 'resolve', resolution: { outcome: command.outcome, reason: text(command.reason, true), createdAt: now } };
    } else {
      const current = state.stages.find(s => s.stage.id === command.stageId);
      if (!current) fail('STAGE_NOT_FOUND', '阶段不属于本任务', 400);
      if (current.status === 'accepted') fail('STAGE_ALREADY_ACCEPTED', '已验收阶段不可改写');
      const gated = state.contract.executionMode === 'stage_gated';
      const stageReady = gated ? canAcceptStage(runId, current.stage.id) : state.settled;
      if (gated && state.stages.slice(0, state.stages.indexOf(current)).some(s => s.status !== 'accepted')) fail('PREVIOUS_STAGE_REQUIRED', '请先完成并验收前置阶段，不能提前登记后续阶段');
      if (command.action === 'report') {
        if (!['receipt', 'delivery'].includes(command.kind) || !Array.isArray(command.evidence) || command.evidence.length > 12) fail('INVALID_BUSINESS_REPORT', '交付登记格式无效', 400);
        if (command.kind === 'receipt' && command.evidence.length) fail('INVALID_BUSINESS_REPORT', '确认收到不能登记交付证据', 400);
        if (command.kind === 'delivery' && !stageReady) fail('EXECUTION_NOT_SETTLED', '交付登记需等待当前阶段到达验收边界并收敛进程和工具结果');
        if (current.report && !current.decision) fail('REPORT_PENDING_DECISION', '请先拒绝当前交付候选，再登记替代交付');
        const evidence = command.evidence.map(value => {
          const item = objectInput(value);
          if (Object.keys(item).some(k => !['deliverableId', 'ref'].includes(k))) fail('INVALID_EVIDENCE', '交付证据包含未知字段', 400);
          const required = current.stage.deliverables.find(d => d.id === item.deliverableId);
          if (!required) fail('DELIVERABLE_NOT_FOUND', '交付项不属于当前阶段', 400);
          const ref = parseRef(item.ref);
          if (gated) assertStageEvidence(runId, current.stage.id, ref);
          return { deliverableId: required.id, resolution: deliveryEvidence(runId, ref, required.kind) };
        });
        if (new Set(evidence.map(e => e.deliverableId)).size !== evidence.length) fail('DUPLICATE_DELIVERABLE', '每个交付项只能登记一个证据', 400);
        event = { action: 'report', stageId: current.stage.id, report: { id: randomUUID(), stageId: current.stage.id, kind: command.kind, note: text(command.note), evidence, createdAt: now } };
      } else {
        const report = current.report;
        if (!report || report.id !== command.reportId || current.decision) fail('REPORT_STALE', '候选交付已改变或已处理');
        if (!['accept', 'reject'].includes(command.verdict) || !Array.isArray(command.checkedCriteria)
          || command.checkedCriteria.some(i => !Number.isSafeInteger(i) || i < 0 || i >= current.stage.criteria.length)
          || new Set(command.checkedCriteria).size !== command.checkedCriteria.length) fail('INVALID_BUSINESS_DECISION', '验收决定或标准无效', 400);
        if (command.verdict === 'accept') {
          if (!stageReady) fail('EXECUTION_NOT_SETTLED', '阶段未到达验收边界或存在未知结果，不能验收');
          if (report.kind !== 'delivery') fail('RECEIPT_IS_NOT_DELIVERY', '确认收到不能验收为完成');
          if (state.stages.slice(0, state.stages.indexOf(current)).some(s => s.status !== 'accepted')) fail('PREVIOUS_STAGE_REQUIRED', '请先验收前置阶段');
          if (command.checkedCriteria.length !== current.stage.criteria.length) fail('CRITERIA_UNCHECKED', '必须逐项确认全部验收标准');
          for (const required of current.stage.deliverables) {
            const saved = report.evidence.find(e => e.deliverableId === required.id)?.resolution;
            if (!saved) fail('REQUIRED_DELIVERY_MISSING', `缺少必要交付：${required.title}`);
            if (gated) assertStageEvidence(runId, current.stage.id, saved.ref);
            const fresh = deliveryEvidence(runId, saved.ref, required.kind);
            if (fresh.contentSha256 !== saved.contentSha256) fail('DELIVERY_CHANGED', '交付证据在登记后发生变化，请拒绝旧候选并重新登记');
          }
        }
        event = { action: 'decide', stageId: current.stage.id, decision: { reportId: report.id, verdict: command.verdict,
          checkedCriteria: command.checkedCriteria, reason: text(command.reason, command.verdict === 'reject'), createdAt: now } };
      }
    }
    run('INSERT INTO business_acceptance_events (id,run_id,version,client_request_id,command_digest,payload,created_at) VALUES (?,?,?,?,?,?,?)', randomUUID(), runId, state.version + 1, command.clientRequestId, digest, JSON.stringify(event), now);
    if (event.action==='decide' && event.decision?.verdict==='accept') {
      // Freeze acceptance and recoverable evidence atomically before the next stage can edit it.
      saveArtifactSnapshot(buildArtifactSnapshot(runId,{stageIds:[event.stageId!]}),'acceptance',runId+':'+(state.version+1));
    }
    afterCommit(() => { const source = getRun(runId); if (source) emit({ type: 'run.updated', run: source }); });
    return getBusinessState(runId);
  });
}

export function listBusinessEvidence(runId: string): BusinessEvidenceChoice[] {
  const state = getBusinessState(runId, false); // Single-owner audit view; verify Run existence.
  if (state.contract?.executionMode === 'stage_gated') {
    const plan = getRunCoordinationPlan(runId);
    if (!plan) return [];
    const names = new Map(listRunAgentSnapshots(runId).map(a => [a.id, a.name]));
    const imported = readBusinessCheckpoint(runId)?.outputs.flatMap(output => {
      const ref: RuntimeEvidenceRef = { kind: 'attempt_output', id: output.attemptId };
      const evidence = resolveEvidence(runId, ref, 'user');
      return evidence.trusted && evidence.excerpt?.trim() ? [{ ref, stageId: output.stageId, label: `复用输出 · ${names.get(output.agentId) ?? output.agentId} · 原任务 ${output.sourceRunId}`, excerpt: evidence.excerpt }] : [];
    }) ?? [];
    return [...imported, ...all<{ id: string; step_id: string; created_at: string }>("SELECT id,step_id,created_at FROM coordination_step_attempts WHERE run_id=? AND plan_id=? AND revision=? AND status='completed' AND output IS NOT NULL ORDER BY created_at DESC LIMIT 100", runId, plan.id, plan.revision)
      .flatMap(row => {
        const step = plan.steps.find(s => s.id === row.step_id && s.agentId);
        const stage = state.contract!.stages.find(s => s.id === step?.metadata.businessStageId);
        if (!step?.agentId || !stage) return [];
        const ref: RuntimeEvidenceRef = { kind: 'attempt_output', id: row.id };
        const evidence = resolveEvidence(runId, ref, 'user');
        const choices: BusinessEvidenceChoice[] = evidence.trusted && evidence.excerpt?.trim() ? [{ ref, stageId: stage.id, label: `${stage.title} · ${names.get(step.agentId) ?? step.agentId} · ${row.created_at}`, excerpt: evidence.excerpt }] : [];
        for (const file of loadRuntimeContract(runId)?.features?.coordinationScopes===2?all<{id:string}>("SELECT id FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,'$.attemptId')=? ORDER BY version DESC",runId,row.id):[]) {
          try {
            const artifact=getManagedArtifact(file.id,'user');
            if(artifact.stageId!==stage.id||artifact.createdBy!==step.agentId)continue;
            const ref:RuntimeEvidenceRef={kind:'workspace_file',path:artifact.path,sha256:artifact.sha256,artifactId:artifact.id,artifactVersion:artifact.version};
            const resolved=resolveEvidence(runId,ref,'user');
            if(resolved.trusted&&resolved.excerpt?.trim())choices.push({ref,stageId:stage.id,label:`${stage.title} · ${artifact.path} · v${artifact.version}`,excerpt:resolved.excerpt});
          } catch { /* Unavailable or tampered artifacts cannot become evidence. */ }
        }
        return choices;
      })];
  }
  const messages = all<{ id: string; from_agent: string; created_at: string }>("SELECT id,from_agent,created_at FROM messages WHERE run_id=? AND kind='agent' ORDER BY created_at DESC LIMIT 100", runId);
  const members = new Set(getRun(runId)?.agentIds);
  const attempts = all<{ id: string; agent_id: string; created_at: string }>(`SELECT id,agent_id,created_at FROM (
    SELECT id,agent_id,created_at FROM collaboration_attempts WHERE run_id=? AND status='completed' AND output IS NOT NULL
    UNION ALL SELECT id,'步骤 ' || step_id AS agent_id,created_at FROM coordination_step_attempts WHERE run_id=? AND status='completed' AND output IS NOT NULL
    UNION ALL SELECT id,agent_id,created_at FROM task_attempts WHERE run_id=? AND status='completed' AND output IS NOT NULL
    ) ORDER BY created_at DESC LIMIT 100`, runId, runId, runId);
  return [...messages.filter(row => members.has(row.from_agent)).map(row => ({ ref: { kind: 'message', id: row.id } as RuntimeEvidenceRef, label: `消息 · ${row.from_agent} · ${row.created_at}` })),
    ...attempts.map(row => ({ ref: { kind: 'attempt_output', id: row.id } as RuntimeEvidenceRef, label: `完成输出 · ${row.agent_id} · ${row.created_at}` }))]
    .flatMap(choice => { const evidence = resolveEvidence(runId, choice.ref, 'user'); return evidence.trusted && evidence.excerpt?.trim() ? [{ ...choice, excerpt: evidence.excerpt }] : []; });
}

export function businessHistory(runId: string): BusinessAuditEntry[] {
  if (!getRun(runId)) fail('RUN_NOT_FOUND', '任务不存在', 404);
  return all<{ id: string; version: number; created_at: string; payload: string }>('SELECT * FROM business_acceptance_events WHERE run_id=? ORDER BY version DESC LIMIT 100', runId)
    .map(row => ({ id: row.id, version: row.version, createdAt: row.created_at, ...JSON.parse(row.payload) as LedgerEvent }));
}

export function businessFileEvidence(runId: string, value: unknown): BusinessEvidenceChoice {
  const raw = objectInput(value); const state = getBusinessState(runId);
  if (state.successorRunId) fail('SOURCE_CONTINUED', '本轮已建立后续任务，原验收账本保持不变');
  const gated = state.contract?.executionMode === 'stage_gated';
  if (!state.contract || (gated ? typeof raw.stageId !== 'string' || !canAcceptStage(runId, raw.stageId) : !state.settled) || state.resolution || state.outcome === 'achieved') fail('FILE_EVIDENCE_UNAVAILABLE', '文件证据需要到达阶段验收边界，且执行、进程和工具结果已收敛');
  if (Object.keys(raw).some(k => !['path', 'stageId'].includes(k)) || typeof raw.path !== 'string' || !raw.path.trim() || raw.path.length > 500) fail('INVALID_FILE_PATH', '请提供当前任务工作区的相对文件路径', 400);
  try {
    const ref = createWorkspaceFileEvidence(runId, raw.path, gated ? getRunCoordinationPlan(runId)!.id.slice(0, 8) : undefined);
    const resolved = resolveEvidence(runId, ref, 'user');
    return { ref, label: `文件 · ${raw.path}`, excerpt: redactSensitive(resolved.excerpt ?? ''), ...(gated ? { stageId: raw.stageId as string } : {}) };
  } catch (error) { return fail('INVALID_FILE_EVIDENCE', error instanceof Error ? error.message : '文件不可引用', 400); }
}
