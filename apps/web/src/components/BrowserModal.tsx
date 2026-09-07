/**
 * 本机目录浏览器弹层（规格 §11.2 + §12.1/12.2 B 导航增强）
 * 只列目录、跳点开头；面包屑祖先直达；记住上次位置（localStorage）；快捷位置
 * （主目录/桌面/文档 + 最近浏览 5 条）；路径直达；当前层过滤；内联新建文件夹
 * （回车创建→自动进入；重名内联提示并定位）；空目录友好提示；ESC/遮罩关闭。
 */
import { useEffect, useState } from 'react';
import * as api from '../services/api';

const LAST_KEY = 'gand:ws:browse:last';
const RECENT_KEY = 'gand:ws:browse:recent';

interface RecentStore {
  [LAST_KEY]: string | null;
  [RECENT_KEY]: string[];
}

function storeGet(): RecentStore {
  try {
    return {
      [LAST_KEY]: localStorage.getItem(LAST_KEY),
      [RECENT_KEY]: JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[],
    };
  } catch {
    return { [LAST_KEY]: null, [RECENT_KEY]: [] };
  }
}

/** 记住位置 + 最近 5 条（去重，最新在前） */
function rememberVisit(p: string): void {
  try {
    localStorage.setItem(LAST_KEY, p);
    const prev = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    const next = [p, ...prev.filter((x) => x !== p)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可用（隐私模式等）静默降级
  }
}

export interface BrowserModalProps {
  onClose: () => void;
  /** 选定某目录（进入注册风险确认） */
  onPick: (path: string) => void;
}

export function BrowserModal({ onClose, onPick }: BrowserModalProps) {
  const [current, setCurrent] = useState('');
  const [home, setHome] = useState(''); // 由首次 browse（缺省=主目录）推导，供桌面/文档快捷位拼路径
  const [dirs, setDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [filter, setFilter] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [mkError, setMkError] = useState('');
  const remembered = storeGet();

  async function go(p: string | undefined, silent = false) {
    try {
      const r = await api.browseFs(p);
      setCurrent(r.current);
      setHome((h) => (h === '' ? r.current : h)); // 首次缺省浏览即主目录
      setDirs(r.dirs);
      setFilter('');
      setNotice('');
      rememberVisit(r.current);
    } catch (e) {
      if (silent === false) setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void go(remembered[LAST_KEY] ?? undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC 关闭（§12.4）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 快捷位：主目录（缺省浏览）+ 桌面/文档（home 拼路径，浏览失败有 notice）+ 最近 5 条（去重）
  const seen = new Set<string>();
  const quickButtons = [
    { label: '🏠 主目录', path: undefined as string | undefined },
    { label: '🖥 桌面', path: home === '' ? undefined : `${home}/Desktop` },
    { label: '📄 文档', path: home === '' ? undefined : `${home}/Documents` },
    ...remembered[RECENT_KEY].map((p) => ({ label: `🕘 ${p.split('/').pop() || p}`, path: p })),
  ].filter((q) => {
    const key = q.path ?? '~';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 面包屑：/Users/foo/bar → [{/}, Users, foo, bar]（带累计路径）
  const crumbs: Array<{ label: string; path: string }> = [];
  if (current.startsWith('/')) {
    const parts = current.split('/').filter(Boolean);
    crumbs.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }

  const shown = dirs.filter((d) => d.name.toLowerCase().includes(filter.trim().toLowerCase()));

  async function createFolder() {
    const name = newName.trim();
    if (name === '') return;
    setMkError('');
    try {
      const r = await api.mkdirFs(current, name);
      setCreating(false);
      setNewName('');
      await go(r.path); // 创建成功 → 自动进入该目录
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMkError(msg);
      if (msg.includes('已存在')) {
        // 定位到已存在项（进入过滤视图聚焦它）
        setFilter(name);
        const existing = dirs.find((d) => d.name === name);
        if (existing) void go(current).then(() => setFilter(name));
      }
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 面包屑 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-zinc-600">/</span>}
                <button
                  className="max-w-40 truncate rounded px-1 py-0.5 font-mono text-zinc-300 hover:bg-zinc-800"
                  onClick={() => void go(c.path)}
                  title={c.path}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          <button className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => void go(current.split('/').slice(0, -1).join('/') || '/')}>
            ⬆ 上级
          </button>
          <button className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 快捷位置 + 路径直达 + 过滤 */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 px-4 py-2 text-[11px]">
          {quickButtons.slice(0, 8).map((q) => (
            <button
              key={q.path ?? '~'}
              className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700"
              title={q.path ?? '主目录'}
              onClick={() => void go(q.path ?? undefined)}
            >
              {q.label}
            </button>
          ))}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤当前层…"
            className="ml-auto w-28 rounded-md bg-zinc-800 px-2 py-1 text-zinc-200 outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 px-4 py-2 text-[11px]">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pathInput.trim() !== '') void go(pathInput.trim());
            }}
            placeholder="粘贴绝对路径回车直达…"
            className="flex-1 rounded-md bg-zinc-800 px-2 py-1 font-mono text-zinc-200 outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500"
          />
          <button
            onClick={() => void go(pathInput.trim())}
            disabled={pathInput.trim() === ''}
            className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
          >
            直达
          </button>
        </div>

        {notice && <p className="px-4 pb-1 text-[11px] text-red-300">{notice}</p>}

        {/* 目录列表 + 内联新建 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {creating ? (
            <div className="flex items-center gap-2 rounded-lg bg-zinc-800/60 px-3 py-2">
              <span className="text-sm">📁</span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createFolder();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                    setMkError('');
                  }
                }}
                placeholder="新文件夹名称（禁 / 、.. 或点开头）"
                className="flex-1 rounded-md bg-zinc-900 px-2 py-1 text-sm text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-violet-500"
              />
              <button className="rounded-md bg-violet-500/80 px-2 py-1 text-xs text-white hover:bg-violet-500" onClick={() => void createFolder()}>
                创建
              </button>
              <button
                className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setMkError('');
                }}
              >
                取消
              </button>
            </div>
          ) : null}
          {mkError && <p className="px-3 py-1 text-[11px] text-red-300">{mkError}</p>}

          {shown.length === 0 && creating === false && (
            <p className="p-6 text-center text-xs text-zinc-600">
              {filter.trim() !== '' ? '无匹配的子目录' : '此目录暂无可见子目录（可新建文件夹后注册本层）'}
            </p>
          )}
          {shown.map((d) => (
            <div key={d.path} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-zinc-800/60">
              <button className="flex-1 truncate text-left text-sm text-zinc-300" onClick={() => void go(d.path)}>
                📁 {d.name}
              </button>
              <button
                className="ml-2 shrink-0 rounded-md bg-sky-500/20 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/30"
                onClick={() => onPick(d.path)}
              >
                选此目录
              </button>
            </div>
          ))}
        </div>

        {/* 底部：新建 + 注册当前层 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-zinc-800 p-3">
          <button
            className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700"
            onClick={() => {
              setCreating(true);
              setNewName('');
              setMkError('');
            }}
          >
            ＋ 新建文件夹
          </button>
          <button
            className="flex-1 rounded-lg bg-sky-500/20 px-3 py-2 text-xs text-sky-300 hover:bg-sky-500/30"
            onClick={() => onPick(current)}
            disabled={current === ''}
          >
            注册当前目录（{current || '…'}）
          </button>
        </div>
      </div>
    </div>
  );
}
