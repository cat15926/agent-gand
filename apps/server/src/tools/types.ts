/**
 * 工具契约与权限三档（规格 §4.2 tools/types.ts，P0-5）
 * readonly：仅只读类工具可用，其余拒绝
 * auto：白名单内直过，其余拒绝
 * confirm：白名单内直过，白名单外需人工审批（need_approval）
 */
import type { AgentDefinition } from '@agent-gand/shared';

export interface ToolContext {
  runId: string;
  agentId: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema（传给真实 LLM 的 tools 字段，规格 §7.1） */
  inputSchema: Record<string, unknown>;
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

export type PermissionDecision = 'allow' | 'deny' | 'need_approval';

/** 只读类工具集合（对 readonly 模式放行的工具名；也用于决定 readonly 档下发哪些 schema） */
export const READONLY_TOOLS = new Set(['fs.read', 'http.get', 'search.files']);

/**
 * 权限门控（执行侧判定顺序，规格 §8.3 修订）：
 * 1. disallowedTools 命中 → deny
 * 2. 只读类 → readonly 与 confirm 档直过（零风险免审，真机 3 次审批中 2 次为 fs.read 可免）；
 *    auto 档仍按白名单（白名单外 deny）
 * 3. confirm 档非只读 → 白名单内直过，白名单外审批
 * 4. auto 档 → 白名单内直过、白名单外 deny
 * §7.4 的工具 schema 下发集合不受此影响（confirm 仍全量下发）。
 */
export function checkPermission(agent: AgentDefinition, toolName: string): PermissionDecision {
  if (agent.disallowedTools.includes(toolName)) return 'deny';
  if (READONLY_TOOLS.has(toolName)) {
    if (agent.permissionMode === 'readonly' || agent.permissionMode === 'confirm') return 'allow';
    return agent.tools.includes(toolName) ? 'allow' : 'deny';
  }
  switch (agent.permissionMode) {
    case 'readonly':
      return 'deny';
    case 'auto':
      return agent.tools.includes(toolName) ? 'allow' : 'deny';
    case 'confirm':
      return agent.tools.includes(toolName) ? 'allow' : 'need_approval';
  }
}

/** 工具级错误：编排器记为 tool span 的 error 状态，不中断整个 run */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** 入参必须是 JSON 对象 */
export function expectObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolError('工具入参必须是 JSON 对象');
  }
  return input as Record<string, unknown>;
}

export function expectString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolError(`缺少字符串参数: ${key}`);
  }
  return value;
}
