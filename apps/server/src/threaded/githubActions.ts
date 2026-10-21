import type {ActionPrSource,ActionScope,PrAuthority} from './actionTypes.ts';
import {reject,text} from './collaborationTypes.ts';
/** Read-only GitHub REST transport; redirects, cache fallback and arbitrary model URLs are forbidden. */
export function githubActionSource(options:{
  authorize:(scope:ActionScope,repository:string)=>PrAuthority|null;
  token:()=>string|null;fetch?:typeof fetch;
}):ActionPrSource {
  return {authorize:options.authorize,async current(scope,subject){
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subject.repository)||!Number.isSafeInteger(subject.number)||subject.number<1)
      reject('THREADED_PR_SUBJECT_INVALID',400);
    const auth=options.authorize(scope,subject.repository),token=options.token();
    if(!auth||!token)reject('THREADED_PR_CREDENTIAL_REQUIRED',403);
    let response:Response;
    try{response=await(options.fetch??fetch)(`https://api.github.com/repos/${subject.repository}/pulls/${subject.number}`,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{'Cache-Control':'no-cache, no-store',
        Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'agent-gand-threaded-actions'}});
    }catch{reject('THREADED_PR_UNVERIFIABLE',503);}
    if(!response.ok)reject('THREADED_PR_UNVERIFIABLE',503);
    const value=await response.json() as {number?:number;head?:{sha?:string};base?:{repo?:{full_name?:string}};user?:{login?:string};updated_at?:string};
    if(value.number!==subject.number||value.base?.repo?.full_name?.toLowerCase()!==subject.repository.toLowerCase()
      ||!/^[a-f0-9]{40}$/i.test(value.head?.sha??''))reject('THREADED_PR_UNVERIFIABLE',503);
    if(options.authorize(scope,subject.repository)?.fingerprint!==auth.fingerprint)reject('THREADED_PR_AUTHORITY_CHANGED',403);
    return {repository:subject.repository.toLowerCase(),number:subject.number,headSha:value.head!.sha!.toLowerCase(),
      authorLogin:text(value.user?.login).toLowerCase(),updatedAt:text(value.updated_at)};
  }};
}
