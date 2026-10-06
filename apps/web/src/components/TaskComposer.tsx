import { useEffect, useRef, useState } from 'react';
import type { Conversation, Message, OrchestrationPreview, OrchestrationPreviewInput, RoomPreferences } from '@agent-gand/shared';
import { useStore } from '../store';
import * as api from '../services/api';
import { clearRoomDraft, emptyPreferences, readRoomDraft, recoveryDraftText, writeRoomDraft } from '../services/roomDraft';
import { WorkspacePanel } from './WorkspacePanel';

export const STRATEGY_LABEL = { auto: '自动', parallel: '并行分析', serial: '顺序接力', single: '单成员协作' };
export const WORKFLOW_LABEL = { routine: '常规协作', analysis_summary: '分析与汇总', development_review: '开发与评审', supervisor_decomposition: '主管拆解', bounded_debate: '固定轮次辩论' };
export const taskLabel = (snapshot: api.TaskState['snapshot'], legacy: string) => snapshot?.executionAuthority === 'orchestration' ? `${STRATEGY_LABEL[snapshot.decision.effectiveStrategy]} · ${WORKFLOW_LABEL[snapshot.decision.workflow]}` : `历史任务 · ${{ collaboration: '自由协作', pipeline: '顺序流水线', supervisor: '主管委派' }[legacy] ?? legacy}`;
const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40';
const primary = 'rounded-lg bg-violet-500 px-4 py-2 text-xs text-white disabled:opacity-40';

export function PlanPreview({ preview, children }: { preview: OrchestrationPreview; children?: React.ReactNode }) {
  const { state } = useStore();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => { heading.current?.scrollIntoView({ block: 'nearest' }); heading.current?.focus({ preventScroll: true }); }); return () => cancelAnimationFrame(frame); }, [preview.previewId]);
  const names = (ids: string[]) => ids.map(id => state.agents.find(a => a.id === id)?.name ?? id).join('、');
  return <section aria-label="本轮计划" className="mt-3 min-w-0 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3 text-xs [overflow-wrap:anywhere]">
    <h3 ref={heading} tabIndex={-1} className="font-medium text-violet-200">{STRATEGY_LABEL[preview.decision.effectiveStrategy]} · {WORKFLOW_LABEL[preview.decision.workflow]}</h3>
    <p className="mt-2 text-zinc-400">{preview.decision.reason}</p>
    <p className="mt-2">执行：{names(preview.decision.targetIds)} · {preview.decision.execution?.readonly ? '只读' : '按角色权限执行写入'}</p>
    <p className="mt-1 text-zinc-500">{preview.planning?.kind === 'detailed' ? `详细规划 · ${preview.planning.calls} 次模型请求 · 输入/输出 ${preview.planning.tokensIn}/${preview.planning.tokensOut} tokens` : '规则预览 · 未调用模型'} · 工作区：{preview.request.workspace ?? '自动工作区'}</p>
    <details className="mt-2 text-zinc-500"><summary className="cursor-pointer">成员能力与账户配置</summary><ul className="mt-2 space-y-1">{preview.capabilities.agents.map(a => <li key={a.id}>{a.name} · {a.capabilities.map(c => ({ execute: '执行', review: '评审', coordinate: '协调' }[c] ?? c)).join(' / ')} · {a.driver} · 配置：{a.account.configuration} · 模型测试：{a.account.modelTest}</li>)}</ul><p className="mt-1">配置预检不代表模型已测试成功。</p></details>
    {preview.request.constraints.maxTokens && <p className="mt-1">本任务输出 tokens 硬上限：{preview.request.constraints.maxTokens}（输入和费用另计）</p>}
    {preview.request.constraints.deadlineMs && <p className="mt-1">提交后执行时限：{preview.request.constraints.deadlineMs / 1000} 秒</p>}
    {preview.decision.issues.map((issue, index) => <p role={issue.severity === 'error' ? 'alert' : 'status'} key={index} className={`mt-2 ${issue.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{issue.message}</p>)}
    {preview.plan && <ol className="mt-3 max-h-52 space-y-2 overflow-y-auto rounded bg-zinc-950/50 p-2">{preview.plan.plan.steps.map((step, index) => <li key={step.id}><span className="text-zinc-300">{index + 1}. {typeof step.metadata.title === 'string' ? step.metadata.title : step.completion}</span>{typeof step.metadata.objective === 'string' && <p className="mt-1 whitespace-pre-wrap text-zinc-400">{step.metadata.objective}</p>}{Array.isArray(step.metadata.acceptanceCriteria) && <p className="mt-1 text-zinc-400">验收：{step.metadata.acceptanceCriteria.join('；')}</p>}<p className="mt-0.5 text-zinc-500">{step.agentId ? names([step.agentId]) : '完成检查'}{step.dependsOn.length > 0 ? ` · 等待：${step.dependsOn.map(id => { const dependency = preview.plan!.plan.steps.find(item => item.id === id); return dependency?.metadata.title ?? `步骤 ${preview.plan!.plan.steps.findIndex(item => item.id === id) + 1}`; }).join('、')}` : ' · 无前置依赖'}</p></li>)}</ol>}
    {preview.decision.execution?.plannerRequired && !preview.plan && <p className="mt-2 text-amber-200">先点击“生成详细计划”得到实际任务与依赖，再确认执行。</p>}
    {children}
  </section>;
}

/** One per-turn composer for first task, later tasks and confirmed safe revisions. */
export function TaskComposer({ room, reply, onReplyClear, onManageRoles, reservations = [], revisionTask, onRevisionClose }: {
  room?: Conversation; reply?: Message | null; onReplyClear?: () => void; onManageRoles?: () => void;
  reservations?: api.MemberReservation[]; revisionTask?: api.TaskState | null; onRevisionClose?: () => void;
}) {
  const { state, setActiveConversation, refreshConversation } = useStore();
  const [draft] = useState(() => room ? null : readRoomDraft());
  const [taskDraft] = useState(() => { try {
    const value = room ? JSON.parse(sessionStorage.getItem(`gand:task-draft:${room.id}`) ?? 'null') : null;
    return value && typeof value.goal === 'string' && Array.isArray(value.targets) && value.targets.every((id: unknown) => typeof id === 'string') && ['auto','parallel','serial'].includes(value.prefs?.strategy) && ['routine','analysis_summary','development_review','supervisor_decomposition','bounded_debate'].includes(value.prefs?.workflow) && value.prefs.constraints && typeof value.prefs.constraints === 'object' ? value as { goal: string; targets: string[]; prefs: RoomPreferences } : null;
  } catch { return null; } });
  const frozen = revisionTask?.snapshot;
  const defaults = frozen ? { strategy: frozen.request.strategy, workflow: frozen.request.workflow, constraints: frozen.request.constraints, supervisorId: frozen.request.supervisorId, defaultReviewerId: frozen.request.defaultReviewerId, aggregatorId: frozen.request.aggregatorId } : taskDraft?.prefs ?? room?.preferences ?? draft ?? emptyPreferences();
  const [prefs, setPrefs] = useState<RoomPreferences>(defaults);
  const [goal, setGoal] = useState(revisionTask?.revisedGoal ?? frozen?.request.goal ?? taskDraft?.goal ?? draft?.goal ?? '');
  const [title, setTitle] = useState(draft?.title ?? '');
  const [useAsDefault,setUseAsDefault] = useState(false);
  const [team, setTeam] = useState<string[]>(room?.agentIds ?? draft?.selected ?? state.agents.map(a => a.id));
  const initialized = useRef(Boolean(room || draft || state.agents.length));
  const [targets, setTargets] = useState<string[]>(frozen?.decision.targetIds ?? taskDraft?.targets ?? draft?.initialTargets ?? []);
  const [workspace, setWorkspace] = useState(frozen?.legacyExecution.workspace ?? room?.workspace ?? draft?.workspace ?? '');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [preview, setPreview] = useState<OrchestrationPreview | null>(null);
  const [admission,setAdmission] = useState<api.OrchestrationAdmission | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(draft?.recoveryNotice ?? '');
  const epoch = useRef(0); const clientId = useRef(crypto.randomUUID());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { void api.getOrchestrationOptions().then(value => { if (alive.current) setAdmission(value.admission); }).catch(() => { /* Submission remains server-authoritative. */ }); }, []);
  useEffect(() => { if (!initialized.current && state.agents.length) { setTeam(state.agents.map(a => a.id)); initialized.current = true; } }, [state.agents]);
  function invalidate() { epoch.current++; setPreview(null); setError(''); clientId.current = crypto.randomUUID(); }
  function changePrefs(value: Partial<RoomPreferences>) { invalidate(); setPrefs(p => ({ ...p, ...value })); }
  useEffect(() => { if (!room) writeRoomDraft({ ...prefs, version: 2, goal, title, selected: team, initialTargets: targets, workspace, ...(draft?.legacyMode ? { legacyMode: draft.legacyMode } : {}) }); }, [room, prefs, goal, title, team, targets, workspace, draft]);
  useEffect(() => { if (room && !revisionTask) { try { sessionStorage.setItem(`gand:task-draft:${room.id}`,JSON.stringify({ goal, targets, prefs })); } catch { /* Live draft stays usable. */ } } }, [room, revisionTask, goal, targets, prefs]);
  useEffect(() => { invalidate(); }, [room?.membersVersion, state.agents, reply?.id]); // A role/account edit cannot retain confirmation.
  const teamIds = room?.agentIds ?? team;
  const candidates = state.agents.filter(a => teamIds.includes(a.id));
  const executors = candidates.filter(a => a.capabilities.includes('execute'));
  const readonlyCli = targets.some(id => candidates.some(a => a.id === id && a.execution?.kind === 'external' && ['claude-cli','codex-exec'].includes(a.execution.driver)));
  const strategyIssue = readonlyCli && (prefs.strategy !== 'serial' || prefs.constraints.readonly !== true) ? '只读 CLI 对象需要显式选择“顺序接力”和只读约束。' : prefs.strategy === 'parallel' && (prefs.constraints.readonly === false || ['development_review','bounded_debate'].includes(prefs.workflow)) ? '当前工作流或写入约束与并行分析不兼容，请调整本轮选择。' : '';
  const decision = reply ? state.collaborationDecisions.find(d => d.promptMessageId === reply.id && d.status === 'pending' && d.kind === 'agent_question') : null;
  const input = (): OrchestrationPreviewInput => ({ goal: goal.trim(), agentIds: teamIds, recipientIds: targets, strategy: prefs.strategy, workflow: prefs.workflow,
    constraints: { ...prefs.constraints, ...(['analysis_summary','bounded_debate'].includes(prefs.workflow) ? { readonly: true } : {}), ...(prefs.workflow === 'bounded_debate' ? { rounds: prefs.constraints.rounds ?? 2 } : {}) },
    workspace: workspace || null, supervisorId: prefs.supervisorId, defaultReviewerId: prefs.defaultReviewerId, aggregatorId: prefs.aggregatorId,
    ...(room ? { conversationId: room.id } : {}), ...(revisionTask ? { revisionRunId: revisionTask.runId } : {}), ...(reply && !revisionTask ? { replyTo: reply.id, taskId: reply.taskId } : {}) });
  const blocked = !goal.trim() || teamIds.length === 0 || Boolean(strategyIssue) || busy;
  async function plan(detailed = false) {
    if (blocked) return;
    const revision = epoch.current; setBusy(true); setError('');
    try { const value = await api.previewOrchestration({ ...input(), planning: detailed ? 'detailed' : 'rules' }); if (alive.current && revision === epoch.current) setPreview(value); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  function reset() { setGoal(''); setTargets([]); setPreview(null); setPrefs(room?.preferences ?? emptyPreferences()); setWorkspace(room?.workspace ?? ''); clientId.current = crypto.randomUUID(); onReplyClear?.(); }
  async function send(confirm = false) {
    if (blocked) return;
    const revision = epoch.current; setBusy(true); setError('');
    try {
      if (decision) { await api.resolveCollaborationDecision(decision.id, { action: 'answer', message: goal.trim() }); reset(); await refreshConversation(); return; }
      const value = preview ?? await api.previewOrchestration({ ...input(), planning: 'rules' });
      if (!alive.current || revision !== epoch.current) return;
      setPreview(value);
      if (value.decision.issues.some(i => i.severity === 'error') || value.decision.execution?.plannerRequired && !value.plan) return;
      if ((value.decision.requiresConfirmation || revisionTask) && !confirm) return;
      if (revisionTask) { await api.reviseTaskPlan(revisionTask.runId, value, goal.trim()); await refreshConversation(); onRevisionClose?.(); setNotice('计划已修订，仍保持暂停；确认后在任务卡中恢复。'); return; }
      const created = await api.submitTask({ ...input(), clientRequestId: clientId.current, entryVersion: 1, previewId: value.previewId, orchestrationFingerprint: value.fingerprint,
        ...(!room ? { ...(title.trim() ? { roomTitle: title.trim() } : {}), roomPreferences: useAsDefault ? { ...prefs, constraints: input().constraints ?? {} } : emptyPreferences() } : {}) });
      if (!room) { clearRoomDraft(); setActiveConversation(created.conversation.id); }
      else { reset(); setNotice('任务已提交。下一轮已恢复房间默认偏好。'); await refreshConversation(); }
    } catch (reason) { if (alive.current) { if (reason instanceof api.ApiError && reason.code === 'PREVIEW_STALE') { setPreview(null); clientId.current = crypto.randomUUID(); } setError(reason instanceof Error ? reason.message : String(reason)); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function emptyRoom() {
    if (busy || !teamIds.length || !title.trim()) return; setBusy(true); setError('');
    try { const created = await api.createEmptyRoom({ title: title.trim(), agentIds: teamIds, workspace: workspace || null, preferences: useAsDefault ? { ...prefs, constraints: input().constraints ?? {} } : emptyPreferences() });
      if (goal.trim()) try { sessionStorage.setItem(`gand:task-draft:${created.conversation.id}`, JSON.stringify({ goal, targets, prefs })); } catch { /* Browser storage may be unavailable. */ }
      clearRoomDraft(); setActiveConversation(created.conversation.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function saveDefaults() {
    if (!room || busy) return; setBusy(true); setError('');
    try { await api.saveRoomPreferences(room.id, { ...prefs, constraints: input().constraints ?? {} }, room.membersVersion); await refreshConversation(); setNotice('默认偏好已保存，仅用于之后的新任务。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  const roleSelect = (label: string, field: 'supervisorId' | 'defaultReviewerId' | 'aggregatorId', roles = candidates) => <label className="min-w-0 text-xs text-zinc-400">{label}<select disabled={busy || Boolean(revisionTask)} aria-label={label} className="input mt-1 text-xs" value={prefs[field] ?? ''} onChange={e => changePrefs({ [field]: e.target.value || null })}><option value="">{field === 'supervisorId' ? '自动选可用主管' : '不选择'}</option>{roles.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>;
  return <div data-testid="task-composer" className={`mx-auto w-full min-w-0 max-w-3xl ${room ? 'p-3' : 'px-4 py-6 sm:px-6'}`}>
    {!room && <div className="mb-5"><h2 className="text-lg font-semibold">创建聊天室</h2><p className="mt-1 text-xs text-zinc-500">房间保存候选团队与工作区；每个任务独立选择执行方式。</p>{onManageRoles && <button type="button" className="mt-2 text-xs text-violet-300" onClick={onManageRoles}>＋ 创建或管理角色</button>}</div>}
    {notice && <div role="status" className="mb-3 rounded-lg bg-sky-500/10 p-2 text-xs text-sky-200">{notice}{draft?.recoveryNotice && recoveryDraftText() && <details className="mt-2"><summary>查看保留的草稿内容</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{recoveryDraftText()}</pre></details>}</div>}
    {room?.preferencesOrigin === 'legacy_mapping' && !revisionTask && <p role="status" className="mb-3 text-xs text-sky-200">已将原房间偏好转换为「{STRATEGY_LABEL[room.preferences?.strategy ?? 'auto']} · {WORKFLOW_LABEL[room.preferences?.workflow ?? 'routine']}」，只影响新任务。{room.preferences?.workflow === 'supervisor_decomposition' && '主管拆解需要可用的模型 API 主管，请先预览检查配置。'}</p>}
    {room?.preferencesIssue && <p role="alert" className="mb-3 text-xs text-amber-200">{room.preferencesIssue}</p>}
    {admission && admission.entryMode !== 'execute' && !decision && !revisionTask && <p role="status" className="mb-3 text-xs text-amber-200">新任务入口{admission.entryMode === 'preview' ? '当前仅供预览' : '已关闭'}。已有任务的审批、暂停、继续和取消仍可使用。</p>}
    {!room && <><label className="text-xs text-zinc-400">房间名称（仅创建房间时必填）<input aria-label="房间名称" maxLength={80} className="input mt-1 mb-3 text-sm" disabled={busy} value={title} onChange={e => { setTitle(e.target.value); clientId.current = crypto.randomUUID(); }} placeholder="例如：项目研发团队" /></label>
      <fieldset aria-label="舰队成员" className="mb-4 min-w-0"><legend className="text-xs text-zinc-400">候选团队 · 已选择 {team.length} 位</legend><div className="mt-2 flex flex-wrap gap-2">{state.agents.map(a => <button type="button" key={a.id} aria-pressed={team.includes(a.id)} className={button} disabled={busy} style={{ color: team.includes(a.id) ? a.color : '#71717a', outline: team.includes(a.id) ? `1px solid ${a.color}` : undefined }} onClick={() => { invalidate(); setTeam(ids => ids.includes(a.id) ? ids.filter(id => id !== a.id) : [...ids,a.id]); setTargets(ids => ids.filter(id => id !== a.id)); }}>{a.name}</button>)}</div></fieldset></>}
    <section className="min-w-0 rounded-xl bg-zinc-900 p-3 ring-1 ring-zinc-700">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><strong className="text-violet-200">{decision ? '回答并继续原任务' : revisionTask ? `补充当前任务 · 修订第 ${state.runs.find(r => r.id === revisionTask.runId)?.turnNo ?? ''} 轮` : '新任务'}</strong>{revisionTask && <button disabled={busy} onClick={onRevisionClose} className={button}>返回新任务</button>}</div>
      {reply && !revisionTask && <div className="mb-2 flex min-w-0 gap-2 text-xs text-zinc-500"><span className="min-w-0 flex-1 truncate">引用：{reply.body}</span><button aria-label="取消引用" disabled={busy} onClick={() => { invalidate(); onReplyClear?.(); }}>×</button></div>}
      {!decision && <fieldset aria-label="本轮对象" className="mb-2"><legend className="text-xs text-zinc-500">本轮对象 · 不选则自动路由，或在目标开头用 @名称 指定</legend><div className="mt-2 flex flex-wrap gap-1">{executors.map(a => { const queued = reservations.filter(t => t.agentId === a.id && t.status === 'waiting').length; const active = reservations.find(t => t.agentId === a.id && ['active','interrupted'].includes(t.status)); return <button type="button" key={a.id} aria-pressed={targets.includes(a.id)} disabled={busy || Boolean(revisionTask)} className={`${button} ${targets.includes(a.id) ? 'ring-1 ring-violet-400' : ''}`} onClick={() => { invalidate(); setTargets(ids => ids.includes(a.id) ? ids.filter(id => id !== a.id) : [...ids,a.id]); }} title={active ? `忙碌：${state.runs.find(r => r.id === active.runId)?.goal ?? active.runId}` : '可用'}>@{a.name}{active ? ' · 忙碌' : ''}{queued ? ` · 排队 ${queued}` : ''}</button>; })}</div></fieldset>}
      <textarea id="goal-input" aria-label={decision ? '回答内容' : '任务目标'} disabled={busy} value={goal} rows={room ? 3 : 5} onChange={e => { invalidate(); setGoal(e.target.value); }} placeholder={decision ? '回答此任务的问题…' : '描述本轮目标；Enter 发送，Shift+Enter 换行…'} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(false); } }} className="w-full min-w-0 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-zinc-600" />
      {!decision && <><div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"><label className="text-xs text-zinc-400">本轮策略<select aria-label="本轮策略" className="input mt-1 text-xs" disabled={busy || Boolean(revisionTask)} value={prefs.strategy} onChange={e => changePrefs({ strategy: e.target.value as RoomPreferences['strategy'] })}>{Object.entries(STRATEGY_LABEL).filter(([k]) => k !== 'single').map(([key,label]) => <option key={key} value={key} disabled={readonlyCli && key !== 'serial' || key === 'parallel' && (prefs.constraints.readonly === false || ['development_review','bounded_debate'].includes(prefs.workflow))}>{label}{readonlyCli && key !== 'serial' ? '（CLI 需顺序接力）' : key === 'parallel' && ['development_review','bounded_debate'].includes(prefs.workflow) ? '（工作流含顺序依赖）' : ''}</option>)}</select></label>
      <label className="text-xs text-zinc-400">本轮工作流<select aria-label="本轮工作流" className="input mt-1 text-xs" disabled={busy || Boolean(revisionTask)} value={prefs.workflow} onChange={e => changePrefs({ workflow: e.target.value as RoomPreferences['workflow'] })}>{Object.entries(WORKFLOW_LABEL).map(([key,label]) => <option key={key} value={key} disabled={readonlyCli && key !== 'routine' || prefs.strategy === 'parallel' && ['development_review','bounded_debate'].includes(key) || Boolean(!revisionTask && admission && !admission.enabledWorkflows.includes(key as RoomPreferences['workflow']))}>{label}{admission && !admission.enabledWorkflows.includes(key as RoomPreferences['workflow']) && !revisionTask ? '（尚未开放）' : readonlyCli && key !== 'routine' ? '（CLI 仅常规只读接力）' : prefs.strategy === 'parallel' && ['development_review','bounded_debate'].includes(key) ? '（需顺序策略）' : ''}</option>)}</select></label></div>
      {prefs.strategy === 'serial' && targets.length > 1 && <ol className="mt-2 space-y-1 text-xs text-zinc-500">{targets.map((id,index) => <li key={id} className="flex flex-wrap items-center gap-2">{index + 1}. {candidates.find(a => a.id === id)?.name ?? id}<button aria-label={`上移 ${id}`} className={button} disabled={busy || Boolean(revisionTask) || index === 0} onClick={() => { invalidate(); setTargets(ids => { const next = [...ids]; [next[index - 1],next[index]] = [next[index]!,next[index - 1]!]; return next; }); }}>↑</button></li>)}</ol>}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{prefs.workflow === 'supervisor_decomposition' && roleSelect('主管', 'supervisorId', candidates.filter(a => a.capabilities.includes('coordinate') && a.execution?.kind !== 'external'))}{['development_review','supervisor_decomposition','bounded_debate'].includes(prefs.workflow) && roleSelect(prefs.workflow === 'bounded_debate' ? '独立裁判（与汇总者二选一）' : '独立评审者', 'defaultReviewerId', candidates.filter(a => a.capabilities.includes('review') && !targets.includes(a.id)))}{['analysis_summary','bounded_debate'].includes(prefs.workflow) && roleSelect('汇总者', 'aggregatorId', executors)}</div>
      {prefs.workflow === 'bounded_debate' && <label className="mt-2 block text-xs text-zinc-400">固定轮数（1–10）<input aria-label="辩论轮数" type="number" min={1} max={10} value={prefs.constraints.rounds ?? 2} disabled={busy || Boolean(revisionTask)} onChange={e => changePrefs({ constraints: { ...prefs.constraints, rounds: Number(e.target.value) } })} className="input mt-1 text-xs" /></label>}
      <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">本轮约束与房间默认偏好</summary><div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"><label>读写约束<select aria-label="读写约束" className="input mt-1 text-xs" disabled={busy || Boolean(revisionTask) || ['analysis_summary','bounded_debate'].includes(prefs.workflow)} value={['analysis_summary','bounded_debate'].includes(prefs.workflow) ? 'readonly' : prefs.constraints.readonly === undefined ? 'infer' : prefs.constraints.readonly ? 'readonly' : 'write'} onChange={e => changePrefs({ constraints: { ...prefs.constraints, readonly: e.target.value === 'infer' ? undefined : e.target.value === 'readonly' } })}><option value="infer">根据目标判断</option><option value="readonly">只读</option><option value="write">按角色权限写入</option></select></label>
      <label>输出 tokens 硬上限<input aria-label="输出 tokens 硬上限" className="input mt-1 text-xs" type="number" min={1} max={1000000} value={prefs.constraints.maxTokens ?? ''} disabled={busy || Boolean(revisionTask)} placeholder="不另设；外部 SDK 不支持此硬限制" onChange={e => changePrefs({ constraints: { ...prefs.constraints, maxTokens: e.target.value ? Number(e.target.value) : undefined } })} /></label>
      <label>执行时限（秒）<input aria-label="执行时限" className="input mt-1 text-xs" type="number" min={1} max={86400} value={prefs.constraints.deadlineMs === undefined ? '' : prefs.constraints.deadlineMs / 1000} disabled={busy || Boolean(revisionTask)} onChange={e => changePrefs({ constraints: { ...prefs.constraints, deadlineMs: e.target.value ? Number(e.target.value) * 1000 : undefined } })} /></label></div>
      <p className="mt-2">本轮选择只影响本任务；发送后恢复默认。候选团队和工作区属于房间。</p>{!room && <label className="mt-2 flex items-center gap-2"><input type="checkbox" disabled={busy} checked={useAsDefault} onChange={e => { setUseAsDefault(e.target.checked); clientId.current = crypto.randomUUID(); }} />将当前选择同时设为新房间默认</label>}{room && !revisionTask && <button className={`${button} mt-2`} disabled={busy} onClick={() => void saveDefaults()}>将当前选择设为房间默认</button>}</details>
      {!room && <button className={`${button} mt-3 max-w-full [overflow-wrap:anywhere]`} disabled={busy} onClick={() => setWorkspaceOpen(true)}>工作区：{workspace || '自动创建房间工作区'}</button>}{room && <p className="mt-2 truncate text-[11px] text-zinc-500" title={workspace}>房间工作区：{workspace || '自动工作区'} · 修改工作区请创建新房间</p>}
      {strategyIssue && <p role="alert" className="mt-2 text-xs text-amber-200">{strategyIssue}</p>}
      </>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">{!room && <button className={button} disabled={busy || !title.trim() || !team.length} onClick={() => void emptyRoom()}>仅创建房间</button>}{!decision && <button className={button} disabled={blocked} onClick={() => void plan()}>预览计划</button>}{prefs.workflow === 'supervisor_decomposition' && !decision && <button className={button} disabled={blocked} onClick={() => void plan(true)}>生成详细计划（可能消耗额度）</button>}<button className={primary} disabled={blocked} onClick={() => void send(false)}>{busy ? '处理中…' : decision ? '回答并继续' : revisionTask ? '预览修订' : room ? '发送新任务' : '创建并发送'}</button></div>
    </section>
    {preview && !decision && <PlanPreview preview={preview}><div className="mt-3 flex flex-wrap justify-end gap-2"><button className={button} disabled={busy} onClick={invalidate}>继续编辑</button><button className={primary} disabled={blocked || preview.decision.issues.some(i => i.severity === 'error') || Boolean(preview.decision.execution?.plannerRequired && !preview.plan)} onClick={() => void send(true)}>{revisionTask ? '确认修订（保持暂停）' : '确认并执行本任务'}</button></div></PlanPreview>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-xs text-red-300 [overflow-wrap:anywhere]">{error}</p>}
    <WorkspacePanel open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} current={workspace} onSelect={value => { invalidate(); setWorkspace(value); }} goal={goal} />
  </div>;
}
