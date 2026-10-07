import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AccountView, AgentCapability, AgentDefinition, AgentInput, AgentOptions, AgentPreflight, AccountBackend } from '@agent-gand/shared';
import * as api from '../services/api';
import * as accountApi from '../services/accounts';
import { ApiError } from '../services/api';
import { onServerEvent } from '../services/ws';
import { authNames, compileConnection, compatibleAccount, initialConnection, productBackends, productNames, scopedTest, selectAccount, unavailableAccount, type AgentConnection, type AgentProduct } from '../services/agentConnection';
import { AgentAvatar } from './AgentAvatar';
import { AccountForm } from './AccountForm';
import { AccountActionPanel, backendNames } from './AccountActionPanel';
import { RoleAccountsPanel } from './RoleAccountsPanel';
import { readRoleDraft, type ConnectionDraft, type RoleDraft, type RolePolicy } from '../services/roleDraft';

const policy = (form: AgentInput): RolePolicy => ({ execution: form.execution, permissionMode: form.permissionMode, tools: form.tools, disallowedTools: form.disallowedTools, capabilities: form.capabilities });
const permissions = { readonly: '只读分析', confirm: '写入需确认', auto: '按白名单执行' };
const capabilities: Record<AgentCapability, string> = { execute: '执行', review: '评审', coordinate: '协调' };
const avatars = ['🤖', '🧭', '🧑‍💻', '🔍', '🧠', '🎨', '🚀', '🍗'];
export function AgentWizard({ open, initial, editing, options, resume = true, onClose, onSaved }: {
  open: boolean; initial: AgentInput; editing: AgentDefinition | null; options: AgentOptions | null; resume?: boolean;
  onClose: () => void; onSaved: (agent: AgentDefinition) => void;
}) {
  const draftKey = `gand:role-draft:v1:${editing?.id ?? 'create'}`;
  const [savedDraft] = useState(() => resume ? readRoleDraft(draftKey, editing?.version ?? null) : null);
  const [form, setForm] = useState<AgentInput>(savedDraft?.form ?? initial);
  const [connection, setConnection] = useState<AgentConnection>(savedDraft?.connection ?? (editing || initial.id ? initialConnection(initial) : { product: 'api', backend: 'builtin-openai', model: '', accountId: '', implicit: false }));
  const connections = useRef<Partial<Record<AgentProduct, ConnectionDraft>>>(savedDraft?.connections ?? {});
  const [step, setStep] = useState(savedDraft?.step ?? 0); const [idEdited, setIdEdited] = useState(savedDraft?.idEdited ?? !!initial.id);
  const [accounts, setAccounts] = useState<AccountView[]>([]); const [accountError, setAccountError] = useState(''); const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [token, setToken] = useState(''); const [access, setAccess] = useState<'local' | 'token' | null>(null);
  const [subPanel, setSubPanel] = useState<'create' | 'manage' | null>(null);
  const [action, setAction] = useState<{ account: AccountView; mode: 'login' | 'test'; autoStart?: boolean } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fields, setFields] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<AgentPreflight | null>(null); const [checking, setChecking] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [notice, setNotice] = useState(savedDraft ? `已恢复未保存的角色草稿。${savedDraft.pendingAvatarName ? '刷新前未上传的头像需重新选择。' : ''}` : '');
  const [avatarFile, setAvatarFile] = useState<File | null>(null); const [avatarPreview, setAvatarPreview] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null); const panel = useRef<HTMLDivElement>(null); const titleId = useId();
  const focusedStep = useRef(step);
  const idSeed = useRef(crypto.randomUUID().slice(0, 8)); const preselected = useRef(Boolean(editing || initial.id || savedDraft));
  const selected = accounts.find((account) => account.id === connection.accountId);
  const compiled = useMemo(() => compileConnection(form, connection), [form, connection]);
  const candidates = accounts.filter((account) => compatibleAccount(account, connection.product) && (account.source === 'managed' || account.id === connection.accountId));
  const unavailable = selected ? unavailableAccount(selected) : connection.product === 'demo' ? null : '请选择账户或密钥';
  const readonlyCli = connection.product !== 'api' && connection.product !== 'demo' && ['claude-cli', 'codex-exec'].includes(connection.backend);
  const native = compiled.execution?.kind === 'external' ? compiled.execution : null;
  const driver = native ? options?.executionDrivers?.find((item) => item.id === native.driver) : null;
  const modelOptions = selected?.connection.models ?? [];
  const hasDefault = selected?.authType === 'native_login' || (connection.implicit && native);
  const blocking = connection.product !== 'demo' && ((!connection.accountId) || !!unavailable || !selected?.compatibleBackends.includes(connection.backend)) || !!(native && driver && !driver.available);
  const childOpen = !!subPanel || !!action;

  async function refreshAccounts() { const response = await accountApi.getAccounts(true); setAccounts(response.accounts); setAccountError(''); }
  useEffect(() => {
    let live = true;
    void (async () => { try { const mode = await accountApi.getAccountAccess(); if (!live) return; setAccess(mode.mode); if (mode.available) await refreshAccounts(); else setAccountError('账户管理尚未开放，请联系服务管理员。'); } catch (reason) { if (live) setAccountError(reason instanceof Error ? reason.message : '账户加载失败'); } finally { if (live) setLoadingAccounts(false); } })();
    const off = onServerEvent((event) => { if (['account.updated', 'account.login.updated', 'account.revoked'].includes(event.type)) void refreshAccounts().catch(() => {}); });
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    if (preselected.current || loadingAccounts) return;
    preselected.current = true;
    const usable = candidates.filter((account) => account.source === 'managed' && !unavailableAccount(account));
    if (usable.length === 1) setConnection(selectAccount(connection, usable[0]!));
  }, [loadingAccounts, accounts]);
  useEffect(() => {
    const draft: RoleDraft = { form: compiled, connection, step, idEdited, connections: connections.current, version: editing?.version ?? null, ...(avatarFile ? { pendingAvatarName: avatarFile.name } : {}) };
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Keep the live form if browser storage is unavailable. */ }
  }, [compiled, connection, step, idEdited, draftKey, editing?.version, avatarFile]);
  useEffect(() => {
    if (!open || childOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-step-focus]:not([disabled])')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open, childOpen]);
  useEffect(() => {
    if (!open || childOpen) return;
    const invalid = panel.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
    if (invalid?.getClientRects().length) invalid.focus();
    else if (focusedStep.current !== step) panel.current?.querySelector<HTMLElement>('[data-step-focus]:not([disabled])')?.focus();
    focusedStep.current = step;
  }, [open, childOpen, step, fields]);
  useEffect(() => () => { if (avatarPreview) URL.revokeObjectURL(avatarPreview); }, [avatarPreview]);
  useEffect(() => {
    setPreview(null); if (!open || step !== 2) { setChecking(false); return; }
    let live = true; setChecking(true);
    const timer = setTimeout(() => { void api.preflightAgent(compiled).then((result) => { if (live) setPreview(result); }).catch((reason) => { if (live) { setPreview(null); setFields(reason instanceof ApiError ? reason.fieldErrors : {}); setError(reason instanceof Error ? reason.message : '配置检查失败'); if (reason instanceof ApiError && ['id', 'name', 'description', 'systemPrompt', 'avatar'].some((key) => reason.fieldErrors[key])) setStep(0); } }).finally(() => { if (live) setChecking(false); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [compiled, accounts, step, open, checkRevision]);

  function changeConnection(next: AgentConnection, base = compiled) {
    const normalized = compileConnection(base, next);
    const changes = [base.capabilities.includes('coordinate') && !normalized.capabilities.includes('coordinate') ? '外部接入不支持协调能力' : '', base.permissionMode !== normalized.permissionMode ? `权限调整为${permissions[normalized.permissionMode]}` : '', base.tools.length && !normalized.tools.length ? '原工具免审列表已清空' : ''].filter(Boolean);
    setConnection(next); setForm(normalized); setFields({}); setError(''); if (changes.length) setNotice(changes.join('；') + '。');
  }
  function changeProduct(product: AgentProduct) {
    if (product === connection.product) return;
    connections.current[connection.product] = { connection, policy: policy(compiled) };
    const cached = connections.current[product];
    let next: AgentConnection = cached?.connection ?? { product, accountId: '', backend: product === 'claude' ? 'claude-sdk' : product === 'codex' ? 'codex-app-server' : 'builtin-openai', model: product === 'demo' ? 'agent' : '', implicit: false };
    const usable = accounts.filter((account) => account.source === 'managed' && compatibleAccount(account, product) && !unavailableAccount(account));
    if (!cached && usable.length === 1) next = selectAccount(next, usable[0]!);
    changeConnection(next, { ...compiled, ...(cached?.policy ?? { execution: undefined, tools: [], disallowedTools: [], permissionMode: form.capabilities.includes('review') ? 'readonly' : 'confirm', capabilities: compiled.capabilities }) });
  }
  function changeName(name: string) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39);
    setForm({ ...form, name, ...(!idEdited ? { id: slug.length >= 2 && /^[a-z]/.test(slug) ? slug : `role-${idSeed.current}` } : {}) });
  }
  function setAvatar(avatar: string) { if (avatarInput.current) avatarInput.current.value = ''; setAvatarFile(null); setAvatarPreview(''); setForm({ ...form, avatar }); setFields({}); }
  function upload(file?: File) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) { setFields({ avatar: '请选择小于 5 MB 的 PNG、JPEG、WebP 或 GIF。' }); return; }
    setAvatarFile(file); setAvatarPreview(URL.createObjectURL(file)); setFields({});
  }
  function next() {
    const nextFields: Record<string, string> = {};
    if (step === 0) {
      if (!form.name.trim()) nextFields.name = '请填写显示名称';
      if (!form.description.trim()) nextFields.description = '请填写一句话职责';
      if (!form.systemPrompt.trim()) nextFields.systemPrompt = '请填写系统提示词';
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(form.id)) nextFields.id = '角色 ID 需以小写字母开头，共 2–48 位';
    } else if (!connection.model.trim()) nextFields.model = '请选择或填写模型 ID';
    setFields(nextFields); setError('');
    if (Object.keys(nextFields).length) return;
    setStep(step + 1);
  }
  async function save(enabled: boolean) {
    if (busy) return; setBusy(true); setError(''); setFields({});
    try {
      if (enabled) {
        if (blocking || (connection.product !== 'demo' && !connection.accountId)) throw new Error('请修复账户与接入方式，或保存为停用草稿。');
      }
      const input = { ...compiled, enabled, ...(avatarFile ? await api.uploadAgentAvatar(avatarFile) : {}) };
      const agent = editing ? await api.updateAgent(editing.id, input, editing.version) : await api.createAgent(input);
      try { sessionStorage.removeItem(draftKey); } catch { /* The saved role remains valid without browser storage. */ } onSaved(agent);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); if (reason instanceof ApiError) { setFields(reason.fieldErrors); if (['id', 'name', 'description', 'systemPrompt', 'avatar'].some((key) => reason.fieldErrors[key])) setStep(0); else if (['accountRef', 'model', 'execution'].some((key) => reason.fieldErrors[key])) setStep(1); } }
    finally { setBusy(false); }
  }
  async function accountSaved(account?: AccountView) {
    setSubPanel(null); await refreshAccounts();
    if (account && compatibleAccount(account, connection.product)) {
      changeConnection(selectAccount(connection, account)); setNotice(`已选择「${account.displayName}」。`);
      if (account.authType === 'native_login') setAction({ account, mode: 'login', autoStart: true });
    } else if (account) setNotice(`「${account.displayName}」已保存，但与当前接入方式不兼容，请调整接入方式。`);
  }
  if (!open) return null;
  const button = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 disabled:opacity-40';
  return <>
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-2 sm:p-5" onMouseDown={(event) => { if (!busy && !childOpen && event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal={!childOpen} aria-labelledby={titleId} aria-hidden={childOpen || undefined} inert={childOpen || undefined} tabIndex={-1} className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl" onKeyDown={(event) => {
        if (childOpen) return;
        if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') return;
        const nodes = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]):not([type="file"]),textarea:not([disabled]),select:not([disabled]),summary,a[href]')).filter((node) => node.getClientRects().length);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header className="shrink-0 border-b border-zinc-800 px-4 py-4 sm:px-6"><div className="flex items-start justify-between gap-3"><div><h2 id={titleId} className="text-lg font-semibold">{editing ? `编辑 ${editing.name}` : '创建 Agent 角色'}</h2><p className="mt-1 text-xs text-zinc-500">先定义职责，再选择连接，最后确认权限。关闭后保留本次草稿。</p></div><button aria-label="关闭角色向导" disabled={busy} onClick={onClose} className="p-2 text-zinc-400">✕</button></div><ol className="mt-4 grid grid-cols-3 gap-2">{['角色职责', '接入与模型', '权限与确认'].map((label, index) => <li key={label}><button disabled={busy || index > step} aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)} className={`w-full rounded-lg px-2 py-2 text-xs ${step === index ? 'bg-violet-500/20 text-violet-200' : 'bg-zinc-900 text-zinc-500'}`}>{index + 1} · {label}</button></li>)}</ol></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {notice && <p role="status" className="mb-4 rounded-lg bg-violet-500/10 p-3 text-xs leading-5 text-violet-200">{notice}</p>}
          {step === 0 && <div className="space-y-4">
            {!editing && <Field label="角色模板"><select aria-label="角色模板" className="input" defaultValue="" onChange={(event) => { const template = options?.templates.find((item) => item.id === event.target.value); if (template) { if (template.id === 'planner') changeProduct('api'); setForm({ ...form, ...template.input, permissionMode: template.id === 'executor' ? 'confirm' : template.input.permissionMode, tools: template.id === 'executor' ? template.input.tools.filter((tool) => options?.tools.find((item) => item.name === tool)?.readonly) : template.input.tools }); setNotice(template.id === 'planner' ? '规划主管使用模型 API；已应用协调职责和提示词。' : '已应用模板职责、提示词和权限；显示名称与当前连接保留。'); } }}><option value="">选择模板（可选）</option>{options?.templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.description}</option>)}</select></Field>}
            <Field label="显示名称" error={fields.name}><input data-step-focus aria-label="显示名称" aria-invalid={!!fields.name} maxLength={40} value={form.name} onChange={(event) => changeName(event.target.value)} placeholder="例如：代码评审者" className="input" /></Field>
            <Field label="一句话职责" error={fields.description}><input aria-label="一句话职责" aria-invalid={!!fields.description} maxLength={300} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="input" /></Field>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); upload(event.dataTransfer.files[0]); }}>
              <AgentAvatar agent={{ ...compiled, avatar: avatarPreview || form.avatar, source: 'db', enabled: true, version: 1 }} className="h-14 w-14 text-2xl" />
              <input ref={avatarInput} aria-label="上传头像文件" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(event) => upload(event.target.files?.[0])} />
              <button className={button} onClick={() => { if (avatarInput.current) { avatarInput.current.value = ''; avatarInput.current.click(); } }}>上传头像</button><span className="max-w-full break-all text-xs text-zinc-500">{avatarFile ? `已选择 ${avatarFile.name}，保存时上传` : "最大 5 MB · 可拖入"}</span>
              <div className="flex flex-wrap gap-1">{avatars.map((avatar) => <button aria-label={`头像 ${avatar}`} aria-pressed={!avatarFile && form.avatar === avatar} key={avatar} onClick={() => setAvatar(avatar)} className="rounded-lg bg-zinc-800 p-2 text-lg">{avatar}</button>)}</div>
              {fields.avatar && <p role="alert" className="text-xs text-red-300">{fields.avatar}</p>}
            </div>
            <details open={!!fields.systemPrompt || undefined} className="rounded-xl border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-300">系统提示词</summary><Field label="系统提示词" error={fields.systemPrompt}><textarea aria-label="系统提示词" aria-invalid={!!fields.systemPrompt} className="input mt-3 resize-y text-sm" rows={7} value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} /></Field></details>
            <details open={!!fields.id || !!fields.avatar || undefined} className="rounded-xl border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-400">身份高级设置</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="角色 ID" error={fields.id}><input aria-label="角色 ID" aria-invalid={!!fields.id} disabled={!!editing} value={form.id} onChange={(event) => { setIdEdited(true); setForm({ ...form, id: event.target.value.toLowerCase() }); }} className="input" /><p className="mt-1 text-xs text-zinc-500">自动生成，创建后不可修改。</p></Field><Field label="主题色"><input aria-label="主题色" type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} className="h-10 w-full rounded bg-zinc-900" /></Field><Field label="头像文字或 HTTPS 地址"><input aria-label="头像文字或 HTTPS 地址" disabled={!!avatarFile} value={form.avatar} onChange={(event) => setAvatar(event.target.value)} className="input" /></Field></div></details>
          </div>}
          {step === 1 && <div className="space-y-4">
            <fieldset><legend className="mb-2 text-xs text-zinc-400">接入方式</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(Object.keys(productNames) as AgentProduct[]).map((product) => <button data-step-focus={product === connection.product || undefined} aria-pressed={product === connection.product} key={product} onClick={() => changeProduct(product)} className={`rounded-xl border px-3 py-3 text-sm ${product === connection.product ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-zinc-800 text-zinc-400'}`}>{productNames[product]}</button>)}</div></fieldset>
            {connection.product === 'demo' ? <><p className="rounded-xl bg-amber-500/10 p-3 text-sm leading-6 text-amber-200">演示使用本地预设动作，无需外部账户，无法进行真实模型对话。</p><Field label="演示角色"><select aria-label="演示角色" value={connection.model} onChange={(event) => changeConnection({ ...connection, model: event.target.value })} className="input">{['agent', 'planner', 'coder', 'reviewer'].map((model) => <option value={model} key={model}>{model}</option>)}{!['agent', 'planner', 'coder', 'reviewer'].includes(connection.model) && <option value={connection.model}>{connection.model}</option>}</select></Field></> : <>
              {loadingAccounts ? <p className="text-sm text-zinc-500">正在加载账户…</p> : accountError ? <div className="rounded-xl border border-amber-500/30 p-3 text-sm text-amber-200"><p>{accountError}</p>{access === 'token' && <Field label="账户管理口令"><input aria-label="账户管理口令" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className="input mt-2" /></Field>}<button className={`${button} mt-3`} onClick={() => void accountApi.connectAccounts(access === 'token' ? token : undefined).then(() => { setToken(''); return refreshAccounts(); }).catch((reason: Error) => setAccountError(reason.message))}>连接账户管理</button></div> : <>
                <Field label="账户或密钥" error={fields.accountRef}><select aria-label="账户或密钥" aria-invalid={!!fields.accountRef} className="input" value={connection.accountId} onChange={(event) => { const account = accounts.find((item) => item.id === event.target.value); if (account) changeConnection(selectAccount(connection, account)); else changeConnection({ ...connection, accountId: '', implicit: false, model: '' }); }}><option value="">请选择账户或密钥</option>{candidates.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {unavailableAccount(account) ?? authNames[account.authentication]} · {account.id.slice(0, 8)}{account.source !== 'managed' ? ' · 旧来源' : ''}</option>)}{connection.accountId && !candidates.some((account) => account.id === connection.accountId) && <option value={connection.accountId}>{selected?.displayName ?? '原绑定账户'} · 不可用或不兼容</option>}</select></Field>
                <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setSubPanel('create')}>{connection.product === 'claude' ? '＋ 添加 Claude 密钥或账户' : connection.product === 'codex' ? '＋ 添加 Codex 密钥或账户' : '＋ 新增账户或密钥'}</button><button className={button} onClick={() => setSubPanel('manage')}>管理账户</button><button className={button} onClick={() => void refreshAccounts().catch((reason: Error) => setAccountError(reason.message))}>刷新账户</button></div>
                {!candidates.length && <p className="text-sm text-zinc-400">没有匹配账户。{connection.product === 'claude' ? '添加 Messages 密钥用于编码，或登录 Claude 进行只读分析。' : connection.product === 'codex' ? '添加 Responses 密钥或登录 Codex。' : '添加支持 Messages 或 Chat Completions 的密钥。'}</p>}
              </>}
              {selected && <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs leading-6 text-zinc-400"><p className="break-all text-zinc-200">{selected.displayName} · {selected.connection.baseUrl || '独立登录身份'}</p><p>{authNames[selected.authentication]} · {scopedTest(selected, connection.backend, connection.model)}</p>{unavailable && <p className="text-amber-300">{unavailable}。请修复账户，或保存为停用草稿。</p>}{connection.implicit && <p>保留此角色原有认证来源；更换账户后使用显式绑定。</p>}{selected.authType === 'native_login' && selected.source === 'managed' && <button className="mt-2 text-violet-300" disabled={!selected.enabled || selected.revoked} onClick={() => setAction({ account: selected, mode: 'login' })}>{selected.authentication === 'authenticated' ? '重新登录' : '完成登录'}</button>}</div>}
              <Field label="模型" error={fields.model}><select aria-label="模型候选" value={modelOptions.includes(connection.model) || (hasDefault && connection.model === 'default') ? connection.model : '__custom__'} onChange={(event) => changeConnection({ ...connection, model: event.target.value === '__custom__' ? '' : event.target.value })} className="input"><option value="__custom__">自定义模型 ID</option>{modelOptions.map((model) => <option key={model} value={model}>{model}{model === selected?.connection.defaultModel ? ' · 账户推荐' : ' · 账户维护'}</option>)}{hasDefault && <option value="default">使用客户端默认模型</option>}</select>{(!modelOptions.includes(connection.model) && !(hasDefault && connection.model === 'default')) && <input aria-label="自定义模型 ID" aria-invalid={!!fields.model} className="input mt-2" value={connection.model} onChange={(event) => changeConnection({ ...connection, model: event.target.value })} placeholder="填写供应商原生模型 ID" />}<p className="mt-2 text-xs leading-5 text-zinc-500">候选来自账户维护，尚不代表模型权限。填写原生 ID，无需添加路由前缀。</p></Field>
              {connection.product === 'api' && selected && productBackends('api').filter((backend) => selected.compatibleBackends.includes(backend)).length > 1 && <Field label="模型接口"><select aria-label="模型接口" className="input" value={connection.backend} onChange={(event) => changeConnection({ ...connection, backend: event.target.value as AccountBackend })}>{productBackends('api').filter((backend) => selected.compatibleBackends.includes(backend)).map((backend) => <option key={backend} value={backend}>{backendNames[backend]}</option>)}</select></Field>}
              {native && <><p className="text-xs leading-6 text-zinc-400">{readonlyCli ? '当前为只读分析，仅支持顺序流水线。' : '支持编码、评审和自由协作。'} 外部接入不能担任规划主管；协调能力只适用于模型 API。</p><details className="rounded-xl border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-400">接入高级设置</summary><Field label="执行载体"><select aria-label="执行载体" className="input mt-3" value={connection.backend} onChange={(event) => changeConnection({ ...connection, backend: event.target.value as AccountBackend })}>{productBackends(connection.product).map((backend) => <option key={backend} value={backend}>{backendNames[backend]}</option>)}</select></Field><p className="mt-2 text-xs text-zinc-500">{driver?.available ? `客户端 ${driver.version}` : driver?.error ?? '正在检测客户端'}</p>{selected && !selected.compatibleBackends.includes(connection.backend) && <p role="alert" className="mt-2 text-xs text-amber-300">当前账户不支持此载体，请更换账户或恢复原载体。</p>}</details></>}
              <details className="text-xs text-zinc-500"><summary className="cursor-pointer">查看不匹配的账户</summary><ul className="mt-2 space-y-2">{accounts.filter((account) => account.source === 'managed' && !compatibleAccount(account, connection.product)).map((account) => <li key={account.id}>{account.displayName}：{account.authType === 'native_login' ? '登录客户端不匹配；Claude 登录仅支持只读分析' : connection.product === 'codex' ? '需要 Responses 接口' : connection.product === 'claude' ? '需要 Messages 接口' : '需要模型 API 接口'}</li>)}</ul></details>
            </>}
          </div>}
          {step === 2 && <div className="space-y-4">
            <Field label="执行权限" error={fields.permissionMode}><select data-step-focus aria-label="执行权限" value={compiled.permissionMode} disabled={!!readonlyCli} onChange={(event) => setForm({ ...compiled, permissionMode: event.target.value as AgentInput['permissionMode'], ...(native && event.target.value === 'readonly' ? { execution: { ...native, nativeTools: [] } } : {}) })} className="input"><option value="readonly">只读分析</option>{!readonlyCli && <option value="confirm">写入需确认</option>}{!readonlyCli && connection.backend !== 'codex-app-server' && <option value="auto">按白名单执行</option>}</select></Field>
            <div role="region" aria-label="实际权限预览" data-step-focus={readonlyCli || undefined} tabIndex={readonlyCli ? -1 : undefined} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs leading-6 text-zinc-400"><p className="font-medium text-zinc-200">实际权限预览 {checking && '· 检查中…'}</p>{preview ? <><p>{preview.permissions.summary}</p>{native && <p>原生会话：{preview.permissions.session}</p>}<p>原生免审工具：{preview.permissions.nativeTools.join('、') || '无'}</p><p>可执行的平台工具：{preview.permissions.platformTools.join('、') || '无额外业务工具'}</p><p>平台免审工具：{preview.permissions.allowedTools.join('、') || '无'}</p><p>明确禁用：{preview.permissions.deniedTools.join('、') || '无'}</p>{preview.permissions.limits.map((limit) => <p key={limit}>{limit}</p>)}</> : <p>保存前由服务端核对连接与工具策略；不会调用模型。</p>}</div>
            <details className="rounded-xl border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-300">权限与运行高级设置</summary><div className="mt-4 space-y-4">
              <Field label="角色能力"><div className="flex flex-wrap gap-2">{(['execute', 'review', 'coordinate'] as AgentCapability[]).filter((cap) => !native || cap !== 'coordinate').map((cap) => <Check key={cap} checked={compiled.capabilities.includes(cap)} label={capabilities[cap]} onChange={() => setForm({ ...compiled, capabilities: compiled.capabilities.includes(cap) ? compiled.capabilities.filter((item) => item !== cap) : [...compiled.capabilities, cap] })} />)}</div></Field>
              {native && !readonlyCli && <Field label="原生会话复用"><select aria-label="原生会话复用" value={native.sessionPolicy ?? 'turn'} onChange={(event) => setForm({ ...compiled, execution: { ...native, sessionPolicy: event.target.value as 'turn' | 'run' | 'conversation' } })} className="input"><option value="turn">每回合新会话</option><option value="run">同一运行内复用</option><option value="conversation">同一聊天室复用</option></select></Field>}
              {native?.driver === 'claude-sdk' && compiled.permissionMode !== 'readonly' && <Field label="原生工具免审白名单"><div className="flex flex-wrap gap-2">{['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'].map((tool) => <Check key={tool} label={tool} checked={!!native.nativeTools?.includes(tool)} onChange={() => setForm({ ...compiled, execution: { ...native, nativeTools: native.nativeTools?.includes(tool) ? native.nativeTools.filter((item) => item !== tool) : [...(native.nativeTools ?? []), tool] } })} />)}</div><p className="mt-2 text-xs text-zinc-500">写工具和 Shell 默认不免审；Bash 仍须使用沙箱。</p></Field>}
              {native && !readonlyCli && <Field label="向外部角色开放的平台工具"><div className="flex flex-wrap gap-2">{options?.tools.map((tool) => <Check key={tool.name} label={tool.name} checked={!!native.platformTools?.includes(tool.name)} onChange={() => setForm({ ...compiled, execution: { ...native, platformTools: native.platformTools?.includes(tool.name) ? native.platformTools.filter((item) => item !== tool.name) : [...(native.platformTools ?? []), tool.name] }, tools: compiled.tools.filter((item) => item !== tool.name), disallowedTools: compiled.disallowedTools.filter((item) => item !== tool.name) })} />)}</div></Field>}
              {!readonlyCli && <>{(['tools', 'disallowedTools'] as const).map((field) => <Field key={field} label={field === 'tools' ? '平台工具免审白名单' : '明确禁用工具'}><div className="flex flex-wrap gap-2">{options?.tools.filter((tool) => !native || native.platformTools?.includes(tool.name)).map((tool) => <Check key={tool.name} label={`${tool.name}${tool.source === 'mcp' ? ' · MCP' : ''}`} checked={compiled[field].includes(tool.name)} onChange={() => setForm({ ...compiled, [field]: compiled[field].includes(tool.name) ? compiled[field].filter((item) => item !== tool.name) : [...compiled[field], tool.name], [field === 'tools' ? 'disallowedTools' : 'tools']: compiled[field === 'tools' ? 'disallowedTools' : 'tools'].filter((item) => item !== tool.name) })} />)}</div></Field>)}</>}
            </div></details>
            <dl className="grid gap-2 rounded-xl border border-zinc-800 p-4 text-sm sm:grid-cols-[80px_1fr]">{[['角色', form.name], ['职责', form.description], ['接入方式', productNames[connection.product]], ['账户', selected?.displayName ?? (connection.product === 'demo' ? '无需账户' : connection.accountId || '未选择')], ['模型', connection.model || '未填写'], ['权限', permissions[compiled.permissionMode]]].map(([label, value]) => <div key={label} className="contents"><dt className="text-zinc-500">{label}</dt><dd className="min-w-0 break-words text-zinc-200">{value}</dd></div>)}</dl>
            {selected && connection.product !== 'demo' && <p className="text-xs text-zinc-500">{scopedTest(selected, connection.backend, connection.model)}。认证已设置但未测试也可保存；模型权限以实际调用为准。</p>}
            {checking && <p role="status" className="text-xs text-zinc-400">正在检查账户身份和客户端，完成后可保存。</p>}
            {preview && !preview.ok && <div role="alert" className="rounded-xl bg-amber-500/10 p-3 text-xs leading-6 text-amber-200">{Object.values(preview.issues).map((issue) => <p key={issue}>{issue}</p>)}<p>可以先保存为停用草稿，修复后再启用。</p></div>}
            {!checking && !preview?.ok && <button className={button} disabled={busy} onClick={() => { setError(''); setFields({}); setCheckRevision((revision) => revision + 1); }}>重新检查</button>}
          </div>}
          {error && <p role="alert" className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
          {Object.entries(fields).filter(([key]) => !['name', 'description', 'id', 'avatar', 'systemPrompt', 'model', 'accountRef', 'permissionMode'].includes(key)).map(([key, value]) => <p role="alert" className="mt-2 text-xs text-red-300" key={key}>{value}</p>)}
        </div>
        <footer className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-4 py-3 sm:px-6">{step === 2 && <div className="mb-3 space-y-1 text-[11px] text-zinc-400"><p className="truncate" title={`${form.name} · ${form.description}`}>角色：{form.name} · 职责：{form.description}</p><p className="truncate" title={`${productNames[connection.product]} · ${selected?.displayName ?? "未选择账户"} · ${connection.model} · ${permissions[compiled.permissionMode]}`}>{productNames[connection.product]} · {selected?.displayName ?? (connection.product === "demo" ? "无需账户" : "未选择账户")} · {connection.model} · {permissions[compiled.permissionMode]}</p></div>}<div className="flex flex-wrap items-center justify-between gap-2"><button className={button} disabled={busy} onClick={step ? () => { setStep(step - 1); setFields({}); setError(''); } : onClose}>{step ? '上一步' : '保留草稿并关闭'}</button><div className="flex flex-wrap gap-2">{step < 2 ? <button disabled={busy} onClick={next} className="rounded-lg bg-violet-500 px-5 py-2 text-sm font-medium text-white">下一步</button> : <>
          {selected?.source === 'managed' && <button className={button} disabled={busy || !!unavailable || !connection.model || !selected.compatibleBackends.includes(connection.backend)} onClick={() => setAction({ account: selected, mode: 'test' })}>测试连接</button>}
          <button className={button} disabled={busy} onClick={() => void save(false)}>保存为停用草稿</button><button disabled={busy || checking || blocking || !preview?.ok} onClick={() => void save(true)} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{busy ? '保存中…' : editing?.enabled === false ? '保存并启用' : '保存角色'}</button>
        </>}</div></div></footer>
      </div>
    </div>
    {subPanel === 'create' && <AccountForm mode="create" preset={connection.product === 'codex' ? { provider: 'openai', nativeClient: 'codex' } : { provider: 'anthropic', nativeClient: 'claude' }} onClose={() => setSubPanel(null)} onSaved={(account) => void accountSaved(account).catch((reason: Error) => setAccountError(reason.message))} />}
    {subPanel === 'manage' && <RoleAccountsPanel onClose={() => { setSubPanel(null); void refreshAccounts().catch(() => {}); }} />}
    {action && <AccountActionPanel key={`${action.mode}:${action.account.id}`} {...action} initialBackend={connection.backend} initialModel={connection.model} onClose={() => { setAction(null); void refreshAccounts().catch(() => {}); }} onChanged={() => void refreshAccounts().catch(() => {})} />}
  </>;
}
function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) { return <div><label className="mb-1.5 block text-xs text-zinc-400">{label}</label>{children}{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>; }
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) { return <button type="button" aria-pressed={checked} onClick={onChange} className={`rounded-lg border px-3 py-2 text-xs ${checked ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-zinc-800 text-zinc-500'}`}>{checked ? '✓ ' : ''}{label}</button>; }
