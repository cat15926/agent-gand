/** RC04 production source audience authority; local configuration and injected credentials only. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadThreadedProductionGithub} from '../apps/server/src/threaded/productionGithub.ts';

const repository='zts212653/clowder-ai',subject=`${repository}#123`,scope={ownerId:'rc04-owner',threadId:'rc04-thread',agentId:'caller'};
const token='fixture-only-rc04-authority-token',checks=[];
const output=path.resolve(process.env.THREADED_RC04_DELIVERY_AUTH_OUTPUT??'docs/reports/evidence/threaded-rc04/delivery-authorization.json');
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc04-delivery-auth-')));
async function fixture(name){
  const file=path.join(root,`${name}.json`),members=new Map([['caller','caller-v1'],['reviewer','reviewer-v1'],['__proto__','prototype-v1'],['outside-registration','outside-v1']]);
  let mode='execute',credential=token,network=0;
  const configuration={schemaVersion:1,version:1,ownerId:scope.ownerId,credential:{source:'environment',name:'THREADED_GITHUB_TOKEN_RC04',version:1},
    repositories:[{repository,pullNumbers:[123],threadIds:[scope.threadId],
      actors:['caller','reviewer','revoked','__proto__'].map(agentId=>({agentId,githubLogin:'fixture-reviewer',mayAssign:agentId==='caller'}))}]};
  await writeFile(file,JSON.stringify(configuration));
  const provider=loadThreadedProductionGithub({file,ownerId:scope.ownerId,mode:()=>mode,
    authorizeMember:current=>current.ownerId===scope.ownerId&&current.threadId===scope.threadId?members.get(current.agentId)??null:null,
    readToken:name=>name==='THREADED_GITHUB_TOKEN_RC04'?credential:undefined,
    fetch:async()=>{network++;throw new Error('RC04_UNEXPECTED_NETWORK');},assertOutsideTransaction(){}});
  return {provider,members,configuration,file,network:()=>network,mode:value=>{mode=value;},credential:value=>{credential=value;}};
}
try{
  {
    const f=await fixture('scope'),delivery=f.provider.tracking.deliveryAuthorization(scope,subject);
    assert.deepEqual(Object.keys(delivery).sort(),['__proto__','caller','reviewer']);assert.equal(Object.getPrototypeOf(delivery),null);
    assert.equal(Object.hasOwn(delivery,'__proto__'),true);assert.equal(delivery.caller,f.provider.tracking.authorization(scope,subject));
    assert.equal(delivery.reviewer,f.provider.tracking.authorization({...scope,agentId:'reviewer'},subject));assert.notEqual(delivery.caller,delivery.reviewer);
    assert.equal(JSON.stringify(delivery).includes(token),false);assert.equal(f.network(),0);
    checks.push('RC04-DA01: only registered currently authorized actors receive distinct exact-scope fingerprints; null-prototype output is safe for prototype-like IDs and exposes no credential or network');
    for(const [candidate,target]of [[{...scope,ownerId:'other-owner'},subject],[{...scope,threadId:'other-thread'},subject],
      [{...scope,agentId:'outside-registration'},subject],[{...scope,agentId:'bad agent'},subject],[scope,`${repository}#124`],
      [scope,'other/repository#123'],[scope,'https://github.com/zts212653/clowder-ai/pull/123'],[scope,`${subject}?query=1`]])
      assert.equal(f.provider.tracking.deliveryAuthorization(candidate,target),null);
    assert.equal(f.network(),0);checks.push('RC04-DA02: wrong owner Thread caller registration PR repository or model-supplied URL cannot expand delivery authority');
    f.members.delete('reviewer');assert.equal(Object.hasOwn(f.provider.tracking.deliveryAuthorization(scope,subject),'reviewer'),false);
    f.members.set('reviewer','reviewer-v2');const changed=f.provider.tracking.deliveryAuthorization(scope,subject);
    assert.notEqual(changed.reviewer,delivery.reviewer);assert.equal(changed.caller,delivery.caller);
    f.members.delete('caller');assert.equal(f.provider.tracking.deliveryAuthorization(scope,subject),null);
    assert.equal(f.network(),0);checks.push('RC04-DA03: recipient revocation removes sharing changed membership yields a new fingerprint and caller revocation denies the entire audience without network');
  }
  {
    const f=await fixture('observe');assert.ok(f.provider.tracking.deliveryAuthorization(scope,subject));f.mode('observe');
    assert.equal(f.provider.tracking.deliveryAuthorization(scope,subject),null);f.mode('invalid');assert.equal(f.provider.tracking.deliveryAuthorization(scope,subject),null);
    assert.equal(f.network(),0);checks.push('RC04-DA04: observe and unknown production modes cannot authorize source sharing');
  }
  {
    const f=await fixture('credential');assert.ok(f.provider.tracking.deliveryAuthorization(scope,subject));f.credential(`${token}-changed`);
    assert.equal(f.provider.tracking.deliveryAuthorization(scope,subject),null);assert.equal(f.provider.status().state,'credential_changed');assert.equal(f.network(),0);
    checks.push('RC04-DA05: changed pinned credentials fence source audience authorization without exposing tokens or contacting GitHub');
  }
  {
    const f=await fixture('configuration');assert.ok(f.provider.tracking.deliveryAuthorization(scope,subject));
    await writeFile(f.file,JSON.stringify({...f.configuration,version:2}));assert.equal(f.provider.tracking.deliveryAuthorization(scope,subject),null);
    assert.equal(f.provider.status().state,'configuration_changed');assert.equal(f.network(),0);
    checks.push('RC04-DA06: registration drift cannot preserve a previously granted delivery audience');
  }
  const result={ok:true,scope:'Production GitHub delivery audience authorization with local temporary config and injected in-memory credential; no GitHub or model traffic',
    completedAt:new Date().toISOString(),groups:checks.length,checks,realCredentialReads:0,realNetworkRequests:0,realModelCalls:0,realExternalWrites:0};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:true,groups:checks.length,realNetworkRequests:0,output},null,2));
}catch{console.error(JSON.stringify({ok:false,code:'RC04_DELIVERY_AUTHORIZATION_VERIFICATION_FAILED',completedGroups:checks.length}));process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});}
