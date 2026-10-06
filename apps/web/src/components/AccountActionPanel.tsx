import { useEffect, useRef, useState } from 'react';
import type { AccountBackend, AccountLoginOperation, AccountTestResult, AccountView } from '@agent-gand/shared';
import * as api from '../services/accounts';

export const backendNames: Record<AccountBackend, string> = { 'builtin-anthropic': '模型 API · Anthropic Messages', 'builtin-openai': '模型 API · Chat Completions', 'claude-sdk': 'Claude Code · SDK', 'claude-cli': 'Claude Code · 只读 CLI', 'codex-app-server': 'Codex · app-server', 'codex-exec': 'Codex · 只读 CLI' };
const loginNames = { starting: '正在准备登录', pending: '等待授权', completed: '登录成功', failed: '登录失败', cancelled: '已取消', expired: '已过期', interrupted: '服务重启，登录已停止' };
const pending = (operation: AccountLoginOperation | null) => !!operation && ['starting', 'pending'].includes(operation.status);
export function AccountActionPanel({ account, mode, onClose, onChanged, autoStart = false, initialBackend, initialModel }: { account: AccountView; mode: 'login' | 'test'; onClose: () => void; onChanged: () => void; autoStart?: boolean; initialBackend?: AccountBackend; initialModel?: string }) {
  const [operation, setOperation] = useState<AccountLoginOperation | null>(null);
  const [backend, setBackend] = useState<AccountBackend>(initialBackend ?? account.compatibleBackends[0] ?? 'builtin-openai');
  const [model, setModel] = useState(initialModel ?? account.connection.defaultModel ?? (account.authType === 'native_login' ? 'default' : ''));
  const [result, setResult] = useState<AccountTestResult | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(account.version);
  const initialLogin = useRef<Promise<AccountLoginOperation | null> | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => previous?.focus(); }, []);
  useEffect(() => { if (!busy || mode !== 'test') return; const started = Date.now(); setElapsed(0); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => clearInterval(timer); }, [busy, mode]);
  useEffect(() => { let live = true; if (mode === 'login') { initialLogin.current ??= api.pendingLogin(account.id).then((op) => op ?? (autoStart ? api.startLogin(account.id, account.version) : null)); void initialLogin.current.then((op) => { if (live) { setOperation(op); onChanged(); } }).catch((error: Error) => { if (live) setError(error.message); }); } return () => { live = false; }; }, [account.id, mode, autoStart]);
  useEffect(() => {
    if (!pending(operation)) return;
    let live = true; let inFlight = false;
    const timer = setInterval(() => { if (inFlight) return; inFlight = true; void api.getLogin(operation!.id).then((op) => { if (!live) return; setOperation(op); if (!pending(op)) { onChanged(); void api.getAccounts().then((data) => { const account = data.accounts.find((item) => item.id === op.accountId); if (live && account) setCurrentVersion(account.version); }); } }).catch((error: Error) => { if (live) setError(error.message); }).finally(() => { inFlight = false; }); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [operation?.id, operation?.status, onChanged]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); onChanged(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); } }
  const button = 'rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 disabled:opacity-50';
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setError('复制失败，请手动选中并复制。'); } }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={mode === 'login' ? '账户登录' : '模型连接测试'} className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')); const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="flex justify-between gap-3"><h2 className="text-lg font-semibold">{account.displayName} · {mode === 'login' ? '登录账户' : '测试模型'}</h2><button disabled={busy} aria-label="关闭账户操作" onClick={onClose} className="p-1 text-zinc-400">✕</button></div>
      {mode === 'login' ? <div className="mt-5 space-y-4">
        <p className="text-sm leading-6 text-zinc-400">每次登录建立独立的身份代次。已开始的运行保留原身份，新运行使用新身份。此操作不会调用模型。</p>
        {operation && <p role="status" className="text-sm text-violet-300">{loginNames[operation.status]} · 身份代次 {operation.generation}</p>}
        {pending(operation) && <>
          {operation?.verificationUrl && <div className="rounded-xl bg-zinc-900 p-4"><p className="text-xs text-zinc-400">打开供应商授权页面，输入一次性代码：</p><div className="mt-3 flex flex-wrap items-center gap-3"><code className="break-all text-xl tracking-wider text-zinc-100">{operation.userCode}</code><button className={button} onClick={() => void copy(operation.userCode!)}>{copied ? '已复制' : '复制代码'}</button></div><a href={operation.verificationUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block rounded-lg bg-violet-500 px-4 py-2 text-sm text-white">打开授权页面 ↗</a></div>}
          {operation?.terminalCommand && <div className="rounded-xl bg-zinc-900 p-4"><p className="text-xs leading-6 text-zinc-400">在此项目的本地终端运行下面的命令，按 Claude 提示完成授权，再点击“重新检测”。</p><code className="mt-3 block break-all rounded-lg bg-black/30 p-3 text-xs text-zinc-200">{operation.terminalCommand}</code><button className={`${button} mt-3`} onClick={() => void copy(operation.terminalCommand!)}>{copied ? '已复制' : '复制命令'}</button></div>}
          <p className="text-xs text-zinc-500">有效至 {new Date(operation!.expiresAt).toLocaleTimeString()}。关闭面板后可重新打开继续；“取消登录”会停止授权操作。</p>
          <div className="flex flex-wrap gap-2"><button disabled={busy} className={button} onClick={() => void perform(async () => { const op = await api.checkLogin(operation!.id); setOperation(op); const current = await api.getAccounts(); setCurrentVersion(current.accounts.find((item) => item.id === account.id)?.version ?? currentVersion); })}>重新检测</button><button disabled={busy} className={button} onClick={() => void perform(async () => setOperation(await api.cancelLogin(operation!.id)))}>取消登录</button></div>
        </>}
        {operation?.error && <p className="text-sm text-amber-300">{operation.error}</p>}
        {!pending(operation) && <button disabled={busy || !account.enabled || account.revoked} className="rounded-lg bg-violet-500 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={() => void perform(async () => { const current = (await api.getAccounts()).accounts.find((item) => item.id === account.id)!; setCurrentVersion(current.version); setOperation(await api.startLogin(account.id, current.version)); setCopied(false); })}>{busy ? '准备中…' : operation ? '重新登录' : '开始登录'}</button>}
      </div> : <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); setResult(null); void perform(async () => setResult(await api.testAccount(account.id, backend, model, currentVersion))); }}>
        <p className="rounded-xl bg-amber-500/10 p-3 text-xs leading-6 text-amber-200">测试会向当前服务发送最小模型请求，可能消耗额度。仅测试所选接入方式和模型，关闭原生工具及会话复用。</p>
        {account.authType === 'api_key' && <div className="rounded-xl bg-zinc-900 p-3 text-xs leading-6 text-zinc-400"><p>请求目标</p><code className="block break-all text-zinc-200">{account.connection.baseUrl}</code>{account.connection.protocols.includes('anthropic-messages') && <p className="mt-2">Messages 认证：{account.connection.authHeader === 'bearer' ? 'Bearer Token' : 'x-api-key'}</p>}</div>}
        <label className="block text-xs text-zinc-400">接入方式<select aria-label="接入方式" className="input mt-2" value={backend} disabled={busy} onChange={(event) => setBackend(event.target.value as AccountBackend)}>{account.compatibleBackends.map((id) => <option key={id} value={id}>{backendNames[id]}</option>)}</select></label>
        <label className="block text-xs text-zinc-400">原生模型 ID<input aria-label="原生模型 ID" required disabled={busy} list="account-test-models" className="input mt-2" value={model} onChange={(event) => setModel(event.target.value)} placeholder="填写要验证的模型 ID" /><datalist id="account-test-models">{account.connection.models.map((id) => <option key={id} value={id} />)}</datalist></label>
        {account.authType === 'native_login' && <p className="text-xs text-zinc-500">default 表示使用该客户端的默认模型。</p>}
        {busy && <p role="status" className="text-xs leading-6 text-violet-300">正在启动客户端并等待模型响应，已等待 {elapsed} 秒；本次超时上限为 {account.connection.timeoutMs / 1000} 秒。</p>}
        {result && <div role="status" className={`rounded-xl p-3 text-sm ${result.status === 'passed' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{result.status === 'passed' ? '测试通过' : result.status === 'stale' ? '连接版本已变化，本次结果已过期' : '测试失败'}<p className="mt-1 break-all text-xs">{backendNames[result.backend]} · {result.model}</p>{result.error && <p className="mt-2 text-xs">{result.error}</p>}</div>}
        <button disabled={busy || !account.enabled || account.revoked} className="rounded-lg bg-violet-500 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? '正在测试…' : '发送测试请求'}</button>
      </form>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
    </div>
  </div>;
}
