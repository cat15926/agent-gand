/**
 * 编排器契约（规格 §4.2 orchestration/types.ts）
 */
import type { AgentDefinition, Run } from '@agent-gand/shared';

export interface Orchestrator {
  /** 异步执行：调用方（routes）立即返回，进度走 WS / GET */
  start(run: Run, agents: AgentDefinition[], goal: string): Promise<void>;
}
