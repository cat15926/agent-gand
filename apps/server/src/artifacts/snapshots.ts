import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSnapshot, SnapshotFile, SnapshotPreview, SnapshotRestorePreview } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { config } from '../config.ts';
import { getRun } from '../runs/trace.ts';
import { getBusinessState } from '../orchestration/business.ts';
import { checkpointOutput } from '../orchestration/businessCheckpointStore.ts';
import { businessQuiescent, businessProcessesQuiescent } from '../orchestration/businessGates.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { runSourceAccess } from '../messaging/access.ts';
import { openManagedContent, sealManagedContent } from '../accounts/credentials.ts';
import { getManagedArtifact, listManagedArtifacts, readManagedArtifact, createManagedArtifact, type ManagedArtifact } from './store.ts';
import { evidenceAccess, resolveEvidence } from '../runtime/evidence.ts';
import { workspaceRootDir } from '../tools/builtin/index.ts';
import { captureSnapshotGit, restoreSnapshotGit, snapshotGit } from './snapshotGit.ts';
import { readSnapshotFile, safeDirectory, safeTarget, snapshotFail, snapshotHash, snapshotPath, SNAPSHOT_LIMITS, statIfPresent, writeSnapshotFile } from './snapshotFiles.ts';

interface Payload { files: Record<string,string>; texts:Record<string,string>; managed: Record<string,ManagedArtifact>; pack?: string }
export interface SnapshotPackage { manifest: ArtifactSnapshot; payload: Payload }
interface SnapshotRow { id: string; run_id: string; manifest: string; digest: string; payload: string }
export const snapshotDigest = (snapshot: ArtifactSnapshot): string => snapshotHash(JSON.stringify(snapshot));
const keyFor = (file: SnapshotFile) => file.storage === 'managed' ? file.artifactId! : file.path;

/** Owner audit read; agent APIs never return a snapshot manifest or its private metadata. */
export function readArtifactSnapshot(id: string): SnapshotPackage {
  const row = get<SnapshotRow>('SELECT * FROM artifact_snapshots WHERE id=?',id);
  if (!row || snapshotHash(row.manifest) !== row.digest) snapshotFail('SNAPSHOT_CORRUPT','快照缺失或清单校验失败');
  const manifest = JSON.parse(row!.manifest) as ArtifactSnapshot;
  if (manifest.version !== 1 || manifest.id !== row!.id || manifest.runId !== row!.run_id || !manifest.complete)
    snapshotFail('SNAPSHOT_VERSION_UNSUPPORTED','快照版本、来源或完整性无效');
  const bytes = openManagedContent(row!.payload,'snapshot-v1:'+row!.manifest);
  if (snapshotHash(bytes) !== manifest.payloadSha256) snapshotFail('SNAPSHOT_CORRUPT','快照载荷哈希无效');
  const result = {manifest,payload:JSON.parse(bytes.toString()) as Payload}; validatePackage(result); return result;
}
function validatePackage(item: SnapshotPackage): void {
  const {manifest,payload} = item;
  if (manifest.version !== 1 || snapshotHash(JSON.stringify(payload)) !== manifest.payloadSha256
    || manifest.files.length > SNAPSHOT_LIMITS.maxFiles || Buffer.byteLength(JSON.stringify(payload)) > SNAPSHOT_LIMITS.totalBytes * 2)
    snapshotFail('SNAPSHOT_CORRUPT','快照载荷、版本或大小无效');
  const seen = new Set<string>();
  for(const text of manifest.texts) {
    const bytes=Buffer.from(payload.texts[text.stageId+':'+text.deliverableId]??'','base64');
    if(bytes.length!==text.size||snapshotHash(bytes)!==text.sha256||text.size>SNAPSHOT_LIMITS.fileBytes) snapshotFail('SNAPSHOT_CORRUPT','声明文本产物缺失或哈希不匹配');
    const current=evidenceAccess(text.ref,text.sourceRunId);
    if(current.visibility!==text.visibility||JSON.stringify(current.audience)!==JSON.stringify(text.audience)) snapshotFail('SNAPSHOT_ACL_DRIFTED','文本产物的来源权限发生变化');
  }
  for (const file of manifest.files) {
    snapshotPath(file.path); const key = keyFor(file);
    if (seen.has(file.storage+':'+key)) snapshotFail('SNAPSHOT_CORRUPT','快照包含重复文件'); seen.add(file.storage+':'+key);
    if (![0o600,0o700].includes(file.mode) || file.size > SNAPSHOT_LIMITS.fileBytes)
      snapshotFail('SNAPSHOT_CORRUPT','快照文件权限或大小无效');
    if (file.storage === 'workspace' && file.visibility !== 'public') snapshotFail('SNAPSHOT_PRIVATE_WORKSPACE','私密物理文件不能进入原生恢复目录');
    if (file.change === 'deleted') { if (file.sha256 !== null || file.size !== 0 || file.storage !== 'workspace' || !manifest.git?.files.some(f=>f.path===file.path)) snapshotFail('SNAPSHOT_CORRUPT','删除记录没有 Git 基线'); continue; }
    const bytes = Buffer.from(payload.files[key] ?? '', 'base64');
    if (!(key in payload.files) || bytes.length !== file.size || snapshotHash(bytes) !== file.sha256)
      snapshotFail('SNAPSHOT_CORRUPT','快照文件缺失或哈希不匹配');
    if (file.storage === 'managed') {
      const saved = payload.managed[file.artifactId!]; const current = getManagedArtifact(file.artifactId!);
      if (!saved || JSON.stringify(saved) !== JSON.stringify(current) || current.sha256 !== file.sha256
        || current.version !== file.artifactVersion || current.path !== file.path || current.runId !== file.sourceRunId
        || current.visibility !== file.visibility || JSON.stringify(current.audience) !== JSON.stringify(file.audience))
        snapshotFail('SNAPSHOT_ACL_DRIFTED','受控文件来源、权限或版本发生变化');
    }
  }
  if (manifest.git && (!payload.pack || snapshotHash(Buffer.from(payload.pack,'base64')) !== manifest.git.packSha256))
    snapshotFail('SNAPSHOT_CORRUPT','Git 基线包缺失或损坏');
}
export function listArtifactSnapshots(runId: string): Array<{snapshot:ArtifactSnapshot;digest:string;retained:boolean}> {
  return all<{id:string}>('SELECT id FROM artifact_snapshots WHERE run_id=? ORDER BY created_at DESC,rowid DESC',runId).map(row=> {
    const {manifest} = readArtifactSnapshot(row.id);
    return {snapshot:manifest,digest:snapshotDigest(manifest),retained:Boolean(get('SELECT 1 FROM artifact_snapshot_refs WHERE snapshot_id=? LIMIT 1',row.id)||get('SELECT 1 FROM artifact_snapshot_restores WHERE snapshot_id=? LIMIT 1',row.id))};
  });
}
export function saveArtifactSnapshot(item: SnapshotPackage, ownerType?: 'acceptance' | 'checkpoint', ownerId?: string): void {
  validatePackage(item);
  if (!item.manifest.complete) snapshotFail('SNAPSHOT_INCOMPLETE','声明交付缺失，不能保存完整快照');
  const record = JSON.stringify(item.manifest), digest = snapshotDigest(item.manifest);
  const existing = get<{digest:string}>('SELECT digest FROM artifact_snapshots WHERE id=?',item.manifest.id);
  if (existing && existing.digest !== digest) snapshotFail('SNAPSHOT_CORRUPT','已有快照摘要不匹配');
  if (!existing) run('INSERT INTO artifact_snapshots(id,run_id,manifest,digest,payload,created_at) VALUES(?,?,?,?,?,?)',
    item.manifest.id,item.manifest.runId,record,digest,sealManagedContent(Buffer.from(JSON.stringify(item.payload)),'snapshot-v1:'+record),new Date().toISOString());
  if (ownerType && ownerId) run('INSERT OR IGNORE INTO artifact_snapshot_refs(snapshot_id,owner_type,owner_id,created_at) VALUES(?,?,?,?)',item.manifest.id,ownerType,ownerId,new Date().toISOString());
}

/** Bounded model-free compilation. Completeness applies to the explicitly listed stages and paths. */
export function buildArtifactSnapshot(runId: string, input: {paths?:string[];stageIds?:string[];checkpoint?:boolean;recovery?:boolean;managedIds?:string[]} = {}): SnapshotPackage {
  const source = getRun(runId); if (!source) snapshotFail('RUN_NOT_FOUND','任务不存在');
  if(!['completed','failed','cancelled'].includes(source!.status) && !(source!.status==='waiting_for_user'&&getRunCoordinationPlan(runId)?.status==='paused'))
    snapshotFail('SNAPSHOT_NOT_QUIESCENT','请先等待执行终态或阶段暂停边界，再保存产物快照');
  if (!(input.recovery ? businessProcessesQuiescent(runId) : businessQuiescent(runId))) snapshotFail('SNAPSHOT_NOT_QUIESCENT','执行、工具或原生进程尚未收敛，不能归档');
  if (input.paths && (!Array.isArray(input.paths) || input.paths.length > 128 || input.paths.some(p=>typeof p!=='string'))
    || input.stageIds && (!Array.isArray(input.stageIds) || input.stageIds.length > 32 || input.stageIds.some(p=>typeof p!=='string')))
    snapshotFail('SNAPSHOT_INPUT_INVALID','快照声明格式或数量无效');
  const state = getBusinessState(runId), access = runSourceAccess(runId);
  const stageIds = [...new Set(input.stageIds ?? state.stages.filter(s=>s.report?.kind==='delivery').map(s=>s.stage.id))].sort();
  if (stageIds.some(id=>!state.stages.some(s=>s.stage.id===id))) snapshotFail('SNAPSHOT_STAGE_INVALID','快照阶段不属于冻结验收清单');
  if(input.checkpoint && stageIds.some(id=>state.stages.find(s=>s.stage.id===id)?.status!=='accepted')) snapshotFail('SNAPSHOT_STAGE_INVALID','检查点只继承已验收阶段声明');
  const scope = getRunCoordinationPlan(runId)?.id.slice(0,8);
  const rootPath = workspaceRootDir({runId,workspace:source!.workspace,workspaceScope:scope});
  const rootExists = Boolean(statIfPresent(rootPath));
  if(rootExists && lstatSync(rootPath).isSymbolicLink()) snapshotFail('SNAPSHOT_PATH_UNSAFE','工作区根包含链接');
  const root = rootExists ? realpathSync(rootPath) : rootPath;
  if(rootExists) safeDirectory(root);
  if(rootExists && !source!.workspace?.startsWith('ext:')) {
    const base=realpathSync(config.sandboxDir), expected=source!.workspace?path.join(base,'workspaces',source!.workspace):path.join(base,'runs',runId);
    if(root!==expected) snapshotFail('SNAPSHOT_PATH_UNSAFE','内部工作区父目录包含链接或路径漂移');
  }
  if(rootExists && source!.workspace?.startsWith('ext:') && root!==rootPath) snapshotFail('SNAPSHOT_PATH_UNSAFE','外部工作区路径或父目录链接已变化');
  const old = all<{id:string}>('SELECT id FROM artifact_snapshots WHERE run_id=? ORDER BY rowid DESC',runId).map(r=>readArtifactSnapshot(r.id));
  if(state.checkpoint?.archive) old.push(readArtifactSnapshot(state.checkpoint.archive.id));
  const acceptanceVersion=(stageId:string,reportId:string):number|null => get<{version:number}>("SELECT version FROM business_acceptance_events WHERE run_id=? AND json_extract(payload,'$.decision.reportId')=? AND json_extract(payload,'$.decision.verdict')='accept'",runId,reportId)?.version
    ?? old.flatMap(s=>[...s.manifest.files,...s.manifest.texts]).find(f=>f.stageId===stageId&&f.acceptanceVersion!==null)?.acceptanceVersion ?? null;
  const baseline = access.visibility==='public' && rootExists ? captureSnapshotGit(root)
    : !rootExists && access.visibility==='public' && old.find(s=>s.manifest.git) ? {git:old.find(s=>s.manifest.git)!.manifest.git,pack:old.find(s=>s.manifest.git)!.payload.pack} : {git:null};
  const payload:Payload = {files:{},texts:{},managed:{},...(baseline.pack ? {pack:baseline.pack}:{})};
  const texts:ArtifactSnapshot['texts']=[],files:SnapshotFile[] = [], declarations:ArtifactSnapshot['declarations'] = [], omissions:ArtifactSnapshot['omissions'] = [];
  const managedIds = new Set<string>(); const physical = new Map<string,{stageId:string|null;deliverableId:string|null;sha256?:string;acceptanceVersion:number|null}>();
  for(const id of input.managedIds??[]) managedIds.add(id);
  for (const stageId of stageIds) {
    const stage = state.stages.find(s=>s.stage.id===stageId)!;
    for (const required of stage.stage.deliverables) {
      const evidence = stage.report?.kind === 'delivery' ? stage.report.evidence.find(e=>e.deliverableId===required.id)?.resolution : undefined;
      let present = Boolean(evidence?.trusted && evidence.contentSha256);
      if (evidence && required.kind==='text') present = resolveEvidence(runId,evidence.ref).contentSha256 === evidence.contentSha256;
      if(present && evidence && required.kind==='text') {
        const ref=evidence.ref;
        const row=ref.kind==='message'?get<{run_id:string;body:string}>('SELECT run_id,body FROM messages WHERE id=?',ref.id):ref.kind==='attempt_output'?
          get<{run_id:string;body:string}>('SELECT run_id,output body FROM collaboration_attempts WHERE id=?',ref.id)
          ??get<{run_id:string;body:string}>('SELECT run_id,output body FROM coordination_step_attempts WHERE id=?',ref.id)
          ??get<{run_id:string;body:string}>('SELECT run_id,output body FROM task_attempts WHERE id=?',ref.id):undefined;
        const inherited=old.flatMap(s=>s.manifest.texts.map(t=>({text:t,snapshot:s}))).find(t=>t.text.stageId===stageId&&t.text.deliverableId===required.id&&t.text.sha256===evidence.contentSha256);
        const confirmed=ref.kind==='attempt_output'?checkpointOutput(runId,ref.id):undefined;
        const bytes=confirmed?Buffer.from(confirmed.output):row?.body!=null?Buffer.from(row.body):inherited?Buffer.from(inherited.snapshot.payload.texts[stageId+':'+required.id]!,'base64'):null;
        if(!bytes||snapshotHash(bytes)!==evidence.contentSha256) present=false;
        else {
          const policy=evidenceAccess(ref,confirmed?.sourceRunId??row?.run_id??inherited!.text.sourceRunId);
          texts.push({stageId,deliverableId:required.id,sourceRunId:confirmed?.sourceRunId??row?.run_id??inherited!.text.sourceRunId,
            acceptanceVersion:stage.status==='accepted'?acceptanceVersion(stageId,stage.report!.id):null,mimeType:'text/plain',
            ref,sha256:evidence.contentSha256!,size:bytes.length,...policy});
          payload.texts[stageId+':'+required.id]=bytes.toString('base64');
        }
      }
      declarations.push({stageId,deliverableId:required.id,title:required.title,kind:required.kind,present,sha256:evidence?.contentSha256??null});
      if (!evidence || evidence.ref.kind!=='workspace_file') continue;
      if (evidence.ref.artifactId) { managedIds.add(evidence.ref.artifactId); continue; }
      snapshotPath(evidence.ref.path);
      const prior = physical.get(evidence.ref.path);
      if (prior?.sha256 && prior.sha256!==evidence.ref.sha256) snapshotFail('SNAPSHOT_FILE_CONFLICT','不同交付版本使用同一路径，请分别保存阶段快照');
      physical.set(evidence.ref.path,{stageId,deliverableId:required.id,sha256:evidence.ref.sha256,acceptanceVersion:stage.status==='accepted'?acceptanceVersion(stageId,stage.report!.id):null});
    }
  }
  // Owner archives retain all own versions. Checkpoints admit exact accepted declarations and user inputs only.
  for (const artifact of listManagedArtifacts(source!.conversationId).filter(a=>a.runId===runId)) {
    if(input.managedIds ? managedIds.has(artifact.id) : !input.checkpoint || managedIds.has(artifact.id) || artifact.createdBy==='user'&&!artifact.stageId&&!artifact.attemptId) managedIds.add(artifact.id);
    else if(!managedIds.has(artifact.id)) omissions.push({path:artifact.path+' v'+artifact.version,reason:'尚未验收或被拒绝的受控产物版本不进入续跑输入'});
  }
  for (const id of [...managedIds].sort()) {
    const artifact = getManagedArtifact(id), bytes = readManagedArtifact(id);
    const declaration = declarations.find(d=>d.kind==='file' && state.stages.find(s=>s.stage.id===d.stageId)?.report?.evidence.some(e=>e.deliverableId===d.deliverableId && e.resolution.ref.kind==='workspace_file' && e.resolution.ref.artifactId===id));
    if(declaration && declaration.sha256!==artifact.sha256) declaration.present=false;
    const stage=declaration?state.stages.find(s=>s.stage.id===declaration.stageId):undefined;
    files.push({path:artifact.path,sourceRunId:artifact.runId,stageId:declaration?.stageId??artifact.stageId,deliverableId:declaration?.deliverableId??null,
      acceptanceVersion:stage?.status==='accepted'?acceptanceVersion(stage.stage.id,stage.report!.id):null,
      sha256:artifact.sha256,size:artifact.size,mimeType:artifact.mimeType,mode:0o600,change:'unchanged',storage:'managed',
      visibility:artifact.visibility,audience:artifact.audience,artifactId:id,artifactVersion:artifact.version});
    payload.files[id] = bytes.toString('base64'); payload.managed[id] = artifact;
  }
  for (const rel of [...new Set(input.paths??[])].sort()) { snapshotPath(rel); if (!physical.has(rel)) physical.set(rel,{stageId:null,deliverableId:null,acceptanceVersion:null}); }
  if (access.visibility==='private' && physical.size) snapshotFail('SNAPSHOT_PRIVATE_WORKSPACE','私密事项请使用受控文件，物理文件不能进入共享原生工作树');
  for (const [rel,owner] of [...physical.entries()].sort(([a],[b])=>a.localeCompare(b))) {
    if (listManagedArtifacts(source!.conversationId).some(a=>a.path===rel)) snapshotFail('SNAPSHOT_MANAGED_ALIAS','受控文件不能通过物理同名路径归档');
    let content = rootExists ? readSnapshotFile(root,rel) : null;
    const archived = old.flatMap(s=>s.manifest.files.filter(f=>f.storage==='workspace'&&f.path===rel&&f.sha256===owner.sha256).map(f=>({file:f,snapshot:s}))).at(0);
    if (!content && owner.sha256 && archived) content={bytes:Buffer.from(archived.snapshot.payload.files[rel]!,'base64'),mode:archived.file.mode,sourceMode:archived.file.sourceMode??archived.file.mode};
    const base = baseline.git?.files.find(f=>f.path===rel);
    if (!content && owner.sha256) snapshotFail('SNAPSHOT_DECLARED_FILE_MISSING','声明交付文件缺失，且没有可验证归档');
    if (!content && !base) snapshotFail('SNAPSHOT_DECLARED_FILE_MISSING','声明路径不存在，也没有 Git 基线可证明删除');
    const hash = content ? snapshotHash(content.bytes) : null;
    if (owner.sha256 && hash!==owner.sha256) snapshotFail('DELIVERY_CHANGED','已登记或验收文件内容发生变化，请核对交付版本');
    files.push({path:rel,sourceRunId:archived?.file.sourceRunId??runId,...owner,sha256:hash,size:content?.bytes.length??0,mimeType:content?.bytes.includes(0)?'application/octet-stream':'text/plain',
      mode:content?.mode??base!.mode,...(content?{sourceMode:content.sourceMode}:{}),change:!content?'deleted':!base?'added':base.sha256===hash&&base.mode===content.mode?'unchanged':'modified',
      storage:'workspace',visibility:'public',audience:[],...(scope?{workspaceScope:scope}:{})});
    if (content) payload.files[rel]=content.bytes.toString('base64');
  }
  if (baseline.git) for (const base of baseline.git.files) {
    if (listManagedArtifacts(source!.conversationId).some(a=>a.path===base.path)) snapshotFail('SNAPSHOT_MANAGED_ALIAS','Git 基线与受控文件路径冲突，不能复制权限不同的同名文件');
    if (!physical.has(base.path) && rootExists) {
      try { const current=readSnapshotFile(root,base.path); if (!current || snapshotHash(current.bytes)!==base.sha256 || current.mode!==base.mode) omissions.push({path:base.path,reason:'未声明的工作树改动；恢复使用 Git 基线版本'}); }
      catch { omissions.push({path:base.path,reason:'未声明或不支持的工作树条目；恢复使用 Git 基线版本'}); }
    }
  }
  if (rootExists && access.visibility==='public') {
    let visited=0;
    const walk = (dir:string,prefix='') => { for (const name of readdirSync(dir).sort()) {
      if (++visited>SNAPSHOT_LIMITS.maxFiles) { omissions.push({path:prefix||'.',reason:'目录扫描达到 4000 条限制，余项未包含'}); return; }
      const rel=prefix+name; if (name==='.git') continue;
      try { snapshotPath(rel); } catch { omissions.push({path:rel,reason:'凭据、登录/依赖目录或保留路径已排除'}); continue; }
      const stat=lstatSync(path.join(dir,name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path.join(dir,name),rel+'/');
      else if (!physical.has(rel) && !baseline.git?.files.some(f=>f.path===rel)) omissions.push({path:rel,reason:'未声明文件或不支持的类型，未包含'});
    } }; walk(root);
  }
  for (const stage of state.stages.filter(s=>!stageIds.includes(s.stage.id))) omissions.push({path:'阶段 '+stage.stage.title,reason:'本次快照未声明该阶段，不代表整轮目标已完整交付'});
  if (access.visibility==='private') omissions.push({path:'物理工作区',reason:'私密文件保留为加密受控版本，不复制到原生工作目录'});
  if (Buffer.byteLength(JSON.stringify(payload)) > SNAPSHOT_LIMITS.totalBytes || files.length > SNAPSHOT_LIMITS.maxFiles)
    snapshotFail('SNAPSHOT_TOO_LARGE','快照载荷超过 16 MiB 或 4000 文件限制');
  const record = {version:1 as const,runId,sourceVersion:state.version,sourceCreatedAt:source!.createdAt,stageIds,complete:declarations.every(d=>d.present),
    declarations,files,texts,git:baseline.git,omissions,limits:SNAPSHOT_LIMITS,payloadSha256:snapshotHash(JSON.stringify(payload))};
  const manifest:ArtifactSnapshot = {...record,id:snapshotHash(JSON.stringify(record))};
  return {manifest,payload};
}
export function previewArtifactSnapshot(runId:string,input:{paths?:string[];stageIds?:string[]}={}):SnapshotPreview {
  const {manifest}=buildArtifactSnapshot(runId,input);
  return {snapshot:manifest,fingerprint:snapshotDigest(manifest),blocked:manifest.declarations.filter(d=>!d.present).map(d=>'缺少声明交付：'+d.title)};
}
export function confirmArtifactSnapshot(runId:string,input:{paths?:string[];stageIds?:string[];fingerprint:string}):ArtifactSnapshot {
  return tx(()=>{ const item=buildArtifactSnapshot(runId,input); if(snapshotDigest(item.manifest)!==input.fingerprint) snapshotFail('SNAPSHOT_STALE','产物、权限或验收版本已变化，请重新预览'); saveArtifactSnapshot(item); return item.manifest; });
}
export function previewArtifactRestore(id:string):SnapshotRestorePreview {
  const {manifest}=readArtifactSnapshot(id); const digest=snapshotDigest(manifest);
  return {snapshot:manifest,digest,fingerprint:snapshotHash('restore-v1:'+id+':'+digest),encryptedFiles:manifest.files.filter(f=>f.storage==='managed').length,
    physicalFiles:manifest.files.filter(f=>f.storage==='workspace'&&f.change!=='deleted').length};
}
export function readSnapshotContent(id:string,kind:'file'|'text',index:number):{name:string;contentBase64:string;sha256:string} {
  const item=readArtifactSnapshot(id);
  if(!Number.isSafeInteger(index)||index<0) snapshotFail('SNAPSHOT_INPUT_INVALID','产物序号无效');
  if(kind==='text') {
    const text=item.manifest.texts[index]; if(!text) snapshotFail('SNAPSHOT_INPUT_INVALID','文本产物不存在');
    return {name:text!.stageId+'-'+text!.deliverableId+'.txt',contentBase64:item.payload.texts[text!.stageId+':'+text!.deliverableId]!,sha256:text!.sha256};
  }
  const file=item.manifest.files[index]; if(!file||file.change==='deleted') snapshotFail('SNAPSHOT_INPUT_INVALID','文件产物不存在或为删除记录');
  return {name:file!.path.split('/').at(-1)!,contentBase64:item.payload.files[keyFor(file!)]!,sha256:file!.sha256!};
}
function assertRestored(item:SnapshotPackage,root:string):void {
  safeDirectory(root);
  if(item.manifest.git) {
    safeDirectory(path.join(root,'.git'));
    if(snapshotGit(root,['rev-parse','HEAD']).toString().trim()!==item.manifest.git.commit) snapshotFail('SNAPSHOT_BASELINE_DRIFTED','恢复目录的 Git 基线已变化');
  }
  const expected=new Map(item.manifest.git?.files.map(f=>[f.path,{sha256:f.sha256,mode:f.mode}])??[]);
  for(const f of item.manifest.files.filter(f=>f.storage==='workspace')) { if(f.change==='deleted') expected.delete(f.path); else expected.set(f.path,{sha256:f.sha256!,mode:f.mode}); }
  for(const [rel,file] of expected) {
    let actual:ReturnType<typeof readSnapshotFile>;
    try { actual=readSnapshotFile(root,rel); } catch { snapshotFail('CHECKPOINT_FILE_CHANGED','恢复目录文件已被链接替换或类型改变，禁止覆盖'); }
    if(!actual!||snapshotHash(actual!.bytes)!==file.sha256||actual!.mode!==file.mode||actual!.sourceMode!==file.mode) snapshotFail('CHECKPOINT_FILE_CHANGED','恢复目录文件或权限已变化，禁止覆盖或继续');
  }
  for(const file of item.manifest.files.filter(f=>f.storage==='workspace'&&f.change==='deleted')) if(statIfPresent(safeTarget(root,file.path))) snapshotFail('CHECKPOINT_FILE_CHANGED','恢复目录中已删除文件重新出现');
}
/** Fresh directory only. No source repository registry or user checkout is ever written. */
export function materializeArtifactSnapshot(id:string,root:string):void {
  const item=readArtifactSnapshot(id);
  const sandbox=realpathSync(config.sandboxDir), relative=path.relative(sandbox,root).split(path.sep);
  if(relative.length!==2||!['runs','restored-artifacts'].includes(relative[0]!)||!/^[-a-zA-Z0-9_]{1,100}$/.test(relative[1]!)) snapshotFail('SNAPSHOT_TARGET_CONFLICT','恢复只能创建平台新隔离目录');
  const binding=get<{snapshot_id:string;digest:string;path:string}>('SELECT * FROM artifact_snapshot_restores WHERE owner_id=?',root);
  if(binding) { if(binding.snapshot_id!==id||binding.digest!==snapshotDigest(item.manifest)||binding.path!==root) snapshotFail('SNAPSHOT_TARGET_CONFLICT','恢复目标绑定不一致'); assertRestored(item,root); return; }
  if(statIfPresent(root)) { safeDirectory(root); if(readdirSync(root).length) snapshotFail('SNAPSHOT_TARGET_CONFLICT','恢复目标不是空目录，禁止覆盖'); }
  const parent=path.dirname(root); mkdirSync(parent,{recursive:true,mode:0o700}); safeDirectory(parent);
  const temporary=path.join(parent,'.restore-'+randomUUID()); mkdirSync(temporary,{mode:0o700});
  try {
    if(item.manifest.git) restoreSnapshotGit(temporary,item.manifest.git,item.payload.pack!);
    for(const file of item.manifest.files.filter(f=>f.storage==='workspace')) {
      const target=safeTarget(temporary,file.path,true);
      if(statIfPresent(target)) unlinkSync(target); // Only our fresh temporary baseline, never an existing user checkout.
      if(file.change!=='deleted') writeSnapshotFile(temporary,file.path,Buffer.from(item.payload.files[file.path]!,'base64'),file.mode);
    }
    assertRestored(item,temporary);
    if(statIfPresent(root)) { if(readdirSync(root).length) snapshotFail('SNAPSHOT_TARGET_CONFLICT','恢复目标已被修改'); rmSync(root); }
    renameSync(temporary,root);
    run('INSERT INTO artifact_snapshot_restores(owner_id,snapshot_id,digest,path,created_at) VALUES(?,?,?,?,?)',root,id,snapshotDigest(item.manifest),root,new Date().toISOString());
  } finally { if(statIfPresent(temporary)) rmSync(temporary,{recursive:true}); }
}
export function confirmArtifactRestore(id:string,input:{fingerprint:string;clientRequestId:string}) {
  const preview=previewArtifactRestore(id);
  if(preview.fingerprint!==input.fingerprint) snapshotFail('SNAPSHOT_STALE','快照或权限已变化，请重新预览恢复');
  if(typeof input.clientRequestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.clientRequestId)) snapshotFail('SNAPSHOT_INPUT_INVALID','恢复请求标识无效');
  mkdirSync(config.sandboxDir,{recursive:true}); safeDirectory(realpathSync(config.sandboxDir));
  const root=path.join(realpathSync(config.sandboxDir),'restored-artifacts',input.clientRequestId);
  materializeArtifactSnapshot(id,root);
  return {snapshotId:id,path:root,encryptedFiles:preview.encryptedFiles};
}
/** Continuation imports exact controlled versions transactionally, within the frozen recovery scope. */
export function importSnapshotArtifacts(runId:string,item:SnapshotPackage,scope?:import('@agent-gand/shared').MessageAccess):void {
  validatePackage(item);
  for(const file of item.manifest.files.filter(f=>f.storage==='managed').sort((a,b)=>(a.artifactVersion??0)-(b.artifactVersion??0))) {
    if(file.visibility!=='public' && (!scope || scope.visibility!=='private' || scope.audience.some(id=>id!=='user'&&!file.audience.includes(id)))) snapshotFail('PRIVATE_CHECKPOINT_UNSUPPORTED','当前任务范围不能承接受控文件授权');
    const source=item.payload.managed[file.artifactId!]!;
    createManagedArtifact({runId,path:file.path,content:Buffer.from(item.payload.files[file.artifactId!]!,'base64'),access:source,
      createdBy:'user',stageId:file.stageId??undefined,mimeType:file.mimeType,restoredFrom:{snapshotId:item.manifest.id,artifactId:source.id}});
  }
}
export function deleteArtifactSnapshot(id:string,expectedDigest:string):void {
  tx(()=>{ const item=readArtifactSnapshot(id); if(snapshotDigest(item.manifest)!==expectedDigest) snapshotFail('SNAPSHOT_STALE','快照摘要不一致');
    if(get('SELECT 1 FROM artifact_snapshot_refs WHERE snapshot_id=? LIMIT 1',id)||get('SELECT 1 FROM artifact_snapshot_restores WHERE snapshot_id=? LIMIT 1',id)) snapshotFail('SNAPSHOT_RETAINED','已验收、续跑引用或已恢复的快照必须保留');
    run('DELETE FROM artifact_snapshots WHERE id=?',id); });
}
