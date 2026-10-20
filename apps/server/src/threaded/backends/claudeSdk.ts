import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, realpath } from 'node:fs/promises';
import type { InvocationExecutionPort } from '../contracts.ts';
import { cleanEnvironment } from '../../accounts/environment.ts';
import { rememberSecret } from '../../accounts/secrets.ts';
import type { BackendAdapterOptions, BackendSdkProcess } from './types.ts';
import { executeBackendRequest } from './request.ts';
import { invokeThreadedSdkProcess, threadedProcessGroupStopped } from './sdkProcess.ts';

export function createClaudeSdkBackend(options:BackendAdapterOptions&{
  sdkProcess?:BackendSdkProcess; processGroupStopped?:(pid:number)=>boolean;
}):InvocationExecutionPort {
  return {async execute(input) {
    const prepared=await options.loadInput(input);
    if(prepared.kind!=='claude-sdk'||!prepared.session.nativeId||prepared.session.backendVersion!=='0.3.288') {
      throw new Error('THREADED_SDK_CONFIGURATION_REQUIRED');
    }
    const nativeId=prepared.session.nativeId;
    await mkdir(prepared.session.configDir,{recursive:true,mode:0o700});
    if(await realpath(prepared.session.configDir)!==prepared.session.configDir)throw new Error('THREADED_SDK_HOME_NOT_CANONICAL');
    const token=randomBytes(32).toString('hex');rememberSecret(token);
    const relayController=new AbortController();
    const requestInput={...input,signal:AbortSignal.any([input.signal,relayController.signal])};
    let requestTail:Promise<unknown>=Promise.resolve();
    const active=new Set<Promise<void>>();let sequence=0,closed=false,terminal:Record<string,unknown>|undefined;
    let checkpoint:{anchorUuid:string;inputUserUuid:string}|undefined,requestReference:string|undefined;
    let compactionBoundary=prepared.session.resume?prepared.session.compactionBoundary:undefined;
    const server=createServer((request,response)=>{
      const task=(async()=>{
        try {
          const supplied=request.headers['x-api-key'];
          if(closed||request.headers.origin||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(token)||
            !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) {response.writeHead(403).end();return;}
          const url=new URL(request.url??'/','http://127.0.0.1');
          if(request.method!=='POST'||!['/v1/messages','/v1/messages/count_tokens'].includes(url.pathname)||
            [...url.searchParams].some(([key,value])=>key!=='beta'||value!=='true')){response.writeHead(403).end();return;}
          const requestSequence=++sequence;
          if(requestSequence>(prepared.maxRequests??64))throw new Error('THREADED_SDK_REQUEST_LIMIT');
          const chunks:Buffer[]=[];let size=0;
          for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;
            if(size>20*1024*1024)throw new Error('THREADED_SDK_INPUT_LIMIT');chunks.push(bytes);}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('THREADED_SDK_BODY_INVALID');
          const headers:Record<string,string>={'anthropic-version':String(request.headers['anthropic-version']??'2023-06-01')};
          if(typeof request.headers['anthropic-beta']==='string')headers['anthropic-beta']=request.headers['anthropic-beta'];
          // One shared capacity claim authorizes only one actual HTTP at a time.
          // SDK parallel helper requests wait here before reserving any request quota.
          const forwarding=requestTail.then(()=>executeBackendRequest(options,requestInput,prepared,{key:`sdk:${requestSequence}`,pathname:url.pathname,body,headers,
            onHeaders(status,contentType){response.writeHead(status,{'content-type':contentType,'cache-control':'no-store'});},
            onChunk(chunk){response.write(chunk);}}));
          requestTail=forwarding.then(()=>{},()=>{});
          const result=await forwarding;
          const receipt=options.evidence.getReceipt(result.evidenceReference);
          if(receipt?.delivered)requestReference=result.evidenceReference;
          response.end();
        }catch{
          if(!response.headersSent)response.writeHead(502,{'content-type':'application/json'});
          response.end(JSON.stringify({error:{type:'threaded_request_blocked',message:'Threaded request was not confirmed'}}));
        }
      })();active.add(task);void task.finally(()=>active.delete(task));
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);resolve();});});
    const address=server.address();if(!address||typeof address==='string')throw new Error('THREADED_SDK_RELAY_UNAVAILABLE');
    let failure=false;
    try {
      input.assertAuthorized();prepared.assertCurrent();options.evidence.assertOutsideTransaction();
      await (options.sdkProcess??invokeThreadedSdkProcess)({
        cwd:prepared.session.cwd,configDir:prepared.session.configDir,projectDir:prepared.session.projectDir,
        nativeId,resume:prepared.session.resume,model:prepared.model.replace(/^anthropic:/,''),
        instructions:prepared.instructions,prompt:prepared.serializedContext,maxOutputTokens:prepared.maxOutputTokens,
        timeoutMs:prepared.connection.timeoutMs,signal:input.signal,
        environment:cleanEnvironment({HOME:prepared.session.configDir,CLAUDE_CONFIG_DIR:prepared.session.configDir,
          CLAUDE_CODE_PROJECT_DIR_NAME:prepared.session.projectDir??'',ANTHROPIC_API_KEY:token,
          ANTHROPIC_BASE_URL:`http://127.0.0.1:${address.port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
          AGENT_GAND_ISOLATED_WORKER:'1'}),
        onProcess(owner){input.assertAuthorized();prepared.assertCurrent();options.evidence.registerProcess(input.binding,owner);},
        onProcessStopped(token){options.evidence.processClosed(token);},
        onRecord(record) {
          if(record.type==='threaded_checkpoint') {
            if(record.sessionId!==nativeId||typeof record.anchorUuid!=='string'||typeof record.inputUserUuid!=='string')throw new Error('THREADED_SDK_CHECKPOINT_INVALID');
            checkpoint={anchorUuid:record.anchorUuid,inputUserUuid:record.inputUserUuid};return;
          }
          input.assertAuthorized();prepared.assertCurrent();
          if(record.type==='system'&&record.subtype==='init') {
            if(typeof record.session_id!=='string')throw new Error('THREADED_SDK_SESSION_REQUIRED');
            prepared.nativeEvent?.({type:'bound',nativeId:record.session_id});
            if(record.session_id!==nativeId)throw new Error('THREADED_SDK_SESSION_MISMATCH');
            if(record.cwd!==undefined&&record.cwd!==prepared.session.cwd)throw new Error('THREADED_SDK_WORKSPACE_MISMATCH');
            if(Array.isArray(record.tools)&&record.tools.some(tool=>!['Read','Grep','Glob'].includes(String(tool))))throw new Error('THREADED_SDK_TOOLS_UNSUPPORTED');
            if(Array.isArray(record.mcp_servers)&&record.mcp_servers.length)throw new Error('THREADED_SDK_MCP_UNSUPPORTED');
          } else if(record.type==='system'&&record.subtype==='compact_boundary') {
            if(record.session_id!==nativeId||typeof record.uuid!=='string')throw new Error('THREADED_SDK_COMPACTION_INVALID');
            compactionBoundary=record.uuid;
            const evidence=options.evidence.nativeCompaction(input.binding,prepared,record.uuid);
            prepared.nativeEvent?.({type:'compact',nativeId,evidence});
          } else if(record.type==='result') {
            if(record.session_id!==nativeId||typeof record.uuid!=='string')throw new Error('THREADED_SDK_TERMINAL_INVALID');
            terminal=record;
          }
        },
      });
    }catch{failure=true;}
    finally{
      if(failure)relayController.abort();
      closed=true;server.closeIdleConnections();
      if(failure)server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      await Promise.allSettled(active);
    }
    for(const process of options.evidence.processes(input.binding)) {
      if(process.host===hostname()&&process.state==='closed'&&
        (options.processGroupStopped??threadedProcessGroupStopped)(process.pid))options.evidence.confirmProcessStopped(process.token);
    }
    try {
      const proof=options.recordQuiescence(input.binding,options.evidence.quiescence(input.binding));
      if(!failure&&terminal?.subtype==='success'&&terminal.is_error!==true&&typeof terminal.result==='string') {
        if(checkpoint&&requestReference) {
          const evidence=options.evidence.nativeAnchor(input.binding,prepared,requestReference,String(terminal.uuid),
            checkpoint.inputUserUuid,compactionBoundary,checkpoint.anchorUuid);
          prepared.nativeEvent?.({type:'anchor',nativeId,evidence,quiescence:proof});
        }
        return {kind:'completed',content:terminal.result,budgetState:'unknown',quiescence:proof};
      }
      return input.signal.aborted?{kind:'cancelled',reason:'THREADED_SDK_CANCELLED',budgetState:'unknown',quiescence:proof}:
        {kind:'failed',reason:'THREADED_SDK_FAILED',retryable:false,budgetState:'unknown',quiescence:proof};
    }catch{return {kind:'unknown',reason:'THREADED_SDK_QUIESCENCE_UNCONFIRMED'};}
  }};
}
