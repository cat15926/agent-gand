import {createHash}from'node:crypto';
import {lstat,readFile,writeFile,rename,rm}from'node:fs/promises';
import path from'node:path';
import {createRequire}from'node:module';
const Database=createRequire(new URL('../../apps/server/package.json',import.meta.url))('better-sqlite3');

export const authDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** OAuth refresh is mutable within one identity generation; never overwrite a user-changed source. */
export async function syncNativeRefresh({sourceDb,accountId,generation,sourcePath,copyPath,initialDigest}){
  const db=new Database(sourceDb,{readonly:true});let temporary;
  try{
    const current=db.prepare('SELECT a.identity_generation,a.enabled,a.archived,i.identity_hash,i.status,i.directory,i.client FROM accounts a JOIN account_native_identities i ON i.account_id=a.id AND i.generation=a.identity_generation WHERE a.id=?').get(accountId);
    if(!current||current.client!=='codex'||current.identity_generation!==generation||!current.enabled||current.archived||current.status!=='authenticated'||path.join(current.directory,'config/auth.json')!==sourcePath||db.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(accountId))return {status:'source_identity_changed'};
    for(const file of[sourcePath,copyPath]){const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid())||stat.size>1024*1024)return {status:'unsafe_credential_file'};}
    const original=await readFile(sourcePath),refreshed=await readFile(copyPath);if(authDigest(original)!==initialDigest)return {status:'source_file_changed'};if(authDigest(refreshed)===initialDigest)return {status:'unchanged'};
    let auth;try{auth=JSON.parse(refreshed.toString());}catch{return {status:'invalid_refreshed_credentials'};}const identity=auth.tokens?.account_id??auth.account_id;
    if(!identity||authDigest('codex:'+identity)!==current.identity_hash)return {status:'refreshed_identity_mismatch'};
    const access=auth.tokens?.access_token;if(typeof access!=='string')return {status:'refreshed_access_token_missing'};
    let expiry;try{expiry=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString()).exp;}catch{}
    if(typeof expiry==='number'&&expiry*1000<=Date.now())return {status:'refreshed_access_token_expired'};
    temporary=path.join(path.dirname(path.dirname(sourcePath)),'r8-refresh-'+process.pid);await writeFile(temporary,refreshed,{flag:'wx',mode:0o600});
    if(authDigest(await readFile(sourcePath))!==initialDigest)return {status:'source_file_changed'};
    await rename(temporary,sourcePath);temporary=null;return {status:'refreshed_source',accountId,generation};
  }finally{if(temporary)await rm(temporary,{force:true});db.close();}
}
