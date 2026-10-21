import {readFileSync,mkdirSync,realpathSync} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {AccountConnection} from '@agent-gand/shared';
import type {ThreadedBackendAgentConfiguration} from './backendRuntime.ts';
import type {ThreadedReleaseMember} from './release.ts';
import {ThreadedAuthorityError} from './contracts.ts';
import {THREADED_APPLICATION_TOOL_NAMES} from './tools.ts';
import {anthropicAuthHeaders} from '../accounts/headers.ts';

const fail=(code:string):never=>{throw new ThreadedAuthorityError(code);};
interface Pack {schemaVersion:1;platform:'darwin';members:ThreadedReleaseMember[];applicationTools:string[];
  maxOutputTokens:number;maxInputTokens:number;maxRequests:number;prices?:Record<string,{inputPerMillion:number;outputPerMillion:number}>}
/** Operator-controlled file contains pinned public metadata only. No credential or model-selected paths. */
export function loadThreadedProductionSettings(db:Database.Database,options:{file?:string;workspaceRoot:string;privateRoot:string;
  readCredential:(accountId:string,version:number)=>string;platform?:string}){
  if(!options.file)return null;
  const raw=JSON.parse(readFileSync(options.file,'utf8')) as Pack;
  const allowed=['schemaVersion','platform','members','applicationTools','maxOutputTokens','maxInputTokens','maxRequests','prices'];
  if(!raw||Object.keys(raw).some(k=>!allowed.includes(k))||raw.schemaVersion!==1||raw.platform!==(options.platform??process.platform)
    ||raw.platform!=='darwin'||!Array.isArray(raw.members)||!raw.members.length||raw.members.length>8
    ||!Array.isArray(raw.applicationTools)||raw.applicationTools.some(n=>!THREADED_APPLICATION_TOOL_NAMES.includes(n))
    ||new Set(raw.applicationTools).size!==raw.applicationTools.length)fail('THREADED_RELEASE_CONFIGURATION_INVALID');
  for(const [n,min,max] of [[raw.maxOutputTokens,1,8192],[raw.maxInputTokens,8192,250000],[raw.maxRequests,1,16]] as const)
    if(!Number.isSafeInteger(n)||n<min||n>max)fail('THREADED_RELEASE_CONFIGURATION_INVALID');
  const memberKeys=['agentId','backend','backendVersion','model','roleVersion','permissionVersion','accountId','accountConfigVersion','accountCredentialVersion','accountIdentityGeneration'];
  for(const m of raw.members){
    if(!m||Object.keys(m).some(k=>!memberKeys.includes(k))||!/^[A-Za-z0-9_-]{1,100}$/.test(m.agentId)
      ||!['api','claude-sdk'].includes(m.backend)||m.backendVersion!==(m.backend==='api'?'threaded-http-v1':'0.3.288')
      ||typeof m.model!=='string'||!m.model.trim()||!m.accountId||!Number.isSafeInteger(m.roleVersion)||m.roleVersion<1
      ||!Number.isSafeInteger(m.permissionVersion)||m.permissionVersion<1
      ||!Number.isSafeInteger(m.accountConfigVersion)||!Number.isSafeInteger(m.accountCredentialVersion)
      ||m.accountConfigVersion!<1||m.accountCredentialVersion!<1)fail('THREADED_RELEASE_CONFIGURATION_INVALID');
  }
  if(new Set(raw.members.map(m=>m.agentId)).size!==raw.members.length)fail('THREADED_RELEASE_CONFIGURATION_INVALID');
  for(const [agent,price] of Object.entries(raw.prices??{}))if(!raw.members.some(m=>m.agentId===agent)||!price
    ||Object.keys(price).some(k=>!['inputPerMillion','outputPerMillion'].includes(k))
    ||![price.inputPerMillion,price.outputPerMillion].every(n=>Number.isFinite(n)&&n>=0))fail('THREADED_RELEASE_CONFIGURATION_INVALID');
  // A failed secret read is a stable process-local admission fault. Do not retry
  // decrypting on every queued/blocked notification; restart after operator repair.
  const unavailableCredentials=new Set<string>();
  function selected(agentId:string){return raw.members.find(m=>m.agentId===agentId)??fail('THREADED_RELEASE_MEMBER_NOT_REGISTERED');}
  function metadata(m:ThreadedReleaseMember){
    if(unavailableCredentials.has(m.agentId))return fail('THREADED_RELEASE_CREDENTIAL_UNAVAILABLE');
    const role=db.prepare('SELECT version,enabled,definition FROM agents WHERE id=?').get(m.agentId) as {version:number;enabled:number;definition:string}|undefined;
    const account=db.prepare('SELECT enabled,archived,auth_type,source,config_version,credential_version,identity_generation FROM accounts WHERE id=? AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)')
      .get(m.accountId) as {enabled:number;archived:number;auth_type:string;source:string;config_version:number;credential_version:number;identity_generation:number|null}|undefined;
    if(!role||role.enabled!==1||role.version!==m.roleVersion||!account||account.enabled!==1||account.archived!==0||account.auth_type!=='api_key'||account.source!=='managed'
      ||account.config_version!==m.accountConfigVersion||account.credential_version!==m.accountCredentialVersion
      ||account.identity_generation!==(m.accountIdentityGeneration??null))return fail('THREADED_RELEASE_PIN_CHANGED');
    const definition=JSON.parse(role.definition) as {accountRef?:string;model?:string;systemPrompt?:string;tools?:string[]};
    if(definition.accountRef!==m.accountId||definition.model!==m.model||typeof definition.systemPrompt!=='string'||!Array.isArray(definition.tools))return fail('THREADED_RELEASE_PIN_CHANGED');
    const row=db.prepare('SELECT connection FROM account_versions WHERE account_id=? AND version=?').get(m.accountId,m.accountConfigVersion) as {connection:string}|undefined;
    if(!row)return fail('THREADED_RELEASE_ACCOUNT_VERSION_MISSING');const connection=JSON.parse(row.connection) as AccountConnection;
    if(!db.prepare('SELECT 1 FROM account_credentials WHERE account_id=? AND version=?').get(m.accountId,m.accountCredentialVersion))return fail('THREADED_RELEASE_CREDENTIAL_VERSION_MISSING');
    if(new URL(connection.baseUrl).protocol!=='https:'||!connection.protocols.includes(m.backend==='claude-sdk'?'anthropic-messages':m.model.startsWith('openai:')?'openai-chat-completions':'anthropic-messages'))return fail('THREADED_RELEASE_PROTOCOL_UNSUPPORTED');
    return {definition,connection};
  }
  function members(){for(const m of raw.members)metadata(m);return raw.members.map(m=>({...m}));}
  function directory(base:string,scope:{ownerId:string;threadId:string;agentId:string}){
    for(const id of [scope.ownerId,scope.threadId,scope.agentId])if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))fail('THREADED_RELEASE_DIRECTORY_INVALID');
    mkdirSync(base,{recursive:true,mode:0o700});const root=realpathSync(base),target=path.join(root,scope.ownerId,scope.threadId,scope.agentId);
    mkdirSync(target,{recursive:true,mode:0o700});const canonical=realpathSync(target);if(canonical!==target)fail('THREADED_RELEASE_DIRECTORY_INVALID');return canonical;
  }
  function resolveAgent(scope:{ownerId:string;threadId:string;agentId:string}):ThreadedBackendAgentConfiguration{
    const m=selected(scope.agentId),{definition,connection}=metadata(m);let credential:string;
    try{credential=options.readCredential(m.accountId!,m.accountCredentialVersion!);if(typeof credential!=='string'||!credential)throw new Error('Unavailable credential');}
    catch{unavailableCredentials.add(m.agentId);return fail('THREADED_RELEASE_CREDENTIAL_UNAVAILABLE');}
    const protocol=m.model.startsWith('openai:')?'openai-chat-completions':'anthropic-messages',price=raw.prices?.[m.agentId];
    return {kind:m.backend,backendVersion:m.backendVersion,model:m.model,instructions:definition.systemPrompt!,
      workspace:directory(options.workspaceRoot,scope),configDir:directory(options.privateRoot,scope),informationBoundary:'threaded-home-release-v1',
      applicationTools:raw.applicationTools.filter(n=>definition.tools!.includes(n)),maxRequests:raw.maxRequests,
      contextBudget:{maxInputTokens:raw.maxInputTokens,reservedSystemTokens:Math.max(4096,Buffer.byteLength(definition.systemPrompt!)+4096)},
      quote:{maxOutputTokens:raw.maxOutputTokens,...(price?{estimatedCostMicrousd:Math.ceil((raw.maxInputTokens*price.inputPerMillion+raw.maxOutputTokens*price.outputPerMillion)),pricingReference:'operator-release-pinned-price'}:{})},
      ...(price?{price}:{}),apiProtocol:protocol,
      connection:{baseUrl:connection.baseUrl,timeoutMs:Math.min(connection.timeoutMs,180000),headers:protocol==='anthropic-messages'?anthropicAuthHeaders(credential,connection):{authorization:`Bearer ${credential}`}}};
  }
  return {members,resolveAgent,validateAgent(agentId:string){metadata(selected(agentId));},registered:raw.members.map(m=>({...m}))};
}
