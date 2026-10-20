import type {ThreadedViewSnapshot} from '@agent-gand/shared';
import {ApiError} from './apiError';
import type {ThreadedApi} from './threadedApi';

export interface ThreadedSyncState {
  status:'loading'|'live'|'reconnecting'|'disconnected'|'closed';snapshot:ThreadedViewSnapshot|null;error:string;
}
type SocketPort=Pick<WebSocket,'close'|'onopen'|'onclose'|'onerror'|'onmessage'>;
/** Snapshot replacement, never append cached private bodies after reconnection. Hints carry no authority. */
export class ThreadedSync {
  private socket:SocketPort|null=null;private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;private epoch=0;private busy=false;private dirty=false;private cursor=0;private backoff=500;
  private watchingNetwork=false;
  private offline=()=>{if(this.stopped||this.state.status==='disconnected')return;
    ++this.epoch;this.cursor=0;if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    const socket=this.socket;this.socket=null;socket?.close();this.publish({status:'reconnecting',snapshot:null,error:'网络已断开，恢复后将重新核验访问'});};
  private online=()=>{if(!this.stopped&&this.state.status!=='disconnected')void this.start();};
  private state:ThreadedSyncState={status:'loading',snapshot:null,error:''};
  constructor(private api:Pick<ThreadedApi,'view'>,private threadId:string,private emit:(state:ThreadedSyncState)=>void,
    private options:{socket?:(url:string)=>SocketPort;url?:string;beforeSeq?:number;retryMs?:number}={}){}
  private publish(state:ThreadedSyncState){this.state=state;this.emit(state);}
  async start(){if(this.stopped)return;
    if(typeof window!=='undefined'&&!this.watchingNetwork){this.watchingNetwork=true;window.addEventListener('offline',this.offline);window.addEventListener('online',this.online);}
    if(typeof navigator!=='undefined'&&navigator.onLine===false){this.offline();return;}
    await this.refresh();if(this.stopped)return;
    if(!this.state.snapshot){if(this.state.status!=='disconnected')this.retry();return;}if(!this.socket)this.open();}
  private open(){
    if(this.stopped)return;const epoch=++this.epoch;
    const base=this.options.url??`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/threaded/ws`;
    const query=new URLSearchParams({threadId:this.threadId,view:'timeline',afterEventSeq:String(this.cursor)});
    const socket=(this.options.socket??(url=>new WebSocket(url)))(`${base}?${query}`);this.socket=socket;
    socket.onopen=()=>{if(this.stopped||epoch!==this.epoch)return;this.backoff=500;this.publish({...this.state,status:'live',error:''});void this.refresh();};
    socket.onmessage=raw=>{if(this.stopped||epoch!==this.epoch)return;
      try{const value=JSON.parse(String(raw.data)) as {type:string;threadId:string;httpVersion:string};
        if(value.type==='threaded.invalidate'&&value.threadId===this.threadId&&value.httpVersion==='threaded-http-v1')void this.refresh();}catch{/* An invalid hint is never a model message. */}};
    socket.onerror=()=>socket.close();
    socket.onclose=event=>{if(this.stopped||epoch!==this.epoch)return;
      this.socket=null;++this.epoch;this.cursor=0;
      this.publish({status:event.code===1008?'disconnected':'reconnecting',snapshot:null,error:event.code===1008?'会话或访问权限已失效，请重新连接':'连接中断，正在重新同步'});
      if(event.code!==1008)this.retry();};
  }
  private retry(){if(this.stopped||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.start();},this.options.retryMs??this.backoff);this.backoff=Math.min(this.backoff*2,8000);}
  async refresh(){
    if(this.stopped)return;if(this.busy){this.dirty=true;return;}this.busy=true;
    const epoch=this.epoch;
    try{
      const result=await this.api.view(this.threadId,this.options.beforeSeq,this.cursor);
      if(this.stopped||epoch!==this.epoch)return;
      this.cursor=result.snapshot.eventCursor;
      this.publish({status:this.socket?'live':'loading',snapshot:result.snapshot,error:''});
    }catch(error){
      if(this.stopped||epoch!==this.epoch)return;
      const denied=error instanceof ApiError&&[401,403,404,409].includes(error.status);
      if(denied&&this.timer){clearTimeout(this.timer);this.timer=undefined;}
      ++this.epoch;const socket=this.socket;this.socket=null;socket?.close();this.cursor=0;
      this.publish({status:denied?'disconnected':'reconnecting',snapshot:null,error:error instanceof Error?error.message:'同步失败'});
      if(!denied)this.retry();
    }finally{this.busy=false;if(this.dirty&&!this.stopped){this.dirty=false;if(this.state.status!=='disconnected')void this.refresh();}}
  }
  stop(){this.stopped=true;++this.epoch;if(this.timer)clearTimeout(this.timer);this.socket?.close();this.socket=null;
    if(this.watchingNetwork){window.removeEventListener('offline',this.offline);window.removeEventListener('online',this.online);}
    this.publish({status:'closed',snapshot:null,error:''});}
}
