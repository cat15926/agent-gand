/** RC04-only official GitHub GET transport. Credentials never enter evidence or environment. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const REPOSITORY='zts212653/clowder-ai';
const ORIGIN='https://api.github.com';
const LIST_PATH=`/repos/${REPOSITORY}/pulls`;
const LIST_QUERY='?state=open&sort=updated&direction=desc&per_page=30';
const MAX_BYTES=1024*1024;
const TIMEOUT_MS=20_000;
const login=value=>typeof value==='string'&&/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/.test(value);
const number=value=>Number.isSafeInteger(value)&&value>0&&value<=1_000_000_000;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const error=code=>Object.assign(new Error(code),{code});
const fail=code=>{throw error(code);};
const safeCodes=new Set(['RC04_CLOSED','RC04_CREDENTIAL_UNAVAILABLE','RC04_GET_ALLOWLIST_REQUIRED','RC04_RESPONSE_UNVERIFIABLE','RC04_TRANSPORT_UNAVAILABLE','RC04_TIMEOUT']);

function gitCredentialToken(){
  let response=null;
  try{
    response=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',
      timeout:TIMEOUT_MS,maxBuffer:64*1024,stdio:['pipe','pipe','ignore']});
    return response.split('\n').find(line=>line.startsWith('password='))?.slice(9)??null;
  }catch{fail('RC04_CREDENTIAL_UNAVAILABLE');}
  finally{response=null;}
}

/** `readCredential`, when injected, returns the credential token itself, not helper output.
 * A fresh discovery and baseline are required; no historical HEAD is supplied here. */
export async function createRc04ReadonlyGithub({authorizedGitCredential,repository=REPOSITORY,
  readCredential=gitCredentialToken,fetch:transport=globalThis.fetch,now=Date.now}={}){
  if(authorizedGitCredential!==true)fail('RC04_EXPLICIT_CREDENTIAL_AUTHORIZATION_REQUIRED');
  if(repository!==REPOSITORY||typeof readCredential!=='function'||typeof transport!=='function'||typeof now!=='function')
    fail('RC04_CONFIGURATION_INVALID');
  let token=null,state='initializing',principalLogin=null,selection=null,discovering=false,sequence=0;
  const allowedDetails=new Set(),active=new Set(),requests=[],observations=[];
  try{token=await readCredential();}catch{fail('RC04_CREDENTIAL_UNAVAILABLE');}
  readCredential=null;
  if(typeof token!=='string'||!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)){token=null;fail('RC04_CREDENTIAL_UNAVAILABLE');}
  state='ready';
  const at=()=>{let value;try{value=now();}catch{fail('RC04_CLOCK_INVALID');}
    if(!Number.isFinite(value))fail('RC04_CLOCK_INVALID');return new Date(value).toISOString();};
  function assertActive(){if(state==='closed')fail('RC04_CLOSED');if(state!=='ready'||token===null)fail('RC04_CREDENTIAL_UNAVAILABLE');}
  function urlFor(input,internal){
    if(typeof input!=='string'&&!(input instanceof URL))fail('RC04_GET_ALLOWLIST_REQUIRED');
    const raw=String(input);let url;try{url=new URL(raw);}catch{fail('RC04_GET_ALLOWLIST_REQUIRED');}
    if(raw!==url.href||url.origin!==ORIGIN||url.username||url.password||url.hash)fail('RC04_GET_ALLOWLIST_REQUIRED');
    if(url.pathname==='/user'&&!url.search)return url;
    if(internal&&url.pathname===LIST_PATH&&url.search===LIST_QUERY)return url;
    if(!url.search&&allowedDetails.has(url.pathname))return url;
    fail('RC04_GET_ALLOWLIST_REQUIRED');
  }
  function validateInit(init){
    if(!init||Object.keys(init).some(key=>!['method','redirect','cache','headers','signal','credentials','mode'].includes(key))
      ||init.method!=='GET'||init.redirect!=='error'||init.cache!=='no-store'||init.body!==undefined
      ||init.credentials&&init.credentials!=='omit'||init.mode&&init.mode!=='cors')fail('RC04_GET_ALLOWLIST_REQUIRED');
    let headers;try{headers=new Headers(init.headers);}catch{fail('RC04_GET_ALLOWLIST_REQUIRED');}
    const names=[...headers.keys()];
    if(names.some(name=>!['authorization','accept','x-github-api-version','cache-control','user-agent'].includes(name))
      ||headers.get('authorization')!==`Bearer ${token}`||headers.get('accept')!=='application/vnd.github+json'
      ||headers.get('x-github-api-version')!=='2022-11-28'||headers.get('cache-control')!=='no-cache, no-store'
      ||!/^agent-gand-[a-z0-9-]{1,100}$/.test(headers.get('user-agent')??''))fail('RC04_GET_ALLOWLIST_REQUIRED');
    if(init.signal!==undefined&&!(init.signal instanceof AbortSignal))fail('RC04_GET_ALLOWLIST_REQUIRED');
  }
  const ownInit=()=>({method:'GET',redirect:'error',cache:'no-store',headers:{Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache, no-store',
    'User-Agent':'agent-gand-rc04-readonly-acceptance'}});
  async function request(input,init,internal=false){
    assertActive();const url=urlFor(input,internal);validateInit(init);
    const requestSequence=++sequence,controller=new AbortController();active.add(controller);
    let timeout,abortListener,response;
    const abortFailure=new Promise((_,reject)=>{
      abortListener=()=>reject(error(state==='closed'?'RC04_CLOSED':'RC04_TIMEOUT'));
      controller.signal.addEventListener('abort',abortListener,{once:true});
      timeout=setTimeout(()=>controller.abort(),TIMEOUT_MS);timeout.unref?.();
    });
    const signal=init.signal?AbortSignal.any([controller.signal,init.signal]):controller.signal;
    const assertRequestActive=()=>{assertActive();if(signal.aborted)fail('RC04_TIMEOUT');};
    const record={sequence:requestSequence,path:url.pathname+url.search,method:'GET',requestedAt:at()};requests.push(record);
    try{
      return await Promise.race([(async()=>{
        try{response=await transport(url.href,{...init,signal});}catch{fail('RC04_TRANSPORT_UNAVAILABLE');}
        if(!(response instanceof Response)||response.redirected||(response.url&&response.url!==url.href))fail('RC04_RESPONSE_UNVERIFIABLE');
        assertRequestActive();record.status=response.status;record.observedAt=at();
        if(response.status===401||response.status===403){state='credential_unavailable';token=null;fail('RC04_CREDENTIAL_UNAVAILABLE');}
        if(!response.ok||!response.body)fail('RC04_RESPONSE_UNVERIFIABLE');
        const length=response.headers.get('content-length');
        if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))fail('RC04_RESPONSE_UNVERIFIABLE');
        const reader=response.body.getReader(),chunks=[];let count=0;
        try{while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.byteLength;
          if(count>MAX_BYTES){await reader.cancel();fail('RC04_RESPONSE_UNVERIFIABLE');}chunks.push(chunk.value);}}
        finally{reader.releaseLock();}
        assertRequestActive();record.observedAt=at();const bytes=Buffer.concat(chunks);record.responseSha256=createHash('sha256').update(bytes).digest('hex');
        let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('RC04_RESPONSE_UNVERIFIABLE');}
        if(url.pathname!=='/user'&&url.pathname!==LIST_PATH){
          if(!object(value)||!number(value.number)||url.pathname!==`${LIST_PATH}/${value.number}`||!object(value.head)
            ||typeof value.head.sha!=='string'||!/^[a-f0-9]{40}$/i.test(value.head.sha)||!timestamp(value.updated_at)
            ||!['open','closed'].includes(value.state)||typeof value.merged!=='boolean'||!object(value.user)||!login(value.user.login)
            ||!object(value.base)||!object(value.base.repo)||typeof value.base.repo.full_name!=='string'
            ||value.base.repo.full_name.toLowerCase()!==REPOSITORY)fail('RC04_RESPONSE_UNVERIFIABLE');
          observations.push({sequence:requestSequence,repository:REPOSITORY,number:value.number,headSha:value.head.sha.toLowerCase(),
            updatedAt:value.updated_at,state:value.state,merged:value.merged,authorLogin:value.user.login.toLowerCase(),
            observedAt:record.observedAt,responseSha256:record.responseSha256});
        }
        return new Response(bytes,{status:response.status,headers:{'content-type':'application/json','content-length':String(bytes.length),'cache-control':'no-store'}});
      })(),abortFailure]);
    }catch(cause){
      const code=safeCodes.has(cause?.code)?cause.code:'RC04_RESPONSE_UNVERIFIABLE';record.code=code;
      try{void response?.body?.cancel().catch(()=>{});}catch{/* Never publish raw transport/helper errors. */}
      fail(code);
    }finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',abortListener);active.delete(controller);}
  }
  return {
    requests,observations,
    async discover({limit=3}={}){
      assertActive();if(!Number.isInteger(limit)||limit<1||limit>3)fail('RC04_DISCOVERY_LIMIT_INVALID');
      if(selection)return {principalLogin,selected:selection.map(item=>({...item}))};
      if(discovering)fail('RC04_DISCOVERY_IN_PROGRESS');discovering=true;
      try{
        const identity=await(await request(`${ORIGIN}/user`,ownInit(),true)).json();
        if(!object(identity)||!login(identity.login)||!number(identity.id))fail('RC04_PRINCIPAL_UNVERIFIABLE');
        principalLogin=identity.login.toLowerCase();
        const pulls=await(await request(`${ORIGIN}${LIST_PATH}${LIST_QUERY}`,ownInit(),true)).json();
        if(!Array.isArray(pulls)||pulls.length>30)fail('RC04_DISCOVERY_UNVERIFIABLE');
        const selected=[];const seen=new Set();
        for(const pr of pulls){
          if(!object(pr)||!number(pr.number)||!object(pr.user)||!login(pr.user.login)||!timestamp(pr.updated_at)
            ||!object(pr.base)||!object(pr.base.repo)||typeof pr.base.repo.full_name!=='string'
            ||pr.base.repo.full_name.toLowerCase()!==REPOSITORY)fail('RC04_DISCOVERY_UNVERIFIABLE');
          if(pr.state!=='open'||pr.merged===true||pr.merged_at!==null||pr.user.login.toLowerCase()===principalLogin||seen.has(pr.number))continue;
          if(pr.html_url!==`https://github.com/${REPOSITORY}/pull/${pr.number}`)fail('RC04_DISCOVERY_UNVERIFIABLE');
          seen.add(pr.number);selected.push({repository:REPOSITORY,number:pr.number,url:pr.html_url,
            authorLogin:pr.user.login.toLowerCase(),listedUpdatedAt:pr.updated_at});
          if(selected.length===limit)break;
        }
        if(!selected.length)fail('RC04_NO_ELIGIBLE_OPEN_PR');
        assertActive();selection=selected.map(item=>Object.freeze(item));
        for(const item of selection)allowedDetails.add(`${LIST_PATH}/${item.number}`);
        return {principalLogin,selected:selection.map(item=>({...item}))};
      }catch(cause){
        if(typeof cause?.code==='string'&&/^RC04_[A-Z_]+$/.test(cause.code))throw cause;
        fail('RC04_DISCOVERY_UNVERIFIABLE');
      }finally{discovering=false;}
    },
    fetch:(input,init)=>request(input,init),
    readToken:name=>state==='ready'&&typeof name==='string'&&/^THREADED_GITHUB_TOKEN_[A-Z0-9_]{1,100}$/.test(name)?token:undefined,
    stats:()=>({state,requests:requests.length,observations:observations.length,selected:selection?.length??0,
      principalVerified:principalLogin!==null,activeRequests:active.size,realExternalWrites:0}),
    close(){state='closed';token=null;for(const controller of active)controller.abort();allowedDetails.clear();},
  };
}
