import { useEffect, useMemo, useState } from 'react';
import type { AccountView, AgentCapability, AgentDefinition, AgentInput, AgentOptions, McpStatus } from '@agent-gand/shared';
import * as api from '../services/api';
import { ApiError } from '../services/api';
import * as accountApi from '../services/accounts';
import { onServerEvent } from '../services/ws';
import { roleConnection } from '../services/agentConnection';
import { AgentAvatar } from './AgentAvatar';
import { AgentWizard } from './AgentWizard';

const EMPTY: AgentInput = { id: '', name: '', description: '自定义团队角色', capabilities: ['execute'], systemPrompt: '你是团队中的专业执行者。请根据目标完成任务，并清楚说明结果。', model: 'openai:', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff', avatar: '🤖' };
const capabilityLabel: Record<AgentCapability, string> = { execute: '执行', review: '评审', coordinate: '协调' };
const toInput = (agent: AgentDefinition): AgentInput => ({ id: agent.id, name: agent.name, description: agent.description ?? '', capabilities: agent.capabilities, systemPrompt: agent.systemPrompt, model: agent.model, accountRef: agent.accountRef, requiresAccount: agent.requiresAccount, execution: agent.execution, tools: agent.tools, disallowedTools: agent.disallowedTools, permissionMode: agent.permissionMode, color: agent.color, avatar: agent.avatar ?? '' });
type Wizard = { instance: string; initial: AgentInput; editing: AgentDefinition | null; resume: boolean };

export function AgentManager({ onManageAccounts, onUseRole }: { onManageAccounts?: () => void; onUseRole?: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]); const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [options, setOptions] = useState<AgentOptions | null>(null); const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [wizard, setWizard] = useState<Wizard | null>(null); const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [created, setCreated] = useState<AgentDefinition | null>(null);
  const [query, setQuery] = useState(''); const [source, setSource] = useState<'all' | 'file' | 'db'>('all'); const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const refresh = async () => setAgents(await api.getAgents(true));
  const refreshAccounts = async () => { try { setAccounts((await accountApi.getAccounts(true)).accounts); } catch { /* Role list remains accessible without account management authorization. */ } };
  useEffect(() => {
    void Promise.all([refresh(), api.getAgentOptions().then(setOptions), api.getMcpStatus().then(setMcp)]).catch((reason: Error) => setError(reason.message));
    void refreshAccounts();
    return onServerEvent((event) => {
      if (event.type === 'agent.updated') void refresh().catch((reason: Error) => setError(reason.message));
      if (['account.updated', 'account.login.updated', 'account.revoked'].includes(event.type)) void refreshAccounts();
    });
  }, []);
  const sorted = useMemo(() => agents.filter((agent) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(needle)) && (source === 'all' || agent.source === source) && (status === 'all' || agent.enabled === (status === 'enabled'));
  }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [agents, query, source, status]);
  function openCreate(reset = false) {
    if (reset) try { sessionStorage.removeItem('gand:role-draft:v1:create'); } catch {}
    if (!reset && wizard && !wizard.editing) { setOpen(true); return; }
    setWizard({ instance: crypto.randomUUID(), initial: { ...EMPTY }, editing: null, resume: !reset }); setOpen(true); setError(''); setCreated(null);
  }
  function openEdit(agent: AgentDefinition) {
    if (wizard?.editing?.id !== agent.id) setWizard({ instance: crypto.randomUUID(), initial: toInput(agent), editing: agent, resume: true });
    setOpen(true); setError(''); setCreated(null);
  }
  function openCopy(agent: AgentDefinition) {
    const suffix = crypto.randomUUID().slice(0, 5);
    setWizard({ instance: crypto.randomUUID(), initial: { ...toInput(agent), id: `${agent.id.slice(0, 36)}-copy-${suffix}`, name: `${agent.name} 副本`.slice(0, 40) }, editing: null, resume: false }); setOpen(true); setError(''); setCreated(null);
  }
  async function toggle(agent: AgentDefinition) {
    setBusy(true); setError('');
    try { await api.setAgentEnabled(agent.id, !agent.enabled, agent.version); await refresh(); }
    catch (reason) { setError(reason instanceof ApiError ? [...new Set([reason.message, ...Object.values(reason.fieldErrors)])].join('；') : reason instanceof Error ? reason.message : '状态修改失败'); }
    finally { setBusy(false); }
  }
  async function refreshMcp() {
    setBusy(true); setError('');
    try { setMcp(await api.refreshMcpTools()); setOptions(await api.getAgentOptions()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '刷新失败'); setMcp(await api.getMcpStatus().catch(() => null)); }
    finally { setBusy(false); }
  }
  return <div className="h-full overflow-y-auto p-4 sm:p-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-medium text-zinc-100">Agent 角色</h2><p className="mt-1 text-xs text-zinc-500">定义职责、选择账户与模型、确认权限。配置变更只影响之后创建的运行。</p></div><div className="flex flex-wrap gap-2">{onManageAccounts && <button onClick={onManageAccounts} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">账户与密钥</button>}<button onClick={() => openCreate()} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white">＋ 创建角色</button><button onClick={() => openCreate(true)} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500">新建空白角色</button></div></div>
    {error && <div role="alert" className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
    {created && <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200"><span>「{created.name}」已{created.enabled ? '保存' : '保存为停用草稿'}。</span>{created.enabled && onUseRole && <button onClick={() => onUseRole(created.id)} className="rounded-lg bg-emerald-500/20 px-3 py-2 text-xs">加入建房草稿</button>}{!created.enabled && <button onClick={() => openEdit(created)} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs">修复连接并启用</button>}<button aria-label="关闭角色保存提示" onClick={() => setCreated(null)} className="ml-auto px-2">✕</button></div>}
    {mcp && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"><span className={mcp.connected ? 'text-emerald-400' : mcp.configured ? 'text-amber-400' : 'text-zinc-500'}>MCP · {mcp.connected ? `已连接（${mcp.tools.length} 个工具）` : mcp.configured ? '连接异常' : '未配置'}</span>{mcp.lastError && <span className="min-w-0 flex-1 truncate text-amber-400" title={mcp.lastError}>{mcp.lastError}</span>}{mcp.configured && <button disabled={busy} onClick={() => void refreshMcp()} className="ml-auto rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-300">刷新连接</button>}</div>}
    <div className="mb-4 flex flex-wrap gap-2"><input aria-label="搜索角色" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、ID 或描述" className="input max-w-sm text-sm" /><select aria-label="筛选角色状态" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-lg bg-zinc-900 px-3 py-2 text-xs"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><select aria-label="筛选角色来源" value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="rounded-lg bg-zinc-900 px-3 py-2 text-xs"><option value="all">全部来源</option><option value="file">文件</option><option value="db">界面创建</option></select></div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{sorted.map((agent) => {
      const connection = roleConnection(agent, accounts);
      const driver = agent.execution?.kind === 'external' ? options?.executionDrivers?.find((item) => item.id === (agent.execution?.kind === 'external' ? agent.execution.driver : '')) : null;
      if (driver && !driver.available) { connection.status = `客户端不可用 · ${connection.status}`; connection.warning = true; }
      return <article key={agent.id} aria-label={`角色 ${agent.name}`} className={`rounded-xl border p-4 ${agent.enabled ? 'border-zinc-800 bg-zinc-900/70' : 'border-zinc-800 bg-zinc-950'}`}>
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><AgentAvatar agent={agent} className="h-10 w-10 text-base" /><div className="min-w-0"><h3 className="truncate font-medium text-zinc-100">{agent.name} <span className="text-[10px] text-zinc-500">v{agent.version}</span></h3><p className="mt-1 break-all font-mono text-[11px] text-zinc-600">{agent.id} · {agent.source === 'file' ? '文件' : '界面创建'}</p></div></div><span className={`shrink-0 text-xs ${agent.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>{agent.enabled ? '已启用' : '已停用'}</span></div>
        <p className="mt-3 min-h-10 text-xs leading-5 text-zinc-400">{agent.description}</p><div className="mt-3 flex flex-wrap gap-1">{agent.capabilities.map((cap) => <span key={cap} className="rounded-full bg-violet-500/10 px-2 py-1 text-[11px] text-violet-300">{capabilityLabel[cap]}</span>)}<span className="max-w-full break-all rounded-full bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400">{agent.model}</span></div>
        <div className="mt-3 rounded-lg bg-zinc-950/60 p-3 text-xs leading-5"><p className="break-all text-zinc-300">{connection.label}</p><p className={connection.warning ? 'text-amber-300' : 'text-zinc-500'}>{connection.status}</p>{connection.warning && onManageAccounts && <button onClick={onManageAccounts} className="mt-1 text-violet-300">修复账户 →</button>}</div>
        {agent.syncError && <p className="mt-3 text-xs text-amber-400">{agent.syncError}</p>}<div className="mt-4 flex flex-wrap gap-2"><button disabled={agent.source === 'file'} onClick={() => openEdit(agent)} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:text-zinc-600">编辑</button><button onClick={() => openCopy(agent)} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs">复制</button><button disabled={busy} onClick={() => void toggle(agent)} className="ml-auto rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">{agent.enabled ? '停用' : '启用'}</button></div>
      </article>;
    })}</div>
    {wizard && <AgentWizard key={wizard.instance} initial={wizard.initial} editing={wizard.editing} resume={wizard.resume} options={options} open={open} onClose={() => setOpen(false)} onSaved={(agent) => { setOpen(false); setWizard(null); setCreated(agent); void refresh(); void refreshAccounts(); }} />}
  </div>;
}
