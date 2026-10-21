import { createHash } from 'node:crypto';
import type { ThreadedBinding, ThreadedMessageReceipt } from '@agent-gand/shared';
import type { createThreadedMessages } from './messages.ts';
import type { ThreadedAuthority, QuiescenceProof } from './contracts.ts';
export class ThreadedCollaborationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function reject(code: string, status = 409): never { throw new ThreadedCollaborationError(code, status); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('THREADED_TOOL_INPUT_INVALID', 400);
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008]/u.test(value)) reject('THREADED_TOOL_INPUT_INVALID', 400);
  return value as string;
}
export function strings(value: unknown, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) reject('THREADED_TOOL_INPUT_INVALID', 400);
  const result = (value as unknown[]).map(v => text(v));
  if (new Set(result).size !== result.length) reject('THREADED_TOOL_INPUT_INVALID', 400);
  return result;
}
export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) reject('THREADED_TOOL_INPUT_INVALID', 400);
  return Number(value);
}
export function digest(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,ordered(x)])) : v;
  return createHash('sha256').update(JSON.stringify(ordered(value)) ?? 'undefined').digest('hex');
}
export type CollaborationMessages = ReturnType<typeof createThreadedMessages>;
export interface CollaborationOptions { authority: ThreadedAuthority; messages: CollaborationMessages; now?: () => number; onCommitted?: () => void;
  ingress?:{assert(input:import('./messageContracts.ts').ThreadedUserMessageInput,targets:string[]):void;record(receipt:ThreadedMessageReceipt):void};
}
export interface CollaborationTerminal { binding: ThreadedBinding; status: 'completed'|'failed'|'cancelled';
  response?: ThreadedMessageReceipt; quiescence: QuiescenceProof }
export interface RoutingPolicy { preferred: string[]; duty?: string; defaultAgent: string; groups?: Record<string,string[]> }
export interface RoutingDecision { targets: string[]; strategy: 'serial'|'parallel'; intent: 'ideate'|'execute';
  promptTags:string[];intentExplicit:boolean;reason: string; warnings: string[]; explicit: boolean }
