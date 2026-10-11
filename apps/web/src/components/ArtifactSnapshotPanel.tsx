import { useEffect, useRef, useState } from 'react';
import type { ArtifactSnapshot, BusinessState, SnapshotPreview, SnapshotRestorePreview } from '@agent-gand/shared';
import * as api from '../services/api';

const button='rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 disabled:opacity-40';
const change={added:'新增',modified:'修改',unchanged:'保留',deleted:'删除'};
export function SnapshotManifest({snapshot,onDownload}:{snapshot:ArtifactSnapshot;onDownload?:(kind:'file'|'text',index:number)=>void}) {
  return <div className="min-w-0 space-y-2 text-xs text-zinc-400">
    <p>{snapshot.complete?'本次声明产物完整':'声明产物缺失'} · 验收账本版本 {snapshot.sourceVersion} · {snapshot.files.length} 个文件版本</p>
    {snapshot.git?<p className="break-all">Git 基线：{snapshot.git.commit} · {snapshot.git.files.length} 个基线文件。恢复到新独立仓库，保留此提交，不依赖原工作树。</p>:<p>普通文件快照，无 Git 基线。</p>}
    {snapshot.declarations.filter(d=>!d.present).map(d=><p key={d.stageId+':'+d.deliverableId} className="text-amber-200">缺少声明交付：{d.title}</p>)}
    {snapshot.texts.length>0&&<details><summary className="cursor-pointer">查看已归档文本（{snapshot.texts.length} 项）</summary>{snapshot.texts.map((t,i)=><div key={t.stageId+':'+t.deliverableId} className="mt-2 [overflow-wrap:anywhere]"><p>{t.stageId} / {t.deliverableId} · {t.size} bytes · {t.mimeType} · {t.visibility==='public'?'公开':`私密 · 获准成员 ${t.audience.filter(id=>id!=='user').join('、')||'仅所有者'}`} · 验收版本 {t.acceptanceVersion??'尚未验收'}</p><p>来源任务 {t.sourceRunId} · SHA256 {t.sha256}</p>{onDownload&&<button className={button} onClick={()=>onDownload('text',i)}>下载归档文本</button>}</div>)}</details>}
    <details><summary className="cursor-pointer">查看文件版本、改动与权限</summary><div className="mt-2 space-y-2">{snapshot.files.map((f,i)=><div key={f.storage+':'+(f.artifactId??f.path)} className="rounded bg-zinc-950/50 p-2 [overflow-wrap:anywhere]">
      <p>{change[f.change]} · {f.path}{f.artifactVersion?` · v${f.artifactVersion}`:''} · {f.size} bytes · {f.mimeType}</p>
      <p>{f.visibility==='public'?'公开':`私密 · 获准成员 ${f.audience.filter(id=>id!=='user').join('、')||'仅所有者'}`} · {f.storage==='managed'?'加密受控版本':'隔离工作树文件'} · 阶段 {f.stageId??'未绑定'} · 验收版本 {f.acceptanceVersion??'尚未验收'}</p>
      <p>来源任务 {f.sourceRunId} · SHA256 {f.sha256??'删除记录'}</p>
      {onDownload&&f.change!=='deleted'&&<button className={button} onClick={()=>onDownload('file',i)}>下载归档文件</button>}
    </div>)}{snapshot.files.length===0&&<p>本次仅保存声明清单及 Git 基线。</p>}</div></details>
    <details><summary className="cursor-pointer">未包含内容及限制（{snapshot.omissions.length} 项）</summary><p className="mt-2">物理文件最多 1 MiB，受控文件最多 256 KiB；载荷最多 16 MiB / 4000 文件。链接、子模块和凭据不支持归档。</p><ul className="mt-2 space-y-1">{snapshot.omissions.map((o,i)=><li key={i} className="[overflow-wrap:anywhere]">{o.path}：{o.reason}</li>)}</ul></details>
  </div>;
}

export function ArtifactSnapshotPanel({runId,businessVersion,stages=[]}:{runId:string;businessVersion?:number;stages?:BusinessState['stages']}) {
  const [rows,setRows]=useState<Awaited<ReturnType<typeof api.getArtifactSnapshots>>['snapshots']>([]);
  const [paths,setPaths]=useState(''),[selected,setSelected]=useState<string[]>([]);
  const [preview,setPreview]=useState<SnapshotPreview|null>(null),[restore,setRestore]=useState<SnapshotRestorePreview|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
  const epoch=useRef(0),restoreId=useRef('');
  useEffect(()=>{ const id=++epoch.current; setRows([]);setPaths('');setPreview(null);setRestore(null);setResult('');setError('');setBusy(false);
    setSelected(stages.filter(s=>s.report?.kind==='delivery').map(s=>s.stage.id));
    void api.getArtifactSnapshots(runId).then(r=>{if(epoch.current===id)setRows(r.snapshots);}).catch(e=>{if(epoch.current===id)setError(e.message);});
    return ()=>{epoch.current++;};
  },[runId,businessVersion]);
  const input=()=>({paths:paths.split('\n').map(p=>p.trim()).filter(Boolean),stageIds:selected});
  async function action(work:()=>Promise<void>) {const id=epoch.current;setBusy(true);setError('');try{await work();}catch(e){if(epoch.current===id)setError(e instanceof Error?e.message:String(e));}finally{if(epoch.current===id)setBusy(false);}}
  async function refresh(id:number){const r=await api.getArtifactSnapshots(runId);if(epoch.current===id)setRows(r.snapshots);}
  function download(id:string,kind:'file'|'text',index:number){void action(async()=>{const epochId=epoch.current;const r=await api.getSnapshotContent(id,kind,index);if(epoch.current!==epochId)return;
    const bytes=Uint8Array.from(atob(r.contentBase64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
    const link=document.createElement('a');link.href=url;link.download=r.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });}
  return <details className="rounded-lg border border-zinc-700 p-3" aria-label="产物与工作树快照"><summary className="cursor-pointer text-zinc-200">产物与工作树快照 · {rows.length} 份归档</summary><div className="mt-3 space-y-3 text-xs">
    <p className="text-zinc-400">已验收阶段自动保留证据。额外归档先声明路径并核对预览；恢复只创建新隔离目录，不执行 Agent。私密受控文件保持加密，逐阶段任务可先核对副作用，再预览私密或写入续跑。</p>
    <fieldset disabled={busy} className="space-y-2"><legend className="mb-1 text-zinc-400">本次归档的阶段</legend>{stages.map(s=><label key={s.stage.id} className="flex items-start gap-2"><input type="checkbox" checked={selected.includes(s.stage.id)} onChange={e=>{setSelected(p=>e.target.checked?[...p,s.stage.id]:p.filter(id=>id!==s.stage.id));setPreview(null);}}/>{s.stage.title}</label>)}</fieldset>
    <label className="block text-zinc-400">额外声明的工作树改动（每行一个相对路径，含删除）<textarea aria-label="快照声明路径" className="input mt-1 min-h-16" disabled={busy} value={paths} onChange={e=>{setPaths(e.target.value);setPreview(null);}} placeholder={'src/result.ts\nreports/chart.png'}/></label>
    <button className={button} disabled={busy} onClick={()=>void action(async()=>{const id=epoch.current;const r=await api.previewArtifactSnapshot(runId,input());if(epoch.current===id){setPreview(r);setRestore(null);}})}>预览产物归档</button>
    {preview&&<section className="space-y-2 rounded bg-violet-500/10 p-3" aria-label="产物归档预览"><SnapshotManifest snapshot={preview.snapshot}/><button className={button} disabled={busy||preview.blocked.length>0} onClick={()=>void action(async()=>{const id=epoch.current;await api.saveArtifactSnapshot(runId,{...input(),fingerprint:preview.fingerprint});if(epoch.current===id){setPreview(null);setResult('产物快照已保存');await refresh(id);}})}>确认保存快照</button></section>}
    {rows.map(row=><details key={row.snapshot.id} className="rounded bg-zinc-950/50 p-2"><summary className="cursor-pointer">验收版本 {row.snapshot.sourceVersion} · {row.snapshot.files.length} 个文件版本 · {row.retained?'已验收或被引用，保留':'可清理归档'}</summary><div className="mt-2 space-y-2"><SnapshotManifest snapshot={row.snapshot} onDownload={busy?undefined:(kind,index)=>download(row.snapshot.id,kind,index)}/><p className="break-all text-zinc-500">快照 {row.snapshot.id}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>void action(async()=>{const id=epoch.current;const r=await api.previewArtifactRestore(row.snapshot.id);if(epoch.current===id){setRestore(r);setPreview(null);restoreId.current=crypto.randomUUID();}})}>预览恢复到新目录</button>{!row.retained&&<button className={button} disabled={busy} onClick={()=>{if(window.confirm('清理这份未被验收或引用的归档？'))void action(async()=>{const id=epoch.current;await api.deleteArtifactSnapshot(row.snapshot.id,row.digest);await refresh(id);});}}>清理未引用归档</button>}</div></div></details>)}
    {restore&&<section className="space-y-2 rounded border border-violet-500/30 p-3" aria-label="快照恢复预览"><h5 className="text-violet-200">恢复到新隔离目录</h5><SnapshotManifest snapshot={restore.snapshot}/><p className="text-zinc-400">恢复 {restore.physicalFiles} 个声明文件及 Git 基线；{restore.encryptedFiles} 个受控版本保留加密。此操作不会调用模型或重放工具。</p><button className={button} disabled={busy} onClick={()=>void action(async()=>{const id=epoch.current;const r=await api.restoreArtifactSnapshot(restore.snapshot.id,{fingerprint:restore.fingerprint,clientRequestId:restoreId.current});if(epoch.current===id){setRestore(null);setResult('已恢复到 '+r.path);await refresh(id);}})}>确认恢复产物</button><button className={button} disabled={busy} onClick={()=>setRestore(null)}>关闭预览</button></section>}
    {result&&<p role="status" className="break-all text-emerald-300">{result}</p>}{error&&<p role="alert" className="break-words text-red-300">{error}</p>}
  </div></details>;
}
