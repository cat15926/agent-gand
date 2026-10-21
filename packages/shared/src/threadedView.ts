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
export interface ThreadedSourceView {id:string;threadId:string;seq:number}
export interface ThreadedReviewView {
  actionId:string;version:number;generation:number;headSha:string;state:string;authorAgentId:string;
  findings:Array<{id:string;text:string;state:'open'|'attested'|'verified'}>;
  reports:Array<{reviewerId:string;verdict:string;messageId:string;headSha:string}>;
  sources:ThreadedSourceView[];
  lastGate:{status:string;checkedAt:number;headSha:string;currentApproval:false}|null;
}
export interface ThreadedSopView {
  id:string;sopKey:string;version:number;title:string;stage:string;baton:string|null;
  checks:Array<{id:string;label:string;state:'unknown'|'attested'|'verified';verifiedFact?:{kind:'task_done';taskId:string;taskVersion:number}}>;
  sources:ThreadedSourceView[];
}
export interface ThreadedKnowledgeView {
  knowledgeId:string;version:number;title:string;body:string;status:'active'|'expired'|'superseded';replacementId:string|null;
  sources:ThreadedSourceView[];
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
  business:{available:boolean;label:string;reviews?:ThreadedReviewView[];sops?:ThreadedSopView[];knowledge?:{retrieval:'literal_substring';items:ThreadedKnowledgeView[]};actions?:Array<{
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
