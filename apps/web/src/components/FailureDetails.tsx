import type { RunFailureNode, RunFailureReport } from '@agent-gand/shared';

const ROLE: Record<RunFailureNode['role'], string> = { failure: '执行失败', affected: '受影响事项', cancelled: '后续停止', unknown: '结果未知',
  secondary: '关联诊断', control_interruption: '控制动作后的受控停止', terminal: '任务结束' };
const RELATION = { same_attempt: '同一次执行的关联记录', span_parent: '调用层级', depends_on: '前置依赖', secondary_to: '失败后的证据采集异常',
  failed_at_terminal: '终态提交前已记录的失败事项', terminal_cancel: '因任务终态而停止' };
const PHASE: Record<string, string> = { queue: '排队', initialization: '初始化', before_session: '会话建立前', before_first_activity: '首次活动前', after_activity: '模型活动后', deadline: '截止时间' };
const ACTION = { complete: '结束责任', handoff: '交接', consult_all: '等待全部咨询', consult_any: '等待首个咨询', hold: '挂起', wake: '唤醒', emit: '交付结果' };

export function FailureDetails({ report, memberName }: { report: RunFailureReport; memberName: (id: string) => string }) {
  const primary = new Set(report.primaryNodeIds);
  return <details className="mt-3 rounded-lg border border-zinc-700 p-3 text-xs" aria-label="失败关系与恢复依据">
    <summary className="cursor-pointer text-zinc-300">查看失败关系与恢复依据{primary.size > 1 ? ` · ${primary.size} 个独立失败` : ''}</summary>
    <p className="mt-2 text-zinc-400">{primary.size ? '原始失败优先展示；调用关联与前置依赖分别标注。' : '现有记录不足以确认原始触发点，请核对下列已记录事项。'}</p>
    <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
      {report.nodes.map(node => <details key={node.id} className="rounded bg-zinc-950/60 p-2" open={primary.has(node.id)}>
        <summary className={primary.has(node.id) ? 'text-red-200' : node.role === 'unknown' ? 'text-amber-200' : 'text-zinc-400'}>
          {primary.has(node.id) ? '原始失败' : ROLE[node.role]}{node.resolved ? ' · 非当前原始故障' : ''}{node.agentId ? ` · ${memberName(node.agentId)}` : ''}
        </summary>
        <p className="mt-1 whitespace-pre-wrap break-words text-zinc-300">{node.message}</p>
        {node.control && <p className="mt-1 text-zinc-400">{node.control.state === 'committed' ? `平台动作已提交：${node.control.kind ? ACTION[node.control.kind] : '已确认'}` : '仅收到控制候选，尚未找到平台动作提交记录。'}</p>}
        {node.details?.phase && <p className="mt-1 text-zinc-400">发生阶段：{PHASE[node.details.phase] ?? node.details.phase}{node.details.timeoutKind ? ` · ${node.details.timeoutKind === 'first_response' ? '首响应时限' : node.details.timeoutKind === 'idle' ? '停滞时限' : '总时限'}` : ''}</p>}
        {node.details?.limitMs && <p className="mt-1 text-zinc-400">触发时限：{node.details.limitMs / 1000} 秒</p>}
        {node.timeoutPolicy && <p className="mt-1 text-zinc-400">有效总时限：{node.timeoutPolicy.effectiveMs / 1000} 秒</p>}
        {node.progress && <p className="mt-1 text-zinc-400">最近可信活动：{node.progress.lastActivityAt ? new Date(node.progress.lastActivityAt).toLocaleString() : '尚未收到'}{node.progress.firstResponseAt ? ' · 已收到模型活动' : ' · 尚无模型活动'}</p>}
        {report.links.filter(edge => edge.to === node.id).map(edge => {
          const related = report.nodes.find(item => item.id === edge.from);
          return <p key={`${edge.from}:${edge.relation}`} className="mt-1 text-zinc-400">{RELATION[edge.relation]}：{related?.agentId ? memberName(related.agentId) : related ? ROLE[related.role] : '来源记录'}</p>;
        })}
        <details className="mt-2 text-zinc-500"><summary>查看记录来源</summary><p>{node.code} · {new Date(node.occurredAt).toLocaleString()}</p>{node.providerDiagnostic && <p className="break-all">供应商 HTTP {node.providerDiagnostic.httpStatus}{node.providerDiagnostic.requestId ? ` · Request ID：${node.providerDiagnostic.requestId}` : ' · 未返回可用的请求 ID'}</p>}<pre className="whitespace-pre-wrap break-all">{JSON.stringify(node.refs, null, 2)}</pre>{node.details?.stderr && <pre className="mt-2 whitespace-pre-wrap break-all">{node.details.stderr}</pre>}</details>
      </details>)}
    </div>
    {report.recovery && <p className="mt-2 text-zinc-300">恢复判断：{report.recovery.explanation}</p>}
    {report.truncated && <p className="mt-2 text-amber-200">诊断条目过多，当前展示已截断。请继续核对完整执行轨迹。</p>}
  </details>;
}
