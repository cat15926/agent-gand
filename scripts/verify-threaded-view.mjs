import assert from 'node:assert/strict';
import {ThreadedSync} from '../apps/web/src/services/threadedSync.ts';
import {ThreadedApi} from '../apps/web/src/services/threadedApi.ts';
import {ApiError} from '../apps/web/src/services/apiError.ts';
const checks=[];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const value=(cursor=1,messages=[])=>({snapshot:{httpVersion:'threaded-http-v1',schemaVersion:1,thread:{id:'a'},eventCursor:cursor,messages},changes:{events:[]}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){const states=[],sockets=[],requests=[];const api={view(...args){const gate=deferred();requests.push({args,...gate});return gate.promise;}};
  const controller=new ThreadedSync(api,'a',state=>states.push(state),{url:'ws://fixture.invalid/api/threaded/ws',retryMs:5,socket(url){
    const socket={url,close(){},onopen:null,onclose:null,onmessage:null,onerror:null};sockets.push(socket);return socket;}});
  return {controller,states,sockets,requests};}
{
  const f=setup(),start=f.controller.start();f.requests[0].resolve(value(4,[{id:'private',body:'PRIVATE'}]));await start;
  assert.equal(f.sockets.length,1);assert.match(f.sockets[0].url,/afterEventSeq=4/);
  f.sockets[0].onopen();await tick();assert.equal(f.requests.length,2);
  f.requests[1].resolve(value(5,[{id:'same',body:'new authorized set'}]));await tick();
  assert.deepEqual(f.states.at(-1).snapshot.messages,[{id:'same',body:'new authorized set'}]);
  f.sockets[0].onmessage({data:JSON.stringify({type:'threaded.invalidate',threadId:'other',httpVersion:'threaded-http-v1'})});await tick();assert.equal(f.requests.length,2);
  f.sockets[0].onmessage({data:JSON.stringify({type:'threaded.invalidate',threadId:'a',httpVersion:'threaded-http-v1'})});await tick();
  f.sockets[0].onmessage({data:JSON.stringify({type:'threaded.invalidate',threadId:'a',httpVersion:'threaded-http-v1'})});
  f.requests[2].resolve(value(6,[]));await tick();assert.equal(f.requests.length,4);f.requests[3].resolve(value(7,[]));await tick();
  assert.equal(f.states.at(-1).snapshot.eventCursor,7);f.controller.stop();
  checks.push('Authorized snapshot replacement removes earlier private bodies; foreign hints cannot route data; hints arriving during an in-flight read schedule another read without losing a wake');
}
{
  const f=setup(),start=f.controller.start();f.requests[0].resolve(value(1,[{id:'secret'}]));await start;
  const socket=f.sockets[0];socket.onopen();await tick();socket.onclose({code:1006});assert.equal(f.states.at(-1).snapshot,null);
  f.requests[1].resolve(value(2,[{id:'late-secret'}]));await tick();assert.equal(f.states.at(-1).snapshot,null);
  await new Promise(resolve=>setTimeout(resolve,15));assert.ok(f.requests.length>=3);f.requests[2].resolve(value(3,[{id:'restored'}]));await tick();await tick();
  assert.ok(f.sockets.length>=2);assert.equal(f.states.at(-1).snapshot.messages[0].id,'restored');
  socket.onmessage({data:JSON.stringify({type:'threaded.invalidate',threadId:'a',httpVersion:'threaded-http-v1'})});const count=f.requests.length;await tick();assert.equal(f.requests.length,count);
  f.controller.stop();
  checks.push('Socket loss immediately clears private state; a previous connection late response is discarded, new socket follows a fresh snapshot, and old handlers cannot change the new epoch');
}
{
  const f=setup(),start=f.controller.start();f.requests[0].reject(new ApiError('expired',401,{}));await start;
  assert.equal(f.states.at(-1).status,'disconnected');assert.equal(f.states.at(-1).snapshot,null);await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.requests.length,1);f.controller.stop();
  const late=setup(),pending=late.controller.start();late.controller.stop();late.requests[0].resolve(value(1,[{id:'stale'}]));await pending;assert.equal(late.states.at(-1).status,'closed');assert.equal(late.sockets.length,0);
  checks.push('Session expiry stops retries without silent reauthentication; stopping or changing the mounted Thread discards unresolved reads and never creates a stale subscription');
}
{
  const calls=[];const api=new ThreadedApi(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({error:'expired',code:'THREADED_SESSION_REQUIRED'}),{status:401});});
  await assert.rejects(()=>api.resume(),/expired/);assert.equal(calls.length,1);assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.cache,'no-store');
  assert.equal(calls[0].init.headers['x-gand-threaded-http-version'],'threaded-http-v1');
  checks.push('Dedicated HTTP client sends explicit version and same-origin/no-store; a 401 read performs zero management bootstrap or mutation retries');
}
console.log(JSON.stringify({ok:true,groups:checks.length,checks,realModelCalls:0,externalNetworkCalls:0},null,2));
