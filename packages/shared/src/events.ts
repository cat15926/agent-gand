/**
 * WebSocket 实时事件协议（P0-6）
 * server → web 单向推送；data 结构即各领域对象
 */

import type { AgentDefinition } from './agent.ts';
import type { Message } from './message.ts';
import type { Task } from './task.ts';
import type { Run, RunEvent, UsageSummary } from './run.ts';
import type { ApprovalRequest } from './approval.ts';

export type ServerEvent =
  | { type: 'hello'; agents: AgentDefinition[]; runs: number }
  | { type: 'message'; message: Message }
  | { type: 'task.updated'; task: Task }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.event'; event: RunEvent }
  | { type: 'llm.delta'; runId: string; spanId: string; text: string }
  | { type: 'approval.updated'; approval: ApprovalRequest }
  | { type: 'usage'; usage: UsageSummary };
