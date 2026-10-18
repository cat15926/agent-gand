import type { ScopedSourceRef, RuntimeEvidenceRef } from '@agent-gand/shared';
import { all, get, tx } from '../db/database.ts';
import { createManagedArtifact, getManagedArtifact, managedPath } from '../artifacts/store.ts';
import { assertScopedTool, compileScopedSource, exposeScopedInput, scopedToolPolicy, type ScopedAttemptBinding } from './scopedCollaboration.ts';
import { expectObject, expectString, type Tool } from '../tools/types.ts';

export const SCOPED_FILE_TOOLS = ['fs.read','fs.write','search.files'];
const reject=():never=>{throw new Error('SCOPED_TOOL_REJECTED');};

/** Only selected immutable artifacts and this Attempt's own writes. Never scan a room or disk. */
function readable(binding:ScopedAttemptBinding) {
  const policy=scopedToolPolicy(binding);
  const refs=new Map<string,ScopedSourceRef>(policy.sources.filter(r=>r.kind==='artifact').map(r=>[r.id,r]));
  for(const row of all<{id:string}>("SELECT id FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,'$.attemptId')=? AND json_extract(record,'$.createdBy')=?",binding.runId,binding.attemptId,binding.agentId))refs.set(row.id,compileScopedSource(binding.runId,'artifact',row.id));
  const latest=new Map<string,{ref:ScopedSourceRef;version:number}>();
  for(const ref of refs.values()) {
    const file=getManagedArtifact(ref.id,binding.agentId,policy.access),prior=latest.get(file.path);
    if(!prior||prior.version<file.version)latest.set(file.path,{ref,version:file.version});
  }
  return latest;
}
export function scopedFileTool(name:string):Tool|undefined {
  if(!SCOPED_FILE_TOOLS.includes(name))return undefined;
  const properties=name==='search.files'?{pattern:{type:'string',minLength:1,maxLength:200},maxResults:{type:'integer',minimum:1,maximum:50}}
    :{path:{type:'string',minLength:1,maxLength:240},...(name==='fs.write'?{content:{type:'string',maxLength:256*1024}}:{})};
  return {name,description:name==='fs.read'?'读取当前 Scope 明确选定的受控文件或本次执行写入的版本。'
    :name==='fs.write'?'在受控产物库写入本 Scope 的文件版本；不写磁盘，不改变旧版本权限。':'仅搜索当前 Scope 选定文件与本次执行写入的版本。',
    inputSchema:{type:'object',additionalProperties:false,properties,required:name==='search.files'?['pattern']:name==='fs.write'?['path','content']:['path']},
    replayPolicy:name==='fs.write'?'manual':'safe',run:async()=>reject()};
}
export async function runScopedFileTool(binding:ScopedAttemptBinding,name:string,value:unknown):Promise<string> {
  return tx(()=>{
    assertScopedTool(binding,name);if(!SCOPED_FILE_TOOLS.includes(name))return reject();
    const input=expectObject(value),policy=scopedToolPolicy(binding);
    const keys=name==='fs.write'?['path','content']:name==='fs.read'?['path']:['pattern','maxResults'];
    if(Object.keys(input).some(key=>!keys.includes(key)))return reject();
    if(name==='fs.write') {
      const path=managedPath(expectString(input,'path'));if(typeof input.content!=='string')return reject();
      const file=createManagedArtifact({runId:binding.runId,path,content:Buffer.from(input.content),access:policy.access,createdBy:binding.agentId,attemptId:binding.attemptId});
      assertScopedTool(binding,name);
      return `已保存受控文件 ${file.path} · v${file.version} · ${file.size} 字节`;
    }
    const files=readable(binding);
    if(name==='fs.read') {
      const file=files.get(managedPath(expectString(input,'path')));if(!file)return reject();
      const body=exposeScopedInput(binding,file.ref,'file_read',name).toString('utf8').slice(0,10000);
      if(!get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_extract(payload,'$.features.autonomousCollaboration.rolloutVersion')=1",binding.runId))return body;
      const artifact=getManagedArtifact(file.ref.id,binding.agentId,policy.access);
      return `【受控文件快照 ${JSON.stringify({path:artifact.path,version:artifact.version,artifactId:artifact.id,sha256:artifact.sha256})}】\n${body}\n【文件快照结束】`;
    }
    const pattern=expectString(input,'pattern').toLowerCase();if(pattern.length>200||input.maxResults!==undefined&&(!Number.isInteger(input.maxResults)||Number(input.maxResults)<1||Number(input.maxResults)>50))return reject();
    const limit=typeof input.maxResults==='number'?input.maxResults:50,results:string[]=[];
    for(const [path,{ref}] of files) {
      const body=exposeScopedInput(binding,ref,'file_read',name).toString('utf8');
      for(const [index,line] of body.split('\n').entries())if(results.length<limit&&line.toLowerCase().includes(pattern))results.push(`${path}:${index+1}: ${line.trim().slice(0,160)}`);
    }
    return results.join('\n')||'未找到匹配项';
  });
}

/** Declared artifacts must belong to the producing Attempt, never a sibling's same-name file. */
export function scopedStepArtifactEvidence(runId:string,attemptId:string,paths:string[]):RuntimeEvidenceRef[] {
  return paths.map(path=>{
    const row=get<{id:string}>("SELECT id FROM managed_artifact_versions WHERE run_id=? AND path=? AND json_extract(record,'$.attemptId')=? ORDER BY version DESC LIMIT 1",runId,path,attemptId);
    if(!row)throw new Error('SCOPED_ARTIFACT_REQUIRED');
    const file=getManagedArtifact(row.id);if(file.size<64)throw new Error('SCOPED_ARTIFACT_REQUIRED');
    return {kind:'workspace_file',path:file.path,sha256:file.sha256,artifactId:file.id,artifactVersion:file.version};
  });
}
