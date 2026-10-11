import { useEffect, useState } from 'react';
import type { AgentDefinition } from '@agent-gand/shared';
import { Drawer } from './Drawer';
import * as api from '../services/api';

export function ArtifactDrawer({ roomId, agents, open, onClose }: { roomId: string; agents: AgentDefinition[]; open: boolean; onClose: () => void }) {
  const [files,setFiles] = useState<api.ManagedArtifact[]>([]);
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  const [selected,setSelected] = useState<api.ManagedArtifact | null>(null);
  const [visibility,setVisibility] = useState<'private' | 'public'>('private'); const [audience,setAudience] = useState<string[]>([]); const [reason,setReason] = useState('');
  const names = (ids: string[]) => ids.filter(id => id !== 'user').map(id => agents.find(agent => agent.id === id)?.name ?? id).join('、');
  async function refresh() { setFiles((await api.getManagedArtifacts(roomId)).files); }
  useEffect(() => { let alive = true; setSelected(null); setFiles([]); if (open) { setError(''); void api.getManagedArtifacts(roomId).then(result => { if (alive) setFiles(result.files); }).catch(error => { if (alive) setError(String(error.message ?? error)); }); } return () => { alive = false; }; },[open,roomId]);
  async function download(file: api.ManagedArtifact) {
    setBusy(true); setError('');
    try { const result = await api.getManagedArtifactContent(file.id); const content = Uint8Array.from(atob(result.contentBase64),value => value.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([content],{type:'application/octet-stream'}));
      const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').at(-1) ?? 'artifact'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  async function release() {
    if (!selected) return; setBusy(true); setError('');
    try { await api.releaseManagedArtifact(selected.id,{expectedVersion:selected.version,visibility,audience:visibility === 'private' ? audience : [],reason}); setSelected(null); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  return <Drawer open={open} title="受控文件与授权" onClose={onClose}><div className="space-y-3 p-4 text-sm">
    <p className="text-zinc-400">任务附件和私密文件按版本保存。模型读取、搜索和证据引用都检查授权范围。可在新任务输入框添加附件。</p>
    {error && <p role="alert" className="break-words text-red-300">{error}</p>}
    {selected ? <section aria-label="确认扩大文件授权" className="space-y-3 rounded-lg border border-amber-500/40 p-3">
      <h3 className="font-medium text-amber-200">扩大授权：{selected.path} · v{selected.version}</h3>
      <p>当前可见：仅你与 {names(selected.audience)}</p>
      <label className="block">新范围<select aria-label="文件新可见范围" className="input mt-1" value={visibility} disabled={busy} onChange={e => setVisibility(e.target.value as 'private' | 'public')}><option value="private">增加获准成员</option><option value="public">公开给房间所有成员</option></select></label>
      {visibility === 'private' && <div className="flex flex-wrap gap-3">{agents.map(agent => <label className="flex items-center gap-1" key={agent.id}><input aria-label={`文件授权 ${agent.name}`} type="checkbox" checked={audience.includes(agent.id)} disabled={busy || selected.audience.includes(agent.id)} onChange={() => setAudience(ids => ids.includes(agent.id) ? ids.filter(id => id !== agent.id) : [...ids,agent.id])} />{agent.name}</label>)}</div>}
      <p className="text-amber-200">确认后新版本将允许{visibility === 'public' ? '房间所有成员' : `你与 ${names(audience)}`}读取；原版本保持原权限，并保存本次授权审计。</p>
      <label className="block">授权原因<input aria-label="文件授权原因" className="input mt-1" value={reason} maxLength={500} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><button className="rounded-lg bg-amber-600 px-3 py-2" disabled={busy || !reason.trim() || visibility === 'private' && audience.every(id => selected.audience.includes(id))} onClick={() => void release()}>确认扩大授权并创建新版本</button><button className="rounded-lg bg-zinc-800 px-3 py-2" disabled={busy} onClick={() => setSelected(null)}>取消</button></div>
    </section> : files.length ? files.map(file => <article className="space-y-2 rounded-lg border border-zinc-700 p-3 [overflow-wrap:anywhere]" key={file.id}>
      <h3 className="font-medium">{file.path} · v{file.version}</h3>
      <p className="text-xs text-zinc-400">{file.visibility === 'private' ? `私密 · 仅你与 ${names(file.audience)}` : '公开 · 房间所有成员'} · {file.size} 字节</p>
      <p className="text-xs text-zinc-500">来源任务：{file.runId.slice(0,8)}{file.stageId ? ` · 阶段 ${file.stageId}` : ''} · SHA-256 {file.sha256.slice(0,12)}</p>
      <div className="flex flex-wrap gap-2"><button disabled={busy} className="rounded bg-zinc-800 px-3 py-2 text-xs" onClick={() => void download(file)}>下载此版本</button>{file.visibility === 'private' && !files.some(other => other.path === file.path && other.version > file.version) && <button disabled={busy} className="rounded bg-zinc-800 px-3 py-2 text-xs" onClick={() => { setSelected(file); setVisibility('private'); setAudience(file.audience.filter(id => id !== 'user')); setReason(''); }}>扩大授权…</button>}</div>
    </article>) : <p className="text-zinc-500">还没有受控文件。发送任务时添加附件，文件会继承该任务的可见范围。</p>}
  </div></Drawer>;
}
