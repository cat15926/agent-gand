import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AccountReferences, AccountView } from '@agent-gand/shared';
import * as api from '../../services/accounts';
import { onServerEvent } from '../../services/ws';
import { AccountActionPanel, backendNames as detailedBackendNames } from '../AccountActionPanel';
import { AccountForm } from '../AccountForm';

const providerNames = { anthropic: 'Anthropic', openai: 'OpenAI', custom: '兼容服务' };
const authenticationNames = { configured: '密钥已设置', missing: '未设置密钥', locked: '密钥已锁定', unchecked: '认证未检测', pending: '待登录', authenticated: '已登录', expired: '登录已失效' };
const backendNames = { 'builtin-anthropic': '模型 API', 'builtin-openai': '模型 API', 'claude-sdk': 'Claude Code', 'claude-cli': 'Claude 只读', 'codex-app-server': 'Codex', 'codex-exec': 'Codex 只读' };
export function AccountsView({ onRoles }: { onRoles: () => void }) {
  const [accounts, setAccounts] = useState<AccountView[]>([]); const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<{ mode: 'local' | 'token'; available: boolean } | null>(null);
  const [connected, setConnected] = useState(false); const [token, setToken] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''); const [provider, setProvider] = useState('all'); const [status, setStatus] = useState('all'); const [kind, setKind] = useState('all');
  const [form, setForm] = useState<{ mode: 'create' | 'edit' | 'key'; account?: AccountView } | null>(null);
  const [actionPanel, setActionPanel] = useState<{ account: AccountView; mode: 'login' | 'test'; autoStart?: boolean } | null>(null);
  const [refPanel, setRefPanel] = useState<{ account: AccountView; refs: AccountReferences } | null>(null);
  const refresh = useCallback(async () => { const data = await api.getAccounts(true); setAccounts(data.accounts); }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try { const mode = await api.getAccountAccess(); if (!live) return; setAccess(mode); if (mode.mode === 'local' && mode.available) { await api.connectAccounts(); if (!live) return; await refresh(); if (live) setConnected(true); } }
      catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '加载账户失败'); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    if (!connected) return;
    return onServerEvent((event) => { if (event.type === 'account.updated' || event.type === 'agent.updated' || event.type === 'account.login.updated') void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '刷新失败')); });
  }, [connected, refresh]);
  const filtered = useMemo(() => accounts.filter((account) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${account.displayName} ${account.id} ${account.connection.baseUrl}`.toLowerCase().includes(needle))
      && (provider === 'all' || account.provider === provider) && (kind === 'all' || account.authType === kind)
      && (status === 'all' ? !account.archived : status === 'archived' ? account.archived : status === 'enabled' ? account.enabled && !account.archived : !account.enabled && !account.archived);
  }), [accounts, query, provider, kind, status]);
  async function perform(action: () => Promise<unknown>, success = '') {
    setBusy(true); setError(''); setMessage('');
    try { await action(); await refresh(); if (success) setMessage(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault(); await perform(async () => { await api.connectAccounts(token); setToken(''); setConnected(true); });
  }
  function remove(account: AccountView) {
    void perform(async () => {
      const refs = await api.getAccountReferences(account.id);
      if (refs.roles.length || refs.activeRuns.length) { setRefPanel({ account, refs }); throw new Error('账户仍有引用，请先处理关联角色或运行。'); }
      if (!window.confirm(`${refs.historicalRunCount || refs.historicalRoleVersionCount ? '归档' : '删除'}「${account.displayName}」并删除保存的密钥？`)) return;
      await api.deleteAccount(account.id, account.version);
    });
  }
  return <div className="h-full overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold text-zinc-100">账户与密钥</h1><p className="mt-1.5 text-sm text-zinc-500">统一保存模型连接，管理密钥和已有认证来源。</p></div><div className="flex gap-2"><button onClick={onRoles} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">管理角色</button><button disabled={!connected || busy} onClick={() => { setError(''); setForm({ mode: 'create' }); }} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">＋ 添加账户或密钥</button></div></div>
      {error && <div role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {message && <div role="status" className="mb-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</div>}
      {loading ? <p className="py-12 text-center text-sm text-zinc-500">正在加载账户…</p> : !connected ? <div className="mx-auto max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6"><h2 className="font-medium">连接账户管理</h2>{access?.available ? <form onSubmit={(event) => void unlock(event)} className="mt-4 space-y-3">{access.mode === 'token' && <label className="block text-xs text-zinc-400">管理口令<input required type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className="input mt-2" /></label>}<button disabled={busy} className="rounded-lg bg-violet-500 px-4 py-2 text-sm text-white">{busy ? '连接中…' : '连接'}</button></form> : <p className="mt-3 text-sm leading-6 text-zinc-400">账户管理尚未开放，请由服务管理员配置访问认证与可信来源。</p>}</div> : <>
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs leading-6 text-zinc-400">密钥加密保存，页面仅显示末四位。创建角色时可选择这里的账户与模型，也可在角色向导中新增连接。测试只证明所选方式及模型可用，已有角色保留原配置。</div>
        <div className="mb-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_150px_130px_130px]"><input aria-label="搜索账户" placeholder="搜索名称或服务地址" value={query} onChange={(event) => setQuery(event.target.value)} className="input min-w-0 text-sm" /><select aria-label="筛选供应商" value={provider} onChange={(event) => setProvider(event.target.value)} className="input min-w-0 text-xs"><option value="all">全部供应商</option>{Object.entries(providerNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="筛选认证类型" value={kind} onChange={(event) => setKind(event.target.value)} className="input min-w-0 text-xs"><option value="all">全部类型</option><option value="api_key">API Key</option><option value="native_login">登录账户</option></select><select aria-label="筛选账户状态" value={status} onChange={(event) => setStatus(event.target.value)} className="input min-w-0 text-xs"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="archived">已归档</option></select></div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((account) => <article key={account.id} className={`flex flex-col rounded-2xl border bg-zinc-900/60 p-4 ${account.enabled && !account.archived ? 'border-zinc-800' : 'border-zinc-800/60 opacity-70'}`}>
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate font-medium text-zinc-100" title={account.displayName}>{account.displayName}</h2><p className="mt-1 text-xs text-zinc-500">{providerNames[account.provider]} · {account.authType === 'api_key' ? 'API Key' : '登录账户'} · {account.id.slice(0, 8)}</p></div><span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${account.source === 'managed' ? 'bg-violet-500/15 text-violet-300' : 'bg-zinc-800 text-zinc-400'}`}>{account.source === 'managed' ? '托管' : account.source === 'legacy_env' ? '旧环境配置' : '旧登录来源'}</span></div>
          <p className="mt-3 break-all text-xs leading-5 text-zinc-500">{account.connection.baseUrl || (account.source === 'managed' ? `${account.nativeClient === 'codex' ? 'Codex' : 'Claude'} 独立登录身份` : account.nativeClient === 'codex' ? '专用 Codex 认证目录' : 'CLI 既有认证来源')}</p>
          <div className="mt-3 flex flex-wrap gap-1.5"><span className={`rounded-full px-2 py-1 text-[11px] ${['configured', 'authenticated'].includes(account.authentication) ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{authenticationNames[account.authentication]}{account.keySuffix ? ` · ••••${account.keySuffix}` : ''}</span><span className="rounded-full bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400">{({ untested: '模型未测试', passed: '模型测试通过', failed: '模型测试失败', stale: '测试已过期' })[account.testStatus]}</span>{(!account.enabled || account.archived) && <span className="rounded-full bg-zinc-800 px-2 py-1 text-[11px] text-zinc-500">{account.archived ? '已归档' : account.revoked ? '已撤销' : '已停用'}</span>}</div>
          {account.identitySummary && <p className="mt-2 break-all text-xs text-zinc-300">{account.identitySummary}</p>}
          {account.lastTest && <p className="mt-2 break-all text-xs text-zinc-500">最近测试：{detailedBackendNames[account.lastTest.backend]} · {account.lastTest.model}</p>}
          <p className="mt-3 text-xs leading-5 text-zinc-400">适用：{[...new Set(account.compatibleBackends.map((backend) => backendNames[backend]))].join(' / ')}</p>
          <p className="mt-2 truncate text-xs text-zinc-500" title={account.connection.models.join('、')}>{account.connection.models.length ? `${account.connection.models.length} 个模型 · ${account.connection.defaultModel ?? account.connection.models[0]}` : account.authType === 'native_login' ? '客户端默认模型 · 测试时可指定模型 ID' : '尚未维护模型列表'}</p>
          <button disabled={busy} onClick={() => void perform(async () => setRefPanel({ account, refs: await api.getAccountReferences(account.id) }))} className="mt-3 self-start text-xs text-violet-300">{account.roleCount} 个关联角色 →</button>
          {!account.archived && <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-800 pt-3 text-xs">
            <button disabled={busy} onClick={() => void perform(async () => { const result = await api.checkAccount(account.id); setMessage(result.ok ? '配置与认证检查通过；未发送模型请求。' : `${authenticationNames[result.authentication]}，未进行模型调用。`); })} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-300">检查状态</button>
            {account.source === 'managed' && <><button disabled={busy || account.revoked} onClick={() => setForm({ mode: 'edit', account })} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-300">编辑</button>{account.authType === 'native_login' && <button disabled={busy || !account.enabled || account.revoked} onClick={() => setActionPanel({ account, mode: 'login' })} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-300">{account.authentication === 'authenticated' ? '重新登录' : '登录'}</button>}<button disabled={busy || !account.enabled || account.revoked} onClick={() => setActionPanel({ account, mode: 'test' })} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-300">测试模型</button>{account.authType === 'api_key' && <button disabled={busy || account.revoked} onClick={() => setForm({ mode: 'key', account })} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-300">替换密钥</button>}<button disabled={busy || account.revoked} onClick={() => void perform(() => api.updateAccount(account.id, { expectedVersion: account.version, enabled: !account.enabled }))} className="rounded-md px-2 py-1.5 text-zinc-400 hover:bg-zinc-800">{account.enabled ? '停用' : '启用'}</button><button disabled={busy} onClick={() => remove(account)} className="rounded-md px-2 py-1.5 text-red-400/80 hover:bg-red-500/10">删除</button>{!account.revoked && <button disabled={busy} onClick={() => void perform(async () => { const refs = await api.getAccountReferences(account.id); if (window.confirm(`立即撤销「${account.displayName}」？将中止 ${refs.activeRuns.length} 个未完成运行${refs.activeRuns.length ? '：' + refs.activeRuns.map((run) => run.id.slice(0, 8)).join('、') : ''}。撤销后请创建新账户。`)) { await api.revokeAccount(account.id, account.version); setMessage('账户已撤销，依赖执行已停止。'); } })} className="rounded-md px-2 py-1.5 text-red-400/80">立即撤销</button>}{account.hasCredential && account.authType === 'api_key' && !account.revoked && <button disabled={busy} onClick={() => { if (window.confirm(`清除「${account.displayName}」当前密钥？旧版本仍按运行引用保留。`)) void perform(() => api.clearAccountKey(account.id, account.version)); }} className="rounded-md px-2 py-1.5 text-zinc-500 hover:bg-zinc-800">清除密钥</button>}</>}
          </div>}
        </article>)}</div>
        {filtered.length === 0 && <div className="rounded-2xl border border-dashed border-zinc-800 py-14 text-center text-sm text-zinc-500">没有符合条件的账户。可以调整筛选，或添加账户或密钥。</div>}
        {access?.mode === 'token' && <button className="mt-5 text-xs text-zinc-500" onClick={() => { void api.disconnectAccounts().then(() => setConnected(false)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '断开失败')); }}>断开管理会话</button>}
      </>}
      {refPanel && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setRefPanel(null); }}><div role="dialog" aria-modal="true" aria-label="账户引用" className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5"><div className="flex justify-between"><h2 className="font-semibold">{refPanel.account.displayName} · 引用</h2><button aria-label="关闭引用详情" onClick={() => setRefPanel(null)}>✕</button></div><div className="mt-4 space-y-2">{refPanel.refs.roles.map((role) => <p key={role.id} className="rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300">{role.name} <span className="text-xs text-zinc-500">{role.id} · {role.implicit ? '旧配置隐式引用' : '显式绑定'} · {role.enabled ? '启用' : '停用'}</span></p>)}{!refPanel.refs.roles.length && <p className="text-sm text-zinc-500">暂无关联角色</p>}<p className="pt-2 text-xs text-zinc-500">未完成运行 {refPanel.refs.activeRuns.length} 个 · 历史运行 {refPanel.refs.historicalRunCount} 个 · 历史角色版本 {refPanel.refs.historicalRoleVersionCount} 个</p></div><button onClick={() => { setRefPanel(null); onRoles(); }} className="mt-5 rounded-lg bg-violet-500 px-4 py-2 text-sm text-white">前往角色管理</button></div></div>}
      {actionPanel && <AccountActionPanel key={`${actionPanel.mode}:${actionPanel.account.id}`} {...actionPanel} onClose={() => setActionPanel(null)} onChanged={() => void refresh().catch((error: Error) => setError(error.message))} />}
      {form && <AccountForm key={`${form.mode}:${form.account?.id ?? 'new'}`} {...form} onClose={() => setForm(null)} onSaved={(account) => { setForm(null); void perform(async () => {}, '账户连接已保存。'); if (account?.authType === 'native_login') setActionPanel({ account, mode: 'login', autoStart: true }); }} />}
    </div>
  </div>;
}
