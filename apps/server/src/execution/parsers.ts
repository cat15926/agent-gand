import type { ExternalDriverId, NativeAgentEvent } from '@agent-gand/shared';
import { ExecutionError, diagnostic, exitError } from './errors.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

export class NativeEventParser {
  private items = new Map<string, string>();
  private currentMessage = '';
  private finalText: string | null = null;
  private terminal: 'completed' | 'failed' | null = null;
  private session: string | null = null;
  private terminalError: ExecutionError | null = null;
  constructor(private driver: ExternalDriverId, private emit: (event: NativeAgentEvent) => void, private allowedClaudeTools = ['Read', 'Grep', 'Glob'], private allowedMcpServers: string[] = []) {}
  get content(): string { return this.finalText ?? [...this.items.values()].join('\n\n'); }
  get error(): ExecutionError | null { return this.terminalError; }
  private bind(id: string): void {
    if (!id || id.length > 256 || /[\s\x00-\x1f]/.test(id)) throw new ExecutionError('protocol_error', '原生会话 ID 无效');
    if (this.session && this.session !== id) throw new ExecutionError('protocol_error', '同一次执行返回了不同会话 ID');
    if (!this.session) { this.session = id; this.emit({ type: 'session.bound', sessionId: id }); }
  }
  private snapshot(id: string, value: string): void {
    if (this.items.get(id) === value) return;
    this.items.set(id, value); this.emit({ type: 'text.snapshot', itemId: id, text: value });
  }
  accept(value: unknown): void {
    const record = object(value);
    if (typeof record.type !== 'string') throw new ExecutionError('protocol_error', 'CLI JSON 缺少事件 type');
    if (this.terminal) throw new ExecutionError('protocol_error', 'CLI 在终态之后继续输出事件');
    if (this.driver === 'claude-cli' || this.driver === 'claude-sdk') this.claude(record); else this.codex(record);
  }
  private claude(record: ObjectValue): void {
    if (record.type === 'system' && record.subtype === 'init') {
      this.bind(text(record.session_id));
      if (Array.isArray(record.tools) && record.tools.some((tool) => !this.allowedClaudeTools.includes(text(tool)))) {
        throw new ExecutionError('policy_rejected', 'Claude 初始化暴露了只读白名单之外的工具');
      }
      if (Array.isArray(record.mcp_servers) && record.mcp_servers.some((server) => !this.allowedMcpServers.includes(text(object(server).name)))) throw new ExecutionError('policy_rejected', 'Claude 初始化启用了未准入的 MCP');
    } else if (record.type === 'stream_event') {
      const event = object(record.event);
      if (event.type === 'message_start') this.currentMessage = text(object(event.message).id);
      const id = `${this.currentMessage}:${number(event.index) ?? 0}`;
      const delta = object(event.delta);
      if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
        if (!this.currentMessage || typeof delta.text !== 'string') throw new ExecutionError('protocol_error', 'Claude 文本增量缺少 message ID 或正文');
        this.items.set(id, (this.items.get(id) ?? '') + delta.text);
        this.emit({ type: 'text.delta', itemId: id, text: delta.text });
      }
      const block = object(event.content_block);
      if (event.type === 'content_block_start' && block.type === 'tool_use') this.claudeTool(block);
    } else if (record.type === 'assistant') {
      const message = object(record.message);
      const id = text(message.id);
      if (!id) throw new ExecutionError('protocol_error', 'Claude assistant 缺少 message ID');
      if (record.error) this.terminalError = exitError(text(record.error));
      if (Array.isArray(message.content)) message.content.forEach((part, index) => {
        const block = object(part);
        if (block.type === 'text') this.snapshot(`${id}:${index}`, text(block.text));
        if (block.type === 'tool_use') this.claudeTool(block);
      });
    } else if (record.type === 'user') {
      const message = object(record.message);
      if (Array.isArray(message.content)) for (const part of message.content) {
        const block = object(part);
        if (block.type === 'tool_result') this.emit({ type: 'tool.completed', itemId: text(block.tool_use_id), name: 'native', output: diagnostic(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')), failed: block.is_error === true });
      }
    } else if (record.type === 'result') {
      if (record.session_id) this.bind(text(record.session_id));
      const ok = record.subtype === 'success' && record.is_error !== true && !this.terminalError;
      if (ok && typeof record.result === 'string') {
        this.finalText = record.result;
        this.emit({ type: 'text.snapshot', itemId: '__final__', text: record.result });
      }
      const usage = object(record.usage);
      const input = number(usage.input_tokens);
      this.emit({ type: 'usage', tokensIn: input === null ? null : input + (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0), tokensOut: number(usage.output_tokens), costUsd: number(record.total_cost_usd) });
      this.terminal = ok ? 'completed' : 'failed';
      if (!ok) this.terminalError = this.terminalError ?? exitError(Array.isArray(record.errors) ? record.errors.map(text).join('\n') : text(record.result) || text(record.subtype));
      this.emit({ type: 'terminal', status: this.terminal, ...(this.terminalError ? { message: diagnostic(this.terminalError.message) } : {}) });
    }
  }
  private claudeTool(block: ObjectValue): void {
    const name = text(block.name);
    if (!this.allowedClaudeTools.includes(name)) throw new ExecutionError('policy_rejected', `Claude 请求了未准入的工具：${name}`);
    this.emit({ type: 'tool.started', itemId: text(block.id), name });
  }
  private codex(record: ObjectValue): void {
    if (record.type === 'thread.started') this.bind(text(record.thread_id));
    if (['item.started', 'item.updated', 'item.completed'].includes(text(record.type))) {
      const item = object(record.item); const id = text(item.id);
      if (!id) throw new ExecutionError('protocol_error', 'Codex item 缺少 ID');
      if (item.type === 'agent_message') this.snapshot(id, text(item.text));
      else if (item.type === 'file_change' || item.type === 'mcp_tool_call') throw new ExecutionError('policy_rejected', `Codex 请求了阶段 A 不允许的工具：${text(item.type)}`);
      else if (item.type === 'command_execution' || item.type === 'web_search') this.emit({ type: record.type === 'item.completed' ? 'tool.completed' : 'tool.started', itemId: id, name: text(item.type) });
    }
    if (record.type === 'turn.completed') {
      const usage = object(record.usage);
      this.emit({ type: 'usage', tokensIn: number(usage.input_tokens), tokensOut: number(usage.output_tokens), costUsd: null });
      this.terminal = 'completed'; this.emit({ type: 'terminal', status: 'completed' });
    } else if (record.type === 'error') {
      this.terminalError = exitError(text(record.message) || text(object(record.error).message) || 'Codex error');
    } else if (record.type === 'turn.failed') {
      this.terminalError = exitError(text(object(record.error).message) || text(record.message) || 'Codex turn failed');
      this.terminal = 'failed'; this.emit({ type: 'terminal', status: 'failed', message: this.terminalError.message });
    }
  }
  finish(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.terminal !== 'completed' || !this.session) throw new ExecutionError('protocol_error', 'CLI 退出但未收到完整会话绑定及成功终态');
    if (!this.content.trim()) throw new ExecutionError('protocol_error', 'CLI 成功终态没有分析正文');
  }
}
