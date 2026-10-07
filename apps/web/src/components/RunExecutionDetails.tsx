import { useEffect, useState } from 'react';
import type { ExternalWorkspaceBinding } from '@agent-gand/shared';
import { useStore } from '../store';
import * as api from '../services/api';
export function RunWorkspaceCard({ runId, revision }: { runId: string; revision: string }) {
  const [binding, setBinding] = useState<ExternalWorkspaceBinding | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setBinding(null); setError('');
    void api.getRunWorkspace(runId).then((value) => { if (live) setBinding(value); }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [runId, revision]);
  if (error) return <p className="mt-2 text-xs text-amber-300">工作区信息获取失败：{error}</p>;
  if (!binding) return null;
  return <div className="mt-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-zinc-400">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sky-200">{binding.status === 'ready' ? '隔离编码工作区' : binding.status === 'preparing' ? '正在准备隔离工作区' : '工作区需要检查'}</span>
      {binding.latestSnapshot && <a href={`/api/runs/${encodeURIComponent(runId)}/workspace/patch`} download className="rounded bg-sky-500/15 px-2 py-1 text-sky-200 hover:bg-sky-500/25">下载变更补丁</a>}
    </div>
    <p className="mt-1">变更保存在独立工作区；下载补丁后可在原仓库检查并应用。</p>
    <details className="mt-1"><summary className="cursor-pointer">查看目录与快照</summary><p className="mt-1 break-all">原仓库：{binding.sourceRoot}</p><p className="mt-1 break-all">编码目录：{binding.cwd}</p>{binding.latestSnapshot && <p className="mt-1 break-all">快照：{binding.latestSnapshot.commit}</p>}</details>
    {binding.error && <p className="mt-1 whitespace-pre-wrap text-amber-300">{binding.error}</p>}
  </div>;
}

export function RunExecutionDetails() {
 const { state } = useStore(); const activeRun = state.runs.find(run => run.id === state.activeRunId);
 const agentName = (id: string) => state.agents.find(a => a.id === id)?.name ?? id;
 return <div>          {activeRun?.workspace?.startsWith('ext:') && <RunWorkspaceCard key={activeRun.id} runId={activeRun.id} revision={`${activeRun.status}:${state.executions.filter((item) => item.runId === activeRun.id).map((item) => `${item.id}:${item.status}:${item.snapshot?.commit ?? ''}`).join(',')}:${state.messages.length}`} />}
          {state.executions.filter((item) => item.runId === activeRun?.id).map((item) => <details key={item.id} className="mt-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer">{agentName(item.agentId)} · {item.driver} · {item.permissionMode === 'confirm' ? '需确认' : item.permissionMode === 'auto' ? '白名单自动' : '只读'} · {{ running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' }[item.status]}</summary>
            <p className="mt-2 break-all">版本：{item.driverVersion ?? '未检测'} · 工作区：{item.cwd}</p>
            <p className="mt-1 break-all">会话：{item.sessionId ?? '尚未绑定'}</p>
            {item.sessionMode && <p className="mt-1">{item.sessionMode === 'resume' ? '已续接完成会话' : '已建立新会话'} · {item.sessionReason}</p>}
            {item.snapshot && <p className="mt-1 break-all">固定审查快照：{item.snapshot.commit}</p>}
            {item.recovery && <p className={`mt-1 ${item.recovery.state === 'attention' ? 'text-amber-300' : 'text-zinc-400'}`}>恢复检查：{item.recovery.reason}</p>}
            {item.controlAction && <p className="mt-1">已提交协作动作：{item.controlAction.type}{item.exitCorrectionAttempts ? ` · 纠偏 ${item.exitCorrectionAttempts} 次` : ''}</p>}
            <p className="mt-1">输入/输出 tokens：{item.tokensIn ?? '未知'} / {item.tokensOut ?? '未知'} · CLI 报告成本：{item.costUsd === null ? '未知' : `$${item.costUsd.toFixed(4)}`}</p>
            {item.error && <p className="mt-1 whitespace-pre-wrap text-red-300">{item.errorCode}：{item.error}</p>}
            {item.evidence && <div className="mt-2 space-y-2">
              <p>权限：{item.permissionMode} · Git HEAD：{item.evidence.head ?? '未知'}{item.evidence.truncated ? ' · 证据已截断' : ''}</p>
              <details>
                <summary className="cursor-pointer">查看实际 diff 和工具结果</summary>
                <p className="mt-2">执行前的工作区变更</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{item.evidence.beforeDiff || '（无 diff）'}</pre>
                <p className="mt-2">执行后的工作区变更</p>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{item.evidence.afterDiff || '（无 diff）'}</pre>
                {item.evidence.commands.map((command) => <pre key={command.itemId} className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{command.name} · exit={command.exitCode ?? '未知'}{'\n'}{command.output}</pre>)}
              </details>
            </div>}
          </details>)}</div>;
}
