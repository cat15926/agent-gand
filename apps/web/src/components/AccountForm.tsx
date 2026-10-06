import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AccountInput, AccountProtocol, AccountProvider, AccountView } from '@agent-gand/shared';
import * as api from '../services/accounts';
import { ApiError } from '../services/api';

const protocolLabels: Record<AccountProtocol, string> = {
  'anthropic-messages': 'Anthropic Messages · 模型 API / Claude',
  'openai-chat-completions': 'Chat Completions · 模型 API',
  'openai-responses': 'Responses · Codex',
};
const presets = {
  anthropic: { baseUrl: 'https://api.anthropic.com', protocols: ['anthropic-messages'] as AccountProtocol[] },
  openai: { baseUrl: 'https://api.openai.com/v1', protocols: ['openai-chat-completions', 'openai-responses'] as AccountProtocol[] },
  custom: { baseUrl: '', protocols: [] as AccountProtocol[] },
};
export function AccountForm({ account, mode, onClose, onSaved, preset }: { account?: AccountView; mode: 'create' | 'edit' | 'key'; onClose: () => void; onSaved: (account?: AccountView) => void; preset?: { provider?: AccountProvider; authType?: 'api_key' | 'native_login'; nativeClient?: 'claude' | 'codex' } }) {
  const titleId = useId(); const panel = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<AccountInput>({ displayName: account?.displayName ?? '', provider: account?.provider ?? preset?.provider ?? 'anthropic',
    apiKey: '', baseUrl: account?.connection.baseUrl ?? presets[preset?.provider ?? 'anthropic'].baseUrl, protocols: account?.connection.protocols ?? presets[preset?.provider ?? 'anthropic'].protocols,
    models: account?.connection.models ?? [], defaultModel: account?.connection.defaultModel ?? null, timeoutMs: account?.connection.timeoutMs ?? 180000,
    authHeader: account?.connection.authHeader ?? 'x-api-key' });
  const [authType, setAuthType] = useState<'api_key' | 'native_login'>(account?.authType ?? preset?.authType ?? 'api_key');
  const [nativeClient, setNativeClient] = useState<'claude' | 'codex'>(account?.nativeClient ?? preset?.nativeClient ?? 'codex');
  const [modelText, setModelText] = useState(form.models.join('\n'));
  const [advanced, setAdvanced] = useState(form.provider === 'custom');
  const [visibleKey, setVisibleKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
    return () => previous?.focus();
  }, []);
  const models = [...new Set(modelText.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
  function providerChanged(provider: AccountProvider) { setForm({ ...form, provider, ...presets[provider], authHeader: 'x-api-key' }); setAdvanced(provider === 'custom'); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    try {
      let saved: AccountView | undefined;
      if (authType === 'native_login') saved = mode === 'create' ? await api.createAccount({ displayName: form.displayName, authType, nativeClient }) : await api.updateAccount(account!.id, { displayName: form.displayName, expectedVersion: account!.version });
      else if (mode === 'key') await api.replaceAccountKey(account!.id, form.apiKey, account!.version);
      else {
        const input = { ...form, models, defaultModel: models.includes(form.defaultModel ?? '') ? form.defaultModel : models[0] ?? null };
        if (mode === 'create') saved = await api.createAccount(input);
        else { const { apiKey: _key, provider: _provider, ...connection } = input; await api.updateAccount(account!.id, { ...connection, expectedVersion: account!.version }); }
      }
      setForm((current) => ({ ...current, apiKey: '' })); onSaved(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); if (cause instanceof ApiError) setFields(cause.fieldErrors); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl sm:p-6" onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panel.current!.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]'));
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="mb-5 flex items-start justify-between gap-3"><div><h2 id={titleId} className="text-lg font-semibold">{mode === 'key' ? '替换 API Key' : mode === 'edit' ? '编辑连接配置' : '添加账户或密钥'}</h2><p className="mt-1 text-xs leading-5 text-zinc-500">{mode === 'key' ? `替换「${account?.displayName}」的密钥，原密钥不会显示。` : '为连接起一个容易辨认的名称。保存只检查配置，不会调用模型。'}</p></div><button type="button" aria-label="关闭账户表单" disabled={busy} onClick={onClose} className="rounded p-2 text-zinc-400 hover:bg-zinc-800">✕</button></div>
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        {mode === 'create' && <Field label="认证方式"><select aria-label="认证方式" value={authType} onChange={(event) => setAuthType(event.target.value as typeof authType)} className="input"><option value="api_key">API Key</option><option value="native_login">登录账户</option></select></Field>}
        {authType === 'native_login' && <><Field label="账户名称" error={fields.displayName}><input aria-label="账户名称" required maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：个人 Codex、团队 Claude" className="input" /></Field><Field label="登录客户端"><select aria-label="登录客户端" value={nativeClient} disabled={mode === 'edit'} onChange={(event) => setNativeClient(event.target.value as typeof nativeClient)} className="input"><option value="codex">Codex</option><option value="claude">Claude Code · 只读分析</option></select></Field><p className="text-xs leading-6 text-zinc-400">创建独立的登录身份，在供应商页面完成授权。{nativeClient === 'claude' ? 'Claude 登录通过本地终端引导，目前支持只读 CLI 分析。完整执行请使用 API Key。' : 'Codex 使用设备码授权；无需填写 Token 或认证目录。'}</p></>}
        {authType === 'api_key' && mode !== 'key' && <>
          <Field label="连接名称" error={fields.displayName}><input aria-label="连接名称" required maxLength={80} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：团队 Claude、公司模型网关" className="input" /></Field>
          <Field label="服务类型" error={fields.provider}><select aria-label="服务类型" disabled={mode === 'edit'} value={form.provider} onChange={(event) => providerChanged(event.target.value as AccountProvider)} className="input disabled:opacity-60"><option value="anthropic">Anthropic / Claude</option><option value="openai">OpenAI / Codex</option><option value="custom">兼容服务 / 自定义网关</option></select></Field>
        </>}
        {authType === 'api_key' && mode !== 'edit' && <Field label="API Key" error={fields.apiKey}><div className="flex gap-2"><input aria-label="API Key" required minLength={8} maxLength={16384} type={visibleKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="粘贴供应商提供的密钥" className="input min-w-0 flex-1" /><button type="button" aria-pressed={visibleKey} onClick={() => setVisibleKey(!visibleKey)} className="rounded-lg bg-zinc-800 px-3 text-xs text-zinc-300">{visibleKey ? '隐藏' : '显示'}</button></div><p className="mt-1.5 text-xs text-zinc-500">保存后加密存储，仅显示末四位；无法从页面取回原密钥。</p></Field>}
        {authType === 'api_key' && mode !== 'key' && <>
          {mode === 'edit' && <div className="rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400">密钥{account?.hasCredential ? '已设置' : '未设置'}。更换密钥请使用列表中的“替换密钥”。</div>}
          {form.provider !== 'custom' && <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="break-all text-zinc-500">服务地址：{form.baseUrl}</span><button type="button" onClick={() => setAdvanced(!advanced)} className="text-violet-300">{advanced ? '收起高级设置' : '地址与高级设置'}</button></div>}
          {(advanced || form.provider === 'custom') && <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <Field label="服务地址" error={fields.baseUrl}><input aria-label="服务地址" required type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://gateway.example.com/v1" className="input" /><p className="mt-1 text-xs text-zinc-500">密钥将用于此地址。请填写接口根地址，不包含用户名、密码或查询参数。</p></Field>
            {form.protocols.includes('anthropic-messages') && <Field label="Messages 认证" error={fields.authHeader}><select aria-label="Messages 认证" value={form.authHeader} onChange={(event) => setForm({ ...form, authHeader: event.target.value as AccountInput['authHeader'] })} className="input"><option value="x-api-key">x-api-key · Anthropic 官方</option><option value="bearer">Bearer Token · 智谱等兼容服务</option></select><p className="mt-1 text-xs text-zinc-500">智谱 Claude Code 兼容接口使用 Bearer Token；密钥仍由服务端保管。</p></Field>}
            <fieldset><legend className="mb-2 text-xs text-zinc-400">支持的接口</legend><div className="space-y-2">{(Object.keys(protocolLabels) as AccountProtocol[]).filter((protocol) => form.provider === 'custom' || (form.provider === 'anthropic' ? protocol === 'anthropic-messages' : protocol !== 'anthropic-messages')).map((protocol) => <label key={protocol} className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={form.protocols.includes(protocol)} onChange={() => setForm({ ...form, protocols: form.protocols.includes(protocol) ? form.protocols.filter((item) => item !== protocol) : [...form.protocols, protocol] })} className="accent-violet-500" />{protocolLabels[protocol]}</label>)}</div>{fields.protocols && <p role="alert" className="mt-2 text-xs text-red-300">{fields.protocols}</p>}<p className="mt-2 text-xs leading-5 text-zinc-500">Chat Completions 与 Responses 是不同接口。勾选表示服务支持该接口，尚未经过模型实测。</p></fieldset>
            <Field label="请求超时（秒）" error={fields.timeoutMs}><input aria-label="请求超时（秒）" type="number" min={1} max={600} step={1} value={form.timeoutMs / 1000} onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) * 1000 })} className="input" /></Field>
          </div>}
          <Field label="模型列表（可选）" error={fields.models}><textarea aria-label="模型列表（可选）" rows={3} value={modelText} onChange={(event) => setModelText(event.target.value)} placeholder="填写原生模型 ID，每行一个；也可用逗号分隔" className="input resize-y font-mono text-xs" /><p className="mt-1 text-xs text-zinc-500">不需要 openai: 或 anthropic: 前缀。模型列表由你维护，保存不会检测模型权限。</p></Field>
          {models.length > 0 && <Field label="推荐默认模型" error={fields.defaultModel}><select aria-label="推荐默认模型" value={models.includes(form.defaultModel ?? '') ? form.defaultModel! : models[0]} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} className="input">{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></Field>}
        </>}
        {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-4"><button type="button" disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-zinc-400">取消</button><button disabled={busy} type="submit" className="rounded-lg bg-violet-500 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '保存中…' : mode === 'key' ? '替换密钥' : authType === 'native_login' && mode === 'create' ? '创建并登录' : '保存连接'}</button></div>
      </form>
    </div>
  </div>;
}
function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs text-zinc-400">{label}</span>{children}{error && <span role="alert" className="mt-1 block text-xs text-red-300">{error}</span>}</label>;
}
