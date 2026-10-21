import {THREADED_HTTP_VERSION,THREADED_SCHEMA_VERSION} from '@agent-gand/shared';
import type {ThreadedThreadRecord,ThreadedViewSnapshot,ThreadedChangePage,ThreadedMessageReceipt,ThreadedMessageRecord} from '@agent-gand/shared';
import {managementRequest} from './accounts';
import {ApiError} from './apiError';

export interface ThreadedAdmissionView {mode:'closed'|'observe'|'execute';configured:boolean;ready:boolean;canCreate:boolean;
  members:Array<{agentId:string;backend:string;model:string}>;control:{version:number;admissionOpen:boolean;dispatchOpen:boolean}}
export interface ThreadedReleaseView {mode:'closed'|'observe'|'execute';control:ThreadedAdmissionView['control'];work:Record<string,number>;
  drain:{ready:boolean;compatibleWorkerRequired:boolean;unknownNeedsReview:boolean}}
export interface ThreadedRoutingPolicy {preferred:string[];defaultAgent:string;duty?:string;groups?:Record<string,string[]>}
export interface ThreadedRoutePreview {targets:string[];strategy:'serial'|'parallel';intent:'ideate'|'execute';promptTags:string[];reason:string;warnings:string[]}
/** One mounted view owns its in-memory CSRF token. Never persist private messages or session material. */
export class ThreadedApi {
  private csrf:string|null=null;
  constructor(private transport:typeof fetch=(...args)=>fetch(...args)){}
  private async request<T>(path:string,method='GET',body?:unknown):Promise<T>{
    const response=await this.transport(path,{method,credentials:'same-origin',cache:'no-store',headers:{
      'x-gand-threaded-http-version':THREADED_HTTP_VERSION,'x-gand-threaded-schema-version':String(THREADED_SCHEMA_VERSION),
      ...(body===undefined?{}:{'content-type':'application/json'}),...(this.csrf?{'x-gand-csrf':this.csrf}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json() as T&{code?:string;error?:string};
    if(!response.ok){if(response.status===401)this.csrf=null;throw new ApiError(result.error??'持续协作请求失败',response.status,{},result.code);}
    return result;
  }
  async resume(){const result=await this.request<{csrfToken:string;httpVersion:string}>('/api/threaded/session');
    if(result.httpVersion!==THREADED_HTTP_VERSION)throw new Error('持续协作协议版本不兼容');this.csrf=result.csrfToken;}
  async connect(){const result=await managementRequest<{csrfToken:string}>('/api/accounts/threaded/access-session','POST',{httpVersion:THREADED_HTTP_VERSION});this.csrf=result.csrfToken;}
  async disconnect(){try{await this.request('/api/threaded/session','DELETE');}finally{this.csrf=null;}}
  admission(){return this.request<ThreadedAdmissionView>('/api/threaded/admission');}
  release(){return this.request<ThreadedReleaseView>('/api/threaded/release');}
  releaseControl(input:{expectedVersion:number;requestId:string;admissionOpen:boolean;dispatchOpen:boolean;reason:string}){return this.request('/api/threaded/release/controls','POST',input);}
  createThread(title:string,clientRequestId:string){return this.request<{thread:ThreadedThreadRecord}>('/api/threaded/threads','POST',{title,clientRequestId});}
  async threads(){return(await this.request<{threads:ThreadedThreadRecord[]}>('/api/threaded/threads')).threads;}
  async view(threadId:string,beforeSeq?:number,afterEventSeq=0){
    const query=new URLSearchParams({afterEventSeq:String(afterEventSeq)});if(beforeSeq!==undefined)query.set('beforeSeq',String(beforeSeq));
    const value=await this.request<{snapshot:ThreadedViewSnapshot;changes:ThreadedChangePage}>(`${this.base(threadId)}/view?${query}`);
    if(value.snapshot.httpVersion!==THREADED_HTTP_VERSION||value.snapshot.schemaVersion!==1||value.snapshot.thread.id!==threadId)throw new Error('持续协作快照版本或空间不匹配');
    return value;
  }
  preview(id:string,body:string,targets?:string[]){return this.request<{route:ThreadedRoutePreview}>(`${this.base(id)}/routing-preview`,'POST',{body,...(targets?.length?{targets}:{})});}
  policy(id:string){return this.request<{routing:{version:number;policy:ThreadedRoutingPolicy}|null}>(`${this.base(id)}/routing-policy`);}
  configure(id:string,policy:ThreadedRoutingPolicy,expectedVersion:number){return this.request(`${this.base(id)}/routing-policy`,'PUT',{policy,expectedVersion});}
  send(id:string,input:{clientRequestId:string;body:string;targets?:string[];visibility:'public'|'private';audience?:string[]}){
    return this.request<{receipt:ThreadedMessageReceipt}>(`${this.base(id)}/messages`,'POST',input);}
  answer(id:string,waitId:string,input:{body:string;clientRequestId:string;expectedVersion:number}){
    return this.request<{receipt:ThreadedMessageReceipt}>(`${this.base(id)}/decisions/${encodeURIComponent(waitId)}/responses`,'POST',input);}
  control(id:string,scope:{kind:'thread'|'member'|'invocation';id?:string},action:'pause'|'stop'|'resume',requestId:string){
    const suffix=scope.kind==='thread'?'':`/${scope.kind==='member'?'members':'invocations'}/${encodeURIComponent(scope.id!)}`;
    return this.request(`${this.base(id)}${suffix}/controls`,'POST',{action,requestId});}
  approval(id:string,approvalId:string,decision:'approve'|'reject',requestId:string){return this.request(`${this.base(id)}/approvals/${encodeURIComponent(approvalId)}/decision`,'POST',{decision,requestId});}
  message(id:string,messageId:string){return this.request<{message:ThreadedMessageRecord}>(`${this.base(id)}/messages/${encodeURIComponent(messageId)}`);}
  sources(id:string,messageId:string){return this.request<{messages:ThreadedViewSnapshot['messages']}>(`${this.base(id)}/messages/${encodeURIComponent(messageId)}/sources`);}
  attachmentUrl(id:string,attachmentId:string){return `${this.base(id)}/attachments/${encodeURIComponent(attachmentId)}`;}
  private base(id:string){return `/api/threaded/threads/${encodeURIComponent(id)}`;}
}
