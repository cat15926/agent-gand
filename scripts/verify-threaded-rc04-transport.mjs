/** Injected transport verification only: no real credential helper or network. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRc04ReadonlyGithub} from './fixtures/threadedRc04ReadonlyGithub.mjs';

const repository='zts212653/clowder-ai',origin='https://api.github.com',base=`/repos/${repository}/pulls`;
const list=`${base}?state=open&sort=updated&direction=desc&per_page=30`,token='fixture-only-rc04-secret';
const output=path.resolve(process.env.THREADED_RC04_TRANSPORT_OUTPUT??'docs/reports/evidence/threaded-rc04/transport.json');
const checks=[];
const pr=(number,extra={})=>({number,user:{login:'independent-author'},updated_at:'2026-10-22T08:00:00Z',state:'open',merged:false,merged_at:null,
  html_url:`https://github.com/${repository}/pull/${number}`,base:{repo:{full_name:repository}},head:{sha:'a'.repeat(40)},merge_commit_sha:null,...extra});
const init=extra=>({method:'GET',redirect:'error',cache:'no-store',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2022-11-28','Cache-Control':'no-cache, no-store','User-Agent':'agent-gand-rc04-transport-fixture'},...extra});
const reject=async(operation,code)=>assert.rejects(operation,value=>value?.code===code&&value.message===code);
function fixture({reader=()=>token,respond,identity={login:'reviewer',id:42},pulls}={}){
  const calls=[];let detail=number=>pr(number),readerCalls=0;
  const options={authorizedGitCredential:true,repository,now:()=>1792656000000,readCredential:()=>{readerCalls++;return reader();},fetch:async(url,request)=>{
    const parsed=new URL(url);calls.push({path:parsed.pathname+parsed.search,signal:request.signal});
    assert.equal(new Headers(request.headers).get('authorization'),`Bearer ${token}`);
    assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store');assert.ok(request.signal instanceof AbortSignal);
    if(respond)return respond(parsed,request);
    if(parsed.pathname==='/user')return Response.json(identity);
    if(parsed.pathname+parsed.search===list)return Response.json(pulls??[
      pr(1,{user:{login:'reviewer'}}),pr(2,{state:'closed'}),pr(3,{merged_at:'2026-10-22T08:01:00Z'}),pr(11),pr(12),pr(13),pr(14)]);
    return Response.json(detail(Number(parsed.pathname.split('/').at(-1))));
  }};
  return {options,calls,readerCalls:()=>readerCalls,setDetail:next=>{detail=next;}};
}
async function group(name,operation){await operation();checks.push(name);}

try{
  await group('RC04-T01: explicit authorization and fixed repository are checked before credential or network access',async()=>{
    const f=fixture();await reject(()=>createRc04ReadonlyGithub({...f.options,authorizedGitCredential:false}),'RC04_EXPLICIT_CREDENTIAL_AUTHORIZATION_REQUIRED');
    await reject(()=>createRc04ReadonlyGithub({...f.options,repository:'other/repository'}),'RC04_CONFIGURATION_INVALID');
    assert.equal(f.readerCalls(),0);assert.equal(f.calls.length,0);
  });
  await group('RC04-T02: helper and invalid-token failures expose fixed codes and perform no network access',async()=>{
    for(const reader of [()=>{throw new Error(token);},()=>'',()=>`bad token ${token}`]){
      const f=fixture({reader});await reject(()=>createRc04ReadonlyGithub(f.options),'RC04_CREDENTIAL_UNAVAILABLE');assert.equal(f.calls.length,0);
    }
  });
  await group('RC04-T03: discover verifies the user and selects at most three open unmerged independently authored PRs',async()=>{
    const f=fixture(),g=await createRc04ReadonlyGithub(f.options);try{
      const selected=await g.discover({limit:3});assert.equal(selected.principalLogin,'reviewer');assert.deepEqual(selected.selected.map(item=>item.number),[11,12,13]);
      assert.deepEqual(f.calls.map(item=>item.path),['/user',list]);assert.equal(g.stats().principalVerified,true);assert.equal(g.stats().selected,3);
      selected.selected[0].number=999;assert.deepEqual((await g.discover()).selected.map(item=>item.number),[11,12,13]);assert.equal(f.calls.length,2);
    }finally{g.close();}
  });
  await group('RC04-T04: exact selected detail scope is frozen and list arbitrary queries aliases URLs and writes are rejected before I/O',async()=>{
    const f=fixture(),g=await createRc04ReadonlyGithub(f.options);try{
      await reject(()=>g.fetch(`${origin}${base}/11`,init()),'RC04_GET_ALLOWLIST_REQUIRED');await g.discover();const before=f.calls.length;
      for(const url of [`${origin}${base}/14`,`${origin}${base}/11?x=1`,`${origin}${list}`,`${origin}${base}?per_page=100`,
        `${origin}/repos/other/repository/pulls/11`,`${origin}${base}/11/reviews`,`${origin}${base}/11#x`,
        'https://other.example/user','https://user:password@api.github.com/user',`${origin}/repos/zts212653/clowder-ai/pulls/%31%31`])
        await reject(()=>g.fetch(url,init()),'RC04_GET_ALLOWLIST_REQUIRED');
      for(const extra of [{method:'POST'},{method:'PUT'},{body:'x'},{redirect:'follow'},{cache:'force-cache'},{cache:undefined},
        {dispatcher:{}},{headers:{...init().headers,Authorization:'Bearer other'}},{headers:{...init().headers,'X-Extra':'x'}}])
        await reject(()=>g.fetch(`${origin}${base}/11`,init(extra)),'RC04_GET_ALLOWLIST_REQUIRED');
      assert.equal(f.calls.length,before);
    }finally{g.close();}
  });
  await group('RC04-T05: safe observations retain actual response hashes and sequence without manufacturing HEAD changes',async()=>{
    const f=fixture(),g=await createRc04ReadonlyGithub(f.options);try{
      await g.discover();await g.fetch(`${origin}${base}/11`,init());await g.fetch(`${origin}${base}/11`,init());
      assert.equal(g.observations.length,2);assert.deepEqual(g.observations.map(item=>item.headSha),['a'.repeat(40),'a'.repeat(40)]);
      assert.equal(g.observations[0].responseSha256,createHash('sha256').update(JSON.stringify(pr(11))).digest('hex'));
      f.setDetail(number=>pr(number,{head:{sha:'b'.repeat(40)},updated_at:'2026-10-22T08:10:00Z'}));
      const value=await(await g.fetch(`${origin}${base}/11`,init())).json();assert.equal(value.head.sha,'b'.repeat(40));
      assert.deepEqual(g.observations.map(item=>item.sequence),[3,4,5]);assert.equal(g.observations[2].headSha,'b'.repeat(40));
      assert.equal(g.observations[2].observedAt,new Date(1792656000000).toISOString());
      assert.equal('headChanged' in g.observations[2],false);assert.equal(g.stats().observations,3);
    }finally{g.close();}
  });
  await group('RC04-T06: redirect and foreign response URL are rejected without exposing response bodies',async()=>{
    for(const property of [{redirected:true},{url:'https://other.example/user'}]){
      const f=fixture({respond:()=>{const response=Response.json({login:'reviewer',id:42,secret:token});
        for(const [key,value]of Object.entries(property))Object.defineProperty(response,key,{value});return response;}}),g=await createRc04ReadonlyGithub(f.options);
      try{await reject(()=>g.discover(),'RC04_RESPONSE_UNVERIFIABLE');assert.equal(JSON.stringify({requests:g.requests,observations:g.observations,stats:g.stats()}).includes(token),false);}
      finally{g.close();}
    }
  });
  await group('RC04-T07: one MiB header and streamed-body bounds reject oversized responses',async()=>{
    for(const response of [()=>new Response('{}',{headers:{'content-length':String(1024*1024+1)}}),
      ()=>new Response(' '.repeat(1024*1024+1)),()=>new Response('{}',{headers:{'content-length':'unknown'}})]){
      const f=fixture({respond:response}),g=await createRc04ReadonlyGithub(f.options);try{await reject(()=>g.discover(),'RC04_RESPONSE_UNVERIFIABLE');}
      finally{g.close();}
    }
  });
  await group('RC04-T08: official authentication failures clear credentials and fence later network requests',async()=>{
    for(const status of [401,403]){
      const f=fixture({respond:()=>new Response(token,{status})}),g=await createRc04ReadonlyGithub(f.options);try{
        await reject(()=>g.discover(),'RC04_CREDENTIAL_UNAVAILABLE');assert.equal(g.readToken('THREADED_GITHUB_TOKEN_RC04'),undefined);
        const before=f.calls.length;await reject(()=>g.fetch(`${origin}/user`,init()),'RC04_CREDENTIAL_UNAVAILABLE');assert.equal(f.calls.length,before);
      }finally{g.close();}
    }
  });
  await group('RC04-T09: malformed identity discovery and detail facts fail with fixed safe errors',async()=>{
    for(const identity of [{login:'bad login',id:42},{login:'reviewer',id:0}]){
      const f=fixture({identity}),g=await createRc04ReadonlyGithub(f.options);try{await reject(()=>g.discover(),'RC04_PRINCIPAL_UNVERIFIABLE');}finally{g.close();}
    }
    const f=fixture(),g=await createRc04ReadonlyGithub(f.options);try{
      await g.discover();for(const extra of [{number:12},{head:{sha:token}},{updated_at:'invalid'},{base:{repo:{full_name:'other/repo'}}}]){
        f.setDetail(number=>pr(number,extra));await reject(()=>g.fetch(`${origin}${base}/11`,init()),'RC04_RESPONSE_UNVERIFIABLE');
      }
      assert.equal(g.observations.length,0);
    }finally{g.close();}
  });
  await group('RC04-T10: empty independent open selection and out-of-range discovery limits are explicit',async()=>{
    const f=fixture({pulls:[pr(1,{user:{login:'reviewer'}})]}),g=await createRc04ReadonlyGithub(f.options);try{
      for(const limit of [0,4,NaN,1.5])await reject(()=>g.discover({limit}),'RC04_DISCOVERY_LIMIT_INVALID');assert.equal(f.calls.length,0);
      await reject(()=>g.discover(),'RC04_NO_ELIGIBLE_OPEN_PR');assert.equal(g.stats().selected,0);
      await reject(()=>g.fetch(`${origin}${base}/1`,init()),'RC04_GET_ALLOWLIST_REQUIRED');
    }finally{g.close();}
  });
  await group('RC04-T11: transport errors and secret-bearing response fields never enter public evidence or environment',async()=>{
    const before=Object.entries(process.env),f=fixture(),g=await createRc04ReadonlyGithub(f.options);try{
      await g.discover();f.setDetail(number=>pr(number,{secretNote:token}));await g.fetch(`${origin}${base}/11`,init());
      assert.equal(JSON.stringify({requests:g.requests,observations:g.observations,stats:g.stats()}).includes(token),false);
      assert.deepEqual(Object.entries(process.env),before);assert.equal(g.readToken('UNRELATED_SECRET'),undefined);assert.equal(g.readToken('THREADED_GITHUB_TOKEN_RC04'),token);
    }finally{g.close();}
    const broken=fixture({respond:()=>{throw new Error(token);}}),h=await createRc04ReadonlyGithub(broken.options);try{
      await reject(()=>h.discover(),'RC04_TRANSPORT_UNAVAILABLE');assert.equal(JSON.stringify(h.requests).includes(token),false);
    }finally{h.close();}
  });
  await group('RC04-T12: close aborts an active request clears credential and rejects future I/O',async()=>{
    let started;const ready=new Promise(resolve=>{started=resolve;});
    const f=fixture({respond:async()=>{started();return new Promise(()=>{});}}),g=await createRc04ReadonlyGithub(f.options);
    const discovery=g.discover();await ready;g.close();await reject(()=>discovery,'RC04_CLOSED');
    assert.equal(f.calls[0].signal.aborted,true);assert.equal(g.readToken('THREADED_GITHUB_TOKEN_RC04'),undefined);
    await reject(()=>g.fetch(`${origin}/user`,init()),'RC04_CLOSED');assert.equal(f.calls.length,1);assert.equal(g.stats().activeRequests,0);
  });
  const result={ok:true,scope:'Injected credential reader and fetch only; no real helper, GitHub requests, model calls or external writes',
    completedAt:new Date().toISOString(),groups:checks.length,checks,realCredentialReads:0,realNetworkRequests:0,realModelCalls:0,realExternalWrites:0};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:true,groups:checks.length,realNetworkRequests:0,output},null,2));
}catch{console.error(JSON.stringify({ok:false,code:'RC04_TRANSPORT_INJECTED_VERIFICATION_FAILED',completedGroups:checks.length}));process.exitCode=1;}
