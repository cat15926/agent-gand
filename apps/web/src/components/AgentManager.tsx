import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentCapability, AgentDefinition, AgentInput, AgentOptions, McpStatus } from '@agent-gand/shared';
import * as api from '../services/api';
import { ApiError } from '../services/api';

const EMPTY: AgentInput = { id: '', name: '', description: '', capabilities: ['execute'], systemPrompt: '', model: 'mock:agent', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff' };
const capabilityLabel: Record<AgentCapability, string> = { execute: '执行', review: '审查', coordinate: '协调' };

export function AgentManager() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [form, setForm] = useState<AgentInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | 'file' | 'db'>('all');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const refresh = async () => setAgents(await api.getAgents(true));
  useEffect(() => { void Promise.all([refresh(), api.getAgentOptions().then(setOptions), api.getMcpStatus().then(setMcp)]); }, []);
  const sorted = useMemo(() => agents.filter((agent) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(needle))
      && (source === 'all' || agent.source === source)
      && (status === 'all' || agent.enabled === (status === 'enabled'));
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [agents, query, source, status]);

  function openCreate(templateId = 'blank') {
    const template = options?.templates.find((item) => item.id === templateId) ?? options?.templates[0];
    setEditing(null); setError(''); setForm(template ? { id: '', name: '', ...template.input } : { ...EMPTY });
  }
  function openEdit(agent: AgentDefinition) {
    setEditing(agent); setError(''); setForm({ id: agent.id, name: agent.name, description: agent.description ?? '', capabilities: agent.capabilities, systemPrompt: agent.systemPrompt, model: agent.model, tools: agent.tools, disallowedTools: agent.disallowedTools, permissionMode: agent.permissionMode, color: agent.color });
  }
  function openCopy(agent: AgentDefinition) {
    setEditing(null); setError(''); setForm({ id: `${agent.id}-copy`.slice(0, 48), name: `${agent.name} 副本`.slice(0, 40), description: agent.description ?? '', capabilities: agent.capabilities, systemPrompt: agent.systemPrompt, model: agent.model, tools: agent.tools, disallowedTools: agent.disallowedTools, permissionMode: agent.permissionMode, color: agent.color });
  }
  async function save() {
    if (!form || busy) return; setBusy(true); setError('');
    try { if (editing) await api.updateAgent(editing.id, form, editing.version); else await api.createAgent(form); await refresh(); setForm(null); }
    catch (reason) { setError(reason instanceof ApiError && Object.keys(reason.fieldErrors).length ? Object.entries(reason.fieldErrors).map(([field, message]) => `${field}：${message}`).join('；') : reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function toggle(agent: AgentDefinition) {
    setBusy(true); setError('');
    try { await api.setAgentEnabled(agent.id, !agent.enabled, agent.version); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function refreshMcp() {
    if (busy) return; setBusy(true); setError('');
    try {
      const next = await api.refreshMcpTools();
      setMcp(next);
      setOptions(await api.getAgentOptions());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setMcp(await api.getMcpStatus().catch(() => null));
    } finally { setBusy(false); }
  }

  return <div className="h-full overflow-y-auto p-4">
    <div className="mb-4 flex items-center justify-between"><div><h2 className="font-medium text-zinc-100">Agent 角色</h2><p className="mt-1 text-xs text-zinc-500">创建团队成员，配置职责、模型和工具权限。配置变更只影响之后创建的运行。</p></div>
      <button onClick={() => openCreate()} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white">＋ 创建角色</button></div>
    {error && <div className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</div>}
    {mcp && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
      <span className={mcp.connected ? 'text-emerald-400' : mcp.configured ? 'text-amber-400' : 'text-zinc-500'}>MCP · {mcp.connected ? `已连接（${mcp.tools.length} 个工具）` : mcp.configured ? '连接异常' : '未配置'}</span>
      {mcp.lastSeenAt && <span className="text-zinc-600">最近心跳 {new Date(mcp.lastSeenAt).toLocaleTimeString()}</span>}
      {mcp.lastError && <span className="min-w-0 flex-1 truncate text-amber-400" title={mcp.lastError}>{mcp.lastError}</span>}
      {mcp.configured && <button disabled={busy} onClick={() => void refreshMcp()} className="ml-auto rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-300 disabled:opacity-50">刷新连接</button>}
    </div>}
    <div className="mb-4 flex flex-wrap gap-2"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、ID 或描述" className="input max-w-sm text-sm"/><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-lg bg-zinc-900 px-3 py-2 text-xs"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><select value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="rounded-lg bg-zinc-900 px-3 py-2 text-xs"><option value="all">全部来源</option><option value="file">文件</option><option value="db">界面创建</option></select></div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{sorted.map((agent) => <article key={agent.id} className={`rounded-xl border p-4 ${agent.enabled ? 'border-zinc-800 bg-zinc-900/70' : 'border-zinc-900 bg-zinc-950 opacity-60'}`}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: agent.color }}/><h3 className="truncate font-medium text-zinc-100">{agent.name}</h3><span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">v{agent.version}</span></div><p className="mt-1 font-mono text-[11px] text-zinc-600">{agent.id} · {agent.source === 'file' ? '文件' : '界面创建'}</p></div><span className={`text-xs ${agent.enabled ? 'text-emerald-400' : 'text-zinc-600'}`}>{agent.enabled ? '已启用' : '已停用'}</span></div>
      <p className="mt-3 min-h-10 text-xs leading-5 text-zinc-400">{agent.description}</p>
      <div className="mt-3 flex flex-wrap gap-1">{agent.capabilities.map((cap) => <span key={cap} className="rounded-full bg-violet-500/10 px-2 py-1 text-[11px] text-violet-300">{capabilityLabel[cap]}</span>)}<span className={`rounded-full px-2 py-1 text-[11px] ${agent.model.startsWith('mock:') ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-800 text-zinc-400'}`}>{agent.model.startsWith('mock:') ? `演示 · ${agent.model}` : agent.model}</span></div>
      {agent.syncError && <p className="mt-3 text-xs text-amber-400">{agent.syncError}</p>}
      <div className="mt-4 flex gap-2"><button disabled={agent.source === 'file'} onClick={() => openEdit(agent)} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:text-zinc-600">编辑</button><button onClick={() => openCopy(agent)} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs">复制</button><button disabled={busy} onClick={() => void toggle(agent)} className="ml-auto rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">{agent.enabled ? '停用' : '启用'}</button></div>
    </article>)}</div>

    {form && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setForm(null); }}><div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">{editing ? `编辑 ${editing.name}` : '创建 Agent 角色'}</h2><p className="mt-1 text-xs text-zinc-500">角色 ID 创建后不可修改；保存时后端会再次校验全部字段。</p></div><button onClick={() => setForm(null)} className="text-zinc-500">✕</button></div>
      {!editing && options && <div className="mt-4 flex flex-wrap gap-2">{options.templates.map((item) => <button key={item.id} onClick={() => openCreate(item.id)} className="rounded-lg border border-zinc-800 px-3 py-2 text-left text-xs hover:border-violet-500"><b className="block text-zinc-200">{item.name}</b><span className="text-zinc-500">{item.description}</span></button>)}</div>}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="角色 ID"><input disabled={Boolean(editing)} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="qa-reviewer" className="input" /></Field>
        <Field label="显示名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="QA Reviewer" className="input" /></Field>
        <Field label="描述" wide><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input" /></Field>
        <Field label="模型"><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="anthropic:claude-..." className="input" />{form.model.startsWith('mock:') && <p className="mt-1 text-[11px] text-amber-300">Mock 仅用于演示路由和预设动作，不能进行开放式对话或多轮辩论。</p>}{options && <p className="mt-1 text-[11px] text-zinc-600">{options.providers.map((p) => `${p.label}${p.configured ? ' ✓' : '（未配置）'}`).join(' · ')}</p>}</Field>
        <Field label="主题色"><input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-10 w-full rounded-lg bg-zinc-900" /></Field>
        <Field label="能力" wide><div className="flex gap-2">{(['execute','review','coordinate'] as AgentCapability[]).map((cap) => <Check key={cap} checked={form.capabilities.includes(cap)} label={capabilityLabel[cap]} onChange={() => setForm({ ...form, capabilities: form.capabilities.includes(cap) ? form.capabilities.filter((x) => x !== cap) : [...form.capabilities, cap] })}/>)}</div></Field>
        <Field label="权限模式"><select value={form.permissionMode} onChange={(e) => setForm({ ...form, permissionMode: e.target.value as AgentInput['permissionMode'] })} className="input"><option value="readonly">只读</option><option value="confirm">白名单外需确认</option><option value="auto">仅白名单自动执行</option></select></Field>
        <Field label="允许工具"><div className="flex flex-wrap gap-2">{options?.tools.map((tool) => <Check key={tool.name} checked={form.tools.includes(tool.name)} label={`${tool.name}${tool.source === 'mcp' ? ' · MCP' : ''}`} onChange={() => setForm({ ...form, tools: form.tools.includes(tool.name) ? form.tools.filter((x) => x !== tool.name) : [...form.tools, tool.name], disallowedTools: form.disallowedTools.filter((x) => x !== tool.name) })}/>)}</div></Field>
        <Field label="明确禁用工具"><div className="flex flex-wrap gap-2">{options?.tools.map((tool) => <Check key={tool.name} checked={form.disallowedTools.includes(tool.name)} label={`${tool.name}${tool.source === 'mcp' ? ' · MCP' : ''}`} onChange={() => setForm({ ...form, disallowedTools: form.disallowedTools.includes(tool.name) ? form.disallowedTools.filter((x) => x !== tool.name) : [...form.disallowedTools, tool.name], tools: form.tools.filter((x) => x !== tool.name) })}/>)}</div></Field>
        <Field label="系统提示词" wide><textarea value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} rows={9} className="input resize-y font-mono text-xs" /></Field>
      </div>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button onClick={() => setForm(null)} className="rounded-lg px-4 py-2 text-sm text-zinc-400">取消</button><button disabled={busy} onClick={() => void save()} className="rounded-lg bg-violet-500 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '保存中…' : '保存角色'}</button></div>
    </div></div>}
  </div>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) { return <label className={wide ? 'sm:col-span-2' : ''}><span className="mb-1.5 block text-xs text-zinc-400">{label}</span>{children}</label>; }
function Check({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) { return <button type="button" onClick={onChange} className={`rounded-lg border px-3 py-2 text-xs ${checked ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-zinc-800 text-zinc-500'}`}>{checked ? '✓ ' : ''}{label}</button>; }
