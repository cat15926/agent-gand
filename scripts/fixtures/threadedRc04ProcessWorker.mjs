/** Disposable RC04 production composition. All official GitHub GETs cross the
 * parent-owned capability; this process never receives the real credential. */
import {openRc04Harness} from './threadedRc04Harness.mjs';

const PLACEHOLDER='rc04-parent-owned-ipc-capability';
const MAX_BYTES=1024*1024;
const bootPolicy={environmentKeys:Object.keys(process.env).sort(),argvCount:process.argv.length};
let harness,sequence=0,initialized=false,chain=Promise.resolve(),forbiddenNetworkCalls=0;
const requests=new Map();
const trace=value=>!value?{}:{requestTrace:{
  reserved:value.reserved===true,scriptedFetch:value.scriptedFetch===true,handlerCompleted:value.handlerCompleted===true,
  ...(Number.isSafeInteger(value.inputBytes)?{inputBytes:value.inputBytes}:{}),
  backend:Array.isArray(value.backend)?value.backend.slice(0,8).map(row=>({
    state:['sending','completed','unknown'].includes(row.state)?row.state:'other',payload_included:row.payload_included===1,delivered:row.delivered===1,
    input_tokens:Number.isSafeInteger(row.input_tokens)?row.input_tokens:null,output_tokens:Number.isSafeInteger(row.output_tokens)?row.output_tokens:null,
  })):[],
}};
const safeError=cause=>({code:typeof cause?.code==='string'&&/^RC04_[A-Z_]+$/.test(cause.code)?cause.code:'RC04_PROCESS_OPERATION_FAILED',
  message:'RC04 isolated child operation failed; no provider, credential or assertion payload is published.',
  kind:['AssertionError','TypeError','RangeError','Error'].includes(cause?.name)?cause.name:'Error',
  ...(/^THREADED_[A-Z0-9_]+$/.test(cause?.domainCode??'')?{domainCode:cause.domainCode}:{}),
  ...trace(cause?.requestTrace),
  locations:[...(Array.isArray(cause?.locations)?cause.locations.filter(value=>/^\d+:\d+$/.test(value)).map(value=>`scripts/fixtures/threadedRc04Harness.mjs:${value}`):[]),...String(cause?.stack??'').split('\n').flatMap(line=>{
    const match=/\/agent-gand\/(scripts|apps)\/([^():]+):(\d+):(\d+)\)?$/.exec(line);
    return match?[`${match[1]}/${match[2]}:${match[3]}:${match[4]}`]:[];
  })].slice(0,5)});
function send(value){if(process.connected)process.send(value);}
globalThis.fetch=async()=>{forbiddenNetworkCalls++;throw Object.assign(new Error('RC04_DIRECT_NETWORK_FORBIDDEN'),{code:'RC04_DIRECT_NETWORK_FORBIDDEN'});};

async function githubFetch(input,init){
  const headers=new Headers(init?.headers);
  if(headers.get('authorization')!==`Bearer ${PLACEHOLDER}`)throw Object.assign(new Error('RC04_IPC_CAPABILITY_INVALID'),{code:'RC04_IPC_CAPABILITY_INVALID'});
  // A real credential must never enter IPC, including via an inherited header.
  headers.delete('authorization');
  const requestId=++sequence;
  const response=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{requests.delete(requestId);reject(Object.assign(new Error('RC04_IPC_TIMEOUT'),{code:'RC04_IPC_TIMEOUT'}));},25_000);
    requests.set(requestId,{resolve,reject,timer});
    send({type:'github-get',requestId,url:String(input),method:init.method,redirect:init.redirect,cache:init.cache,headers:[...headers.entries()]});
  });
  if(typeof response.body!=='string'||Buffer.byteLength(response.body)>MAX_BYTES)throw Object.assign(new Error('RC04_IPC_RESPONSE_INVALID'),{code:'RC04_IPC_RESPONSE_INVALID'});
  return new Response(response.body,{status:response.status,headers:response.headers});
}

process.on('message',message=>{
  if(message?.type==='github-response'){
    const pending=requests.get(message.requestId);if(!pending)return;
    requests.delete(message.requestId);clearTimeout(pending.timer);
    if(message.error)pending.reject(Object.assign(new Error('RC04_PARENT_GET_FAILED'),{code:'RC04_PARENT_GET_FAILED'}));
    else pending.resolve(message.response);
    return;
  }
  chain=chain.then(async()=>{
    const id=message?.id;
    try{
      if(message?.operation==='open'){
        if(initialized)throw new Error('Already initialized');initialized=true;
        const {root,options}=message;
        harness=await openRc04Harness(root,{...options,readToken:()=>PLACEHOLDER,githubFetch});
        send({id,result:{pid:process.pid,snapshot:await harness.snapshot(),forbiddenNetworkCalls,bootPolicy}});return;
      }
      if(!harness||!['initialize','poll','advanceObserved','snapshot','rebuild','close'].includes(message?.operation))throw new Error('Unsupported isolated operation');
      const result=await harness[message.operation]();
      send({id,result:message.operation==='close'?true:result,forbiddenNetworkCalls});
      if(message.operation==='close')process.disconnect();
    }catch(cause){send({id,error:safeError(cause),forbiddenNetworkCalls});}
  });
});
process.on('disconnect',()=>{
  for(const request of requests.values()){clearTimeout(request.timer);request.reject(new Error('Parent disconnected'));}
  requests.clear();
  // This worker owns only its disposable SQLite/process composition. Any native
  // command ownership has separate guardian semantics and is outside RC04.
  Promise.resolve(harness?.close()).finally(()=>process.exit(0));
});
