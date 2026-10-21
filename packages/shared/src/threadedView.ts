import type { ThreadedCapabilities, ThreadedMemberRecord, ThreadedMessageRecord, ThreadedThreadRecord } from './threaded.ts';

export interface ThreadedInvocationView {
  id: string; agentId: string; runId: string | null; sourceMessageId: string | null;
  status: 'queued'|'running'|'waiting'|'unknown'|'completed'|'failed'|'cancelled';
  pauseRequested: boolean; cancelRequested: boolean; reason: string | null;
  attempts: Array<{id:string;number:number;status:string;stage:string;reason:string|null;updatedAt:string}>;
  createdAt: string; updatedAt: string;
}
export interface ThreadedWaitView {
  id:string;agentId:string;kind:'timer'|'tracking'|'decision';state:string;version:number;
  deadline:number|null;question:string|null;responseCount:number;outcome:Record<string,unknown>|null;
}
export interface ThreadedMessageProgress {
  messageId:string;agentId:string;queued:boolean;executing:boolean;responded:boolean;
  delivered:boolean;seen:boolean;mentionAcknowledged:boolean;reason:string|null;
}
export interface ThreadedConsultationView {
  id:string;callerId:string;deadline:number;state:string;kind:string|null;
  targets:Array<{agentId:string;status:string;responseMessageId:string|null}>;
  callback:{state:string;reason:string|null}|null;
}
export interface ThreadedViewSnapshot {
  httpVersion:'threaded-http-v1';schemaVersion:1;revision:string;eventCursor:number;routingVersion:number;
  thread:ThreadedThreadRecord;members:ThreadedMemberRecord[];capabilities:ThreadedCapabilities;
  messages:ThreadedMessageRecord[];nextBeforeSeq:number|null;
  invocations:ThreadedInvocationView[];progress:ThreadedMessageProgress[];
  waits:ThreadedWaitView[];consultations:ThreadedConsultationView[];
  memberControls:Array<{agentId:string;state:'available'|'paused'|'stopped'}>;
  memberQueues:Array<{agentId:string;count:number}>;
  approvals:Array<{id:string;invocationId:string;agentId:string;state:string}>;
  business:{available:boolean;label:string;actions?:Array<{
    id:string;subject:{kind:'task';taskId:string}|{kind:'github_pr';repository:string;number:number};
    predicate:string;generation:number;state:string;freshness:string;freshnessStatus:string;approvalGateSatisfied:false;
    holders:Array<{agentId:string;outcome:string|null}>;
    commands?:Array<{id:string;agentId:string;generation:number;state:string;waitState:string|null}>;
  }>};
}
/** Durable invalidation references only. Each replay is authorized against current source facts. */
export interface ThreadedChangePage {
  afterSeq:number;throughSeq:number;hasMore:boolean;
  events:Array<{seq:number;id:string;type:string;messageId:string}>;
}
