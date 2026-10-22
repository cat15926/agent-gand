import {integer,object,reject,text} from './collaborationTypes.ts';

export const THREADED_WAIT_SOURCE_KINDS=['github_issue','github_comment','thread_message','task','reporter_handle','managed_command'] as const;
export type ThreadedWaitSourceRef={kind:typeof THREADED_WAIT_SOURCE_KINDS[number];value:string;anchorRef?:string;expectedSignal:string;slaUntilMs:number};
export type ThreadedWaitSourceAuthority={authorization:string;sourceMessageIds?:string[]};
export type ThreadedHoldScope={ownerId:string;threadId:string;agentId:string};
/** Server policy and source adapters are never selected by a model tool. */
export interface ThreadedHoldOptions {
  holdPolicy?:(scope:ThreadedHoldScope)=>'ordinary'|'gatekeeping';
  waitSourceAuthorization?:(scope:ThreadedHoldScope,source:ThreadedWaitSourceRef)=>ThreadedWaitSourceAuthority|null;
}
export const THREADED_WAIT_SOURCE_SCHEMA={type:'object',properties:{
  kind:{enum:THREADED_WAIT_SOURCE_KINDS},value:{type:'string',minLength:1,maxLength:500},
  anchorRef:{type:'string',minLength:1,maxLength:200},expectedSignal:{type:'string',minLength:1,maxLength:500},
  slaUntilMs:{type:'integer',minimum:1}},required:['kind','value','expectedSignal','slaUntilMs'],additionalProperties:false};

export function parseThreadedWaitSource(value:unknown):ThreadedWaitSourceRef {
  const input=object(value);
  if(Object.keys(input).some(key=>!['kind','value','anchorRef','expectedSignal','slaUntilMs'].includes(key))||
    !THREADED_WAIT_SOURCE_KINDS.includes(input.kind as ThreadedWaitSourceRef['kind']))reject('THREADED_WAIT_SOURCE_INVALID',400);
  const kind=input.kind as ThreadedWaitSourceRef['kind'],expectedSignal=text(input.expectedSignal,500);
  // Human questions use the ordinary interactive Decision contract, never a timer wake.
  if(/^(?:pending[ _-]?input|(?:await(?:ing)?|wait(?:ing)?)[ _-]?(?:for[ _-]?)?(?:user|human)[ _-]?(?:input|reply|response|confirmation|approval)|(?:user|human)[ _-]?(?:input|reply|response|confirmation|approval)|等待(?:用户|人工|人类)(?:输入|回复|回答|确认|批准)|(?:用户|人工|人类)(?:输入|回复|回答|确认|批准))$/iu.test(expectedSignal.trim()))
    reject('THREADED_HOLD_HUMAN_INPUT_FORBIDDEN',400);
  const ref:ThreadedWaitSourceRef={kind,value:text(input.value,500),expectedSignal,slaUntilMs:integer(input.slaUntilMs,1,Number.MAX_SAFE_INTEGER),
    ...(input.anchorRef===undefined?{}:{anchorRef:text(input.anchorRef,200)})};
  if(kind==='reporter_handle'&&!ref.anchorRef)reject('THREADED_WAIT_SOURCE_ANCHOR_REQUIRED',400);
  return ref;
}

/** Extra SLA checks apply only to a timer missed while the runtime was absent. */
export function classifyThreadedTimerRecovery(input:{deadline:number|null;createdAt:number;now:number;source:unknown;identityValid:boolean;sourceValid:boolean}):
  {kind:'invalid'}|{kind:'expired';slaUntilMs:number}|{kind:'recover';slaUntilMs:number} {
  let ref:ThreadedWaitSourceRef;try{ref=parseThreadedWaitSource(input.source);}catch{return {kind:'invalid'};}
  const deadline=input.deadline;
  if(!input.identityValid||!input.sourceValid||deadline===null||!Number.isSafeInteger(deadline)||!Number.isSafeInteger(input.createdAt)||!Number.isSafeInteger(input.now)||
    deadline<input.createdAt+5000||deadline>input.createdAt+3_600_000||deadline>input.now)
    return {kind:'invalid'};
  return {kind:input.now>ref.slaUntilMs?'expired':'recover',slaUntilMs:ref.slaUntilMs};
}
