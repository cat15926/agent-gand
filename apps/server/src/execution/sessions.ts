import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExternalAgentExecution } from '@agent-gand/shared';
import type { AgentTurnOptions } from '../orchestration/agentStep.ts';
import { config } from '../config.ts';
import { all, run } from '../db/database.ts';
import { waitForDurableLease } from './leases.ts';
import { ExecutionError } from './errors.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Document { role: string; blocks: string[] }
export interface NativeSessionInput { id: string | null; resume: boolean; configDir?: string; projectDir?: string; usageBaseline?: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } }
export interface SessionRecord {
  id: string; bindingKey: string; nativeId: string | null; driver: string; cwd: string; host: string;
  status: 'inflight' | 'ready' | 'invalid'; executionId: string; revision: number;
  configDir: string; projectDir: string; documents: Document[]; blocks: Record<string, string>;
  reason: string; updatedAt: string;
  totalUsage?: NativeSessionInput['usageBaseline'];
}
export interface SessionHandle {
  record: SessionRecord; input: NativeSessionInput; prompt: string; resume: boolean;
  bind(id: string): void; finish(safe: boolean): void; release(): void;
}
export class SessionUnavailableError extends ExecutionError {
  constructor(message: string) { super('interrupted', message); }
}
/** Never transmits unchanged history text during resume; referenced blocks retain their old content. */
export function contextDelivery(messages: AgentTurnOptions['messages'], previous?: SessionRecord) {
  const blocks: Record<string, string> = {}; const documents: Document[] = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    const ids = message.content.split(/(?<=\n)/).map((line) => { const id = hash(line); blocks[id] = line; return id; });
    documents.push({ role: message.role, blocks: ids });
  }
  const additions = Object.fromEntries(Object.entries(blocks).filter(([id]) => !previous?.blocks[id]));
  return { blocks, documents, additions };
}
async function accountBinding(execution: ExternalAgentExecution): Promise<string | null> {
  if (execution.driver === 'claude-sdk') return hash('anthropic:' + path.resolve(config.externalAgents.claudeHome) + ':' + (process.env.ANTHROPIC_BASE_URL ?? 'default') + ':' + (process.env.ANTHROPIC_API_KEY ?? ''));
  try {
    const auth = JSON.parse(await readFile(path.join(config.externalAgents.codexHome, 'auth.json'), 'utf8'));
    const identity = auth.tokens?.account_id ?? auth.account_id ?? auth.OPENAI_API_KEY;
    return identity ? hash(JSON.stringify([path.resolve(config.externalAgents.codexHome), auth.auth_mode, identity])) : null;
  } catch { return null; }
}
export async function prepareNativeSession(opts: AgentTurnOptions, execution: ExternalAgentExecution, signal: AbortSignal, forceCold = false): Promise<SessionHandle | undefined> {
  const policy = opts.agent.execution?.kind === 'external' ? opts.agent.execution.sessionPolicy ?? 'turn' : 'turn';
  if (policy === 'turn') return undefined;
  const account = await accountBinding(execution);
  const scope = policy === 'conversation' ? opts.run.conversationId : opts.run.id;
  const bindingKey = hash(JSON.stringify({ scope, policy, agent: opts.agent.id, version: opts.agent.version,
    driver: execution.driver, driverVersion: execution.driverVersion, cwd: execution.cwd, source: execution.sourceCwd,
    permission: execution.permissionMode, model: opts.agent.model, config: opts.agent.execution, systemPrompt: opts.agent.systemPrompt,
    control: opts.controlTools, display: opts.displayKind ?? 'message', account, host: hostname() }));
  const release = await waitForDurableLease('session:' + bindingKey, execution.id, false, signal);
  try {
    let previous = all<{ record: string }>("SELECT record FROM external_agent_sessions WHERE binding_key=? AND status='ready' ORDER BY rowid DESC", bindingKey).map((row) => JSON.parse(row.record) as SessionRecord)[0];
    let reason = forceCold ? '恢复预检失败，在模型 turn 前建立新会话' : previous ? '已验证绑定，尝试恢复完成会话' : '首次执行或角色、账户、工作区、策略绑定改变';
    if (previous && (!account || forceCold || !previous.nativeId || !uuid.test(previous.nativeId))) previous = undefined;
    if (previous?.driver === 'claude-sdk') {
      const file = path.join(previous.configDir, 'projects', previous.projectDir, previous.nativeId! + '.jsonl');
      try { if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error(); }
      catch { run("UPDATE external_agent_sessions SET status='invalid' WHERE id=?", previous.id); previous = undefined; reason = 'SDK 本地会话文件缺失或路径改变，建立新会话'; }
    }
    const id = previous?.id ?? randomUUID();
    const requestedDir = path.resolve(execution.driver === 'claude-sdk' ? config.externalAgents.claudeHome : config.externalAgents.codexHome);
    await mkdir(requestedDir, { recursive: true, mode: 0o700 });
    const configDir = await realpath(requestedDir);
    const record: SessionRecord = previous ? { ...previous, status: 'inflight', executionId: execution.id, revision: previous.revision + 1, reason, updatedAt: new Date().toISOString() }
      : { id, bindingKey, nativeId: execution.driver === 'claude-sdk' ? randomUUID() : null, driver: execution.driver, cwd: execution.cwd, host: hostname(), status: 'inflight', executionId: execution.id,
        revision: 1, configDir, projectDir: 'agent-gand-' + id, documents: [], blocks: {}, reason, updatedAt: new Date().toISOString() };
    const delivery = contextDelivery(opts.messages, previous);
    const persist = () => run('INSERT OR REPLACE INTO external_agent_sessions (id,binding_key,status,execution_id,record) VALUES (?,?,?,?,?)', record.id, record.bindingKey, record.status, record.executionId, JSON.stringify(record));
    persist(); // Intent precedes native inference; delivery commits only at a safe terminal.
    return { record, resume: !!previous, input: { id: record.nativeId, resume: !!previous, configDir, projectDir: record.projectDir, usageBaseline: record.totalUsage },
      prompt: '【平台上下文投递】下面是当前上下文文档的有序块引用；newBlocks 只包含新增或改变的原文。恢复时引用的旧块沿用已有内容，删除的引用不再属于当前文档。按当前任务执行。\n' + JSON.stringify({ revision: record.revision, runId: execution.runId, documents: delivery.documents, newBlocks: delivery.additions }),
      bind(nativeId) { if (!uuid.test(nativeId) || (record.nativeId && record.nativeId !== nativeId)) throw new ExecutionError('protocol_error', '原生会话与已登记绑定不一致'); record.nativeId = nativeId; persist(); },
      finish(safe) { record.status = safe && !!account ? 'ready' : 'invalid'; if (safe) { record.documents = delivery.documents; record.blocks = delivery.blocks; } persist(); },
      release,
    };
  } catch (error) { release(); throw error; }
}
