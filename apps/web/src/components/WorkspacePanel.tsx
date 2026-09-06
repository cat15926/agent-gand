/**
 * 工作区管理面板（规格 §11.1 M1 卡片选择器 + §11.2/11.3 注册流程）
 * 弹层：内部工作区卡片（元数据 + 选择/重命名/复制/删除）+ 自动名新建 + 外部目录注册
 * （目录浏览器 → 风险确认 → 注册）。删除走确认对话框并归档（服务端移入 _deleted-workspaces/）。
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../services/api';

export interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
  /** 当前选中：''=每次新建；内部名；'ext:<id>' */
  current: string;
  onSelect: (workspace: string) => void;
  /** 新建自动名建议用（当前输入的目标） */
  goal?: string;
}

const NAME_RE = /^[\w-]{1,32}$/;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function WorkspacePanel({ open, onClose, current, onSelect, goal }: WorkspacePanelProps) {
  const [metas, setMetas] = useState<api.WorkspaceMeta[]>([]);
  const [externals, setExternals] = useState<api.ExternalWorkspaceInfo[]>([]);
  const [suggested, setSuggested] = useState('');
  const [newName, setNewName] = useState(''); // '' = 用建议名
  const [browse, setBrowse] = useState<{ current: string; dirs: Array<{ name: string; path: string }> } | null>(null);
  const [riskPath, setRiskPath] = useState<string | null>(null); // 待风险确认的目录
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // 待删除确认的工作区名
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [ms, ex] = await Promise.all([api.getWorkspaces(), api.getExternalWorkspaces()]);
      setMetas(ms);
      setExternals(ex);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    api
      .suggestWorkspaceName(goal)
      .then((r) => setSuggested(r.name))
      .catch(() => setSuggested(''));
    setNewName('');
  }, [open, goal, refresh]);

  if (!open) return null;

  async function op(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const effectiveNewName = newName.trim() !== '' ? newName.trim() : suggested;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-3">
          <span className="text-sm font-semibold text-zinc-100">工作区</span>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

          {/* 每次新建（零输入路径之一） */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-zinc-400">会话工作区</h3>
            <button
              onClick={() => {
                onSelect('');
                onClose();
              }}
              className={`w-full rounded-xl border px-4 py-3 text-left text-sm ${
                current === '' ? 'border-violet-500/60 bg-violet-500/10 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700'
              }`}
            >
              🆕 每次新建（独立目录）
              <span className="mt-0.5 block text-[11px] text-zinc-500">每个 run 使用 sandbox/runs/&lt;runId&gt;/ 专属目录，互不可见</span>
            </button>
          </section>

          {/* 内部工作区卡片（§11.1） */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-zinc-400">命名工作区（跨 run 复用）</h3>
            <div className="grid grid-cols-2 gap-3">
              {metas.map((w) => (
                <div
                  key={w.name}
                  className={`rounded-xl border p-3 ${
                    current === w.name ? 'border-violet-500/60 bg-violet-500/10' : 'border-zinc-800 bg-zinc-900/60'
                  }`}
                >
                  <button
                    className="block w-full text-left"
                    onClick={() => {
                      onSelect(w.name);
                      onClose();
                    }}
                  >
                    <div className="flex items-center gap-2 text-sm text-zinc-100">
                      🗂 {w.name}
                      {current === w.name && <span className="text-[10px] text-violet-300">当前</span>}
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      最后使用 {fmtTime(w.modifiedAt)} · {w.fileCount} 文件 · {w.runCount} runs
                    </div>
                    {w.lastGoal && (
                      <div className="mt-1 truncate text-[11px] text-zinc-600" title={w.lastGoal}>
                        {w.lastGoal}
                      </div>
                    )}
                  </button>
                  <div className="mt-2 flex gap-1.5 text-[11px]">
                    {renaming?.from === w.name ? (
                      <>
                        <input
                          autoFocus
                          value={renaming.to}
                          onChange={(e) => setRenaming({ from: w.name, to: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && NAME_RE.test(renaming.to.trim())) {
                              void op(async () => {
                                await api.renameWorkspace(w.name, renaming.to.trim());
                                if (current === w.name) onSelect(renaming.to.trim());
                              });
                              setRenaming(null);
                            }
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          className="w-32 rounded-md bg-zinc-800 px-2 py-0.5 text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-violet-500"
                        />
                        <button
                          className="text-violet-300 hover:text-violet-200"
                          onClick={() => {
                            if (NAME_RE.test(renaming.to.trim())) {
                              void op(async () => {
                                await api.renameWorkspace(w.name, renaming.to.trim());
                                if (current === w.name) onSelect(renaming.to.trim());
                              });
                              setRenaming(null);
                            }
                          }}
                        >
                          确认
                        </button>
                        <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setRenaming(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setRenaming({ from: w.name, to: w.name })}>
                          重命名
                        </button>
                        <button className="text-zinc-400 hover:text-zinc-100" onClick={() => void op(() => api.duplicateWorkspace(w.name))}>
                          复制
                        </button>
                        {confirmDelete === w.name ? (
                          <>
                            <button className="text-red-300 hover:text-red-200" onClick={() => { setConfirmDelete(null); void op(() => api.deleteWorkspace(w.name)); }}>
                              确认删除
                            </button>
                            <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setConfirmDelete(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <button className="text-zinc-400 hover:text-red-300" onClick={() => setConfirmDelete(w.name)}>
                            删除
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {/* 新建卡片（自动名建议，名称可改——零输入路径之二） */}
              <div className="rounded-xl border border-dashed border-zinc-700 p-3">
                <div className="flex items-center gap-2 text-sm text-zinc-200">➕ 新建工作区</div>
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={suggested || 'task-MMDD'}
                    className={`w-36 rounded-md bg-zinc-800 px-2 py-1 text-xs outline-none ring-1 ${
                      !NAME_RE.test(effectiveNewName) && effectiveNewName !== '' ? 'ring-red-500/70' : 'ring-zinc-700 focus:ring-violet-500'
                    } text-zinc-200 placeholder:text-zinc-600`}
                  />
                  <button
                    disabled={!NAME_RE.test(effectiveNewName)}
                    onClick={() => {
                      onSelect(effectiveNewName); // 目录由首个 run 落盘时创建
                      onClose();
                    }}
                    className="rounded-md bg-violet-500/80 px-2.5 py-1 text-xs text-white hover:bg-violet-500 disabled:opacity-40"
                  >
                    使用
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-zinc-600">建议名 {suggested || '…'}（可直接确认或修改）</div>
              </div>
            </div>
          </section>

          {/* 外部工作区（§11.2/11.3：独立配色 + 📁 徽标 + 路径副标题） */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-zinc-400">外部目录（本机注册）</h3>
            <div className="grid grid-cols-2 gap-3">
              {externals.map((x) => (
                <div
                  key={x.id}
                  className={`rounded-xl border p-3 ${
                    current === `ext:${x.id}` ? 'border-sky-500/60 bg-sky-500/10' : 'border-sky-900/60 bg-sky-950/20'
                  }`}
                >
                  <button
                    className="block w-full text-left"
                    onClick={() => {
                      onSelect(`ext:${x.id}`);
                      onClose();
                    }}
                  >
                    <div className="flex items-center gap-2 text-sm text-zinc-100">
                      📁 {x.label}
                      {current === `ext:${x.id}` && <span className="text-[10px] text-sky-300">当前</span>}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-zinc-500" title={x.absPath}>
                      {x.absPath}
                    </div>
                    <div className="mt-1 text-[11px] text-sky-300/70">写入逐次审批 · 目录外不可触碰</div>
                  </button>
                  <div className="mt-2 flex gap-1.5 text-[11px]">
                    <button
                      className="text-zinc-400 hover:text-red-300"
                      onClick={() => {
                        if (current === `ext:${x.id}`) onSelect('');
                        void op(() => api.unregisterExternal(x.id));
                      }}
                    >
                      解除注册（不动文件）
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={async () => {
                  try {
                    setBrowse(await api.browseFs());
                    setError('');
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
                className="rounded-xl border border-dashed border-sky-800 p-3 text-left text-sm text-sky-300 hover:border-sky-600"
              >
                📁 注册本机目录…
                <span className="mt-1 block text-[11px] text-zinc-600">浏览选择 → 风险确认 → 注册</span>
              </button>
            </div>
          </section>
        </div>
      </div>

      {/* 目录浏览器（§11.2：只列目录、跳点开头） */}
      {browse && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6" onClick={() => setBrowse(null)}>
          <div
            className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-3">
              <span className="truncate text-xs font-mono text-zinc-400" title={browse.current}>
                {browse.current}
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  onClick={async () => {
                    const parent = browse.current.replace(/\/[^/]+\/?$/, '') || '/';
                    setBrowse(await api.browseFs(parent));
                  }}
                >
                  ⬆ 上级
                </button>
                <button className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800" onClick={() => setBrowse(null)}>
                  ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {browse.dirs.length === 0 && <p className="p-4 text-center text-xs text-zinc-600">无可见子目录</p>}
              {browse.dirs.map((d) => (
                <div key={d.path} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-zinc-800/60">
                  <button
                    className="flex-1 truncate text-left text-sm text-zinc-300"
                    onClick={async () => setBrowse(await api.browseFs(d.path))}
                  >
                    📁 {d.name}
                  </button>
                  <button
                    className="ml-2 shrink-0 rounded-md bg-sky-500/20 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/30"
                    onClick={() => {
                      setRiskPath(d.path);
                      setBrowse(null);
                    }}
                  >
                    选此目录
                  </button>
                </div>
              ))}
            </div>
            <div className="shrink-0 border-t border-zinc-800 p-3">
              <button
                className="w-full rounded-lg bg-sky-500/20 px-3 py-2 text-xs text-sky-300 hover:bg-sky-500/30"
                onClick={() => {
                  setRiskPath(browse.current);
                  setBrowse(null);
                }}
              >
                注册当前目录（{browse.current}）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 风险确认（§11.3 文案与实际权限一致） */}
      {riskPath && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6" onClick={() => setRiskPath(null)}>
          <div className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-amber-300">⚠ 注册外部目录</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-300">
              agent 将能读写此目录内文件（写入逐次审批），目录外不可触碰。
            </p>
            <p className="mt-2 break-all rounded-lg bg-zinc-800 p-2 font-mono text-[11px] text-zinc-400">{riskPath}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200" onClick={() => setRiskPath(null)}>
                取消
              </button>
              <button
                className="rounded-md bg-amber-500/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/30"
                onClick={() => {
                  const p = riskPath;
                  setRiskPath(null);
                  void op(async () => {
                    await api.registerExternal(p);
                    setBrowse(null);
                  });
                }}
              >
                我已了解，注册
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
