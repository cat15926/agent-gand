import type {ThreadedBinding} from '@agent-gand/shared';
export type ActionFence={actionId:string;generation:number};
export type ActionSubject={kind:'task';taskId:string}|{kind:'github_pr';repository:string;number:number};
export type ActionPredicate='task_done'|'review_delivered';
export type ActionScope={ownerId:string;threadId:string;agentId:string};
export type PrFact={repository:string;number:number;headSha:string;authorLogin:string;updatedAt:string};
export interface PrAuthority {fingerprint:string;githubLogin:string;mayAssign:boolean}
/** Installed by the server. A model cannot select a URL, credential, actor mapping or transport. */
export interface ActionPrSource {
  authorize(scope:ActionScope,repository:string):PrAuthority|null;
  current(scope:ActionScope,subject:Extract<ActionSubject,{kind:'github_pr'}>):Promise<PrFact>;
}
export type CommandObservation={state:'running'|'unknown'|'completed'|'failed'|'cancelled';evidenceRef:string;result?:string};
export interface ActionCommandPort {
  authorization(scope:ActionScope):string|null;
  validate(args:unknown):void;
  /** commandId is the durable idempotency identity; implementations must reconcile, never blindly replay. */
  start(input:{commandId:string;binding:ThreadedBinding;args:unknown}):Promise<CommandObservation>;
  observe(input:{commandId:string;scope:ActionScope}):Promise<CommandObservation>;
  cancel(input:{commandId:string;scope:ActionScope}):Promise<CommandObservation>;
}
export interface ActionOptions {pr?:ActionPrSource;commands?:Record<string,ActionCommandPort>}
export type ActionGeneration={subject:ActionSubject;predicate:ActionPredicate;freshness:string;criteriaHash?:string;
  pr?:PrFact;holders:string[];parallelIntent?:string;predecessor:{agentId:string;threadId:string;binding:ThreadedBinding;identity:string};
  standing:string;bindingId:string;rootId:string;operation:'transfer'|'replace'|'return'|'revision';
  scope:{visibility:'public'|'private';audience:string[];sourceRefs:string[]};
  frozen:{identity:string|null;sourceId:string;controlSeq:number;actionFence?:ActionFence|null}};
