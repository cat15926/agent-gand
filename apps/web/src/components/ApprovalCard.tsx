/**
 * 审批卡（报告模式 5）：批准 / 拒绝 / 编辑后继续
 */
import { useState } from 'react';
import type { ApprovalRequest } from '@agent-gand/shared';
import * as api from '../services/api';

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.input ?? '');

  async function decide(decision: 'approve' | 'reject' | 'edit') {
    setBusy(true);
    try {
      await api.decideApproval(approval.id, {
        decision,
        editedInput: decision === 'edit' ? draft : undefined,
        by: 'user',
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-amber-200">⚠ {approval.toolName}</span>
        <span className="text-zinc-500">{approval.agentId}</span>
      </div>
      {approval.reason && <p className="mb-2 text-zinc-400">{approval.reason}</p>}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="mb-2 w-full rounded-md bg-zinc-900 p-2 font-mono text-[11px] text-zinc-300 outline-none ring-1 ring-zinc-700 focus:ring-violet-500"
        />
      ) : (
        approval.input && (
          <pre className="mb-2 max-h-28 overflow-auto rounded-md bg-zinc-900 p-2 font-mono text-[11px] text-zinc-400">
            {approval.input}
          </pre>
        )
      )}

      <div className="flex gap-2">
        {!editing ? (
          <>
            <button
              disabled={busy}
              onClick={() => void decide('approve')}
              className="rounded-md bg-emerald-500/20 px-2.5 py-1 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
            >
              批准
            </button>
            <button
              disabled={busy}
              onClick={() => void decide('reject')}
              className="rounded-md bg-red-500/20 px-2.5 py-1 text-red-300 hover:bg-red-500/30 disabled:opacity-50"
            >
              拒绝
            </button>
            <button
              disabled={busy}
              onClick={() => setEditing(true)}
              className="rounded-md bg-zinc-700/60 px-2.5 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
            >
              编辑
            </button>
          </>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={() => void decide('edit')}
              className="rounded-md bg-violet-500/20 px-2.5 py-1 text-violet-300 hover:bg-violet-500/30 disabled:opacity-50"
            >
              以编辑内容继续
            </button>
            <button onClick={() => setEditing(false)} className="rounded-md px-2.5 py-1 text-zinc-500 hover:text-zinc-300">
              取消
            </button>
          </>
        )}
      </div>
    </div>
  );
}
