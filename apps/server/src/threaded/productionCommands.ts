import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type Database from 'better-sqlite3';
import type {createExecutionResourceCoordinator} from '../execution/resources/coordinator.ts';
import type {ActionCommandPort,ActionScope} from './actionTypes.ts';
import {ThreadedAuthorityError} from './contracts.ts';
import {createThreadedOsCommandPort} from './osCommands.ts';
import {createThreadedOsCommandResources} from './osCommandResources.ts';
import {digest} from './collaborationTypes.ts';

type Member={threadId:string;agentId:string;workspace:string;workspaceMode?:'isolated'|'shared_project'};
type Project={id:string;root:string;members:Member[];artifactRoot?:string};
type Entry={id:string;projectId:string;threadId:string;agentId:string;profile:'project_manifest_v1';cwd:string;readPaths:string[];writeRoot:string;settleDelayMs:number};
type Configuration={schemaVersion:1;version:number;ownerId:string;projects:Project[];commands:Entry[]};
type FilePin={path:string;dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number;sha256:string};
type DirectoryPin={path:string;dev:number;ino:number};
type State='registered'|'configuration_changed'|'path_changed'|'inputs_changed';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k));
const shape=(v:Record<string,unknown>,required:string[],optional:string[])=>required.every(k=>Object.hasOwn(v,k))
  &&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const within=(root:string,target:string)=>target===root||target.startsWith(root+path.sep);
function fail(code:string):never{throw new ThreadedAuthorityError(code);}
function fileSnapshot(filename:string,maxBytes=256*1024*1024):{pin:FilePin;bytes:Buffer}{
  if(realpathSync(filename)!==filename)fail('THREADED_COMMAND_PATH_CHANGED');
  const descriptor=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(descriptor);if(!before.isFile()||before.nlink!==1||before.size>maxBytes)fail('THREADED_COMMAND_FILE_INVALID');
    const bytes=readFileSync(descriptor),after=fstatSync(descriptor),live=lstatSync(filename);
    if(bytes.length>maxBytes||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs
      ||before.ctimeMs!==after.ctimeMs||live.dev!==after.dev||live.ino!==after.ino||realpathSync(filename)!==filename)
      fail('THREADED_COMMAND_PATH_CHANGED');
    return {pin:{path:filename,dev:after.dev,ino:after.ino,size:after.size,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs,sha256:sha(bytes)},bytes};
  }finally{closeSync(descriptor);}
}
function filePinCurrent(pin:FilePin):boolean{
  if(realpathSync(pin.path)!==pin.path)return false;
  const descriptor=openSync(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const current=fstatSync(descriptor),live=lstatSync(pin.path);
    // The initial SHA256 is part of authority. POSIX ctime changes on content,
    // metadata, replacement and hardlink changes, including restored mtimes.
    return current.isFile()&&current.nlink===1&&current.dev===pin.dev&&current.ino===pin.ino&&current.size===pin.size
      &&current.mtimeMs===pin.mtimeMs&&current.ctimeMs===pin.ctimeMs&&live.dev===current.dev&&live.ino===current.ino;
  }finally{closeSync(descriptor);}
}
function directoryPin(filename:string):DirectoryPin{
  if(!path.isAbsolute(filename)||path.normalize(filename)!==filename||realpathSync(filename)!==filename)fail('THREADED_COMMAND_PATH_INVALID');
  const stat=lstatSync(filename);if(!stat.isDirectory())fail('THREADED_COMMAND_PATH_INVALID');return {path:filename,dev:stat.dev,ino:stat.ino};
}
function parse(bytes:Buffer):unknown{
  const source=bytes.toString('utf8'),value:unknown=JSON.parse(source),stack:Array<{kind:'object'|'array';keys:Set<string>;expectKey:boolean}>=[];
  for(let i=0;i<source.length;i++){
    const c=source[i];if(c==='"'){
      const start=i;for(i++;i<source.length;i++){if(source[i]==='\\'){i++;continue;}if(source[i]==='"')break;}
      const current=stack.at(-1);if(current?.kind==='object'&&current.expectKey){const key=JSON.parse(source.slice(start,i+1)) as string;
        if(current.keys.has(key))fail('THREADED_COMMAND_CONFIGURATION_INVALID');current.keys.add(key);current.expectKey=false;}
    }else if(c==='{'||c==='[')stack.push({kind:c==='{'?'object':'array',keys:new Set(),expectKey:c==='{'});
    else if(c==='}'||c===']')stack.pop();else if(c===','&&stack.at(-1)?.kind==='object')stack.at(-1)!.expectKey=true;
  }return value;
}
function validate(value:unknown,ownerId:string):Configuration{
  if(!object(value)||!keys(value,['schemaVersion','version','ownerId','projects','commands'])||value.schemaVersion!==1||!integer(value.version)
    ||value.ownerId!==ownerId||!id(value.ownerId)||!Array.isArray(value.projects)||!value.projects.length||value.projects.length>20
    ||!Array.isArray(value.commands)||!value.commands.length||value.commands.length>32)fail('THREADED_COMMAND_CONFIGURATION_INVALID');
  const scopes=new Set<string>(),projects=new Set<string>(),commands=new Set<string>();
  for(const p of value.projects){
    if(!object(p)||!shape(p,['id','root','members'],['artifactRoot'])||!id(p.id)||projects.has(p.id)||typeof p.root!=='string'
      ||!Array.isArray(p.members)||!p.members.length||p.members.length>100)fail('THREADED_COMMAND_CONFIGURATION_INVALID');
    projects.add(p.id);directoryPin(p.root);
    for(const m of p.members){
      if(!object(m)||!shape(m,['threadId','agentId','workspace'],['workspaceMode'])||!id(m.threadId)||!id(m.agentId)||typeof m.workspace!=='string'
        ||m.workspaceMode!==undefined&&!['isolated','shared_project'].includes(String(m.workspaceMode)))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
      const shared=m.workspaceMode==='shared_project';
      if(shared?m.workspace!==p.root:m.workspace===p.root||!within(p.root,m.workspace))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
      directoryPin(m.workspace);const scope=`${m.threadId}:${m.agentId}`;
      if(scopes.has(scope))fail('THREADED_COMMAND_CONFIGURATION_INVALID');scopes.add(scope);
    }
    const shared=(p.members as Member[]).some(m=>m.workspaceMode==='shared_project');
    if(shared){
      if((p.members as Member[]).some(m=>m.workspaceMode!=='shared_project')||typeof p.artifactRoot!=='string'
        ||within(p.root,p.artifactRoot)||within(p.artifactRoot,p.root))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
      directoryPin(p.artifactRoot);
    }else if(p.artifactRoot!==undefined)fail('THREADED_COMMAND_CONFIGURATION_INVALID');
  }
  for(const c of value.commands){
    if(!object(c)||!keys(c,['id','projectId','threadId','agentId','profile','cwd','readPaths','writeRoot','settleDelayMs'])
      ||!id(c.id)||commands.has(c.id)||!id(c.projectId)||!id(c.threadId)||!id(c.agentId)||c.profile!=='project_manifest_v1'
      ||typeof c.cwd!=='string'||typeof c.writeRoot!=='string'||c.cwd!==c.writeRoot||!Number.isSafeInteger(c.settleDelayMs)
      ||Number(c.settleDelayMs)<0||Number(c.settleDelayMs)>60_000||!Array.isArray(c.readPaths)||!c.readPaths.length||c.readPaths.length>16
      ||c.readPaths.some(v=>typeof v!=='string'))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
    commands.add(c.id);const p=(value.projects as Project[]).find(p=>p.id===c.projectId),m=p?.members.find(m=>m.threadId===c.threadId&&m.agentId===c.agentId);
    const outputRoot=m?.workspaceMode==='shared_project'?p?.artifactRoot:p?.root;
    if(!p||!m||!outputRoot||c.writeRoot===outputRoot||!within(outputRoot,c.writeRoot)||within(m.workspace,c.writeRoot)||within(c.writeRoot,m.workspace))
      fail('THREADED_COMMAND_CONFIGURATION_INVALID');
    directoryPin(c.writeRoot);
    for(const filename of c.readPaths as string[]){
      if(!path.isAbsolute(filename)||path.normalize(filename)!==filename||!within(m.workspace,filename)||realpathSync(filename)!==filename
        ||(c.readPaths as string[]).some(other=>other!==filename&&within(other,filename)))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
    }
    if(new Set(c.readPaths).size!==c.readPaths.length)fail('THREADED_COMMAND_CONFIGURATION_INVALID');
  }
  const outputs=(value.commands as Entry[]).map(c=>c.writeRoot);
  if(outputs.some((v,i)=>outputs.some((other,j)=>i!==j&&(within(v,other)||within(other,v)))))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
  const members=(value.projects as Project[]).flatMap(p=>p.members.map(m=>({...m,projectId:p.id})));
  if(members.some((v,i)=>members.some((other,j)=>i!==j&&(within(v.workspace,other.workspace)||within(other.workspace,v.workspace))
      &&!(v.projectId===other.projectId&&v.workspaceMode==='shared_project'&&other.workspaceMode==='shared_project'&&v.workspace===other.workspace)))
    ||outputs.some(output=>members.some(member=>within(output,member.workspace)||within(member.workspace,output))))fail('THREADED_COMMAND_CONFIGURATION_INVALID');
  return value as unknown as Configuration;
}
/** Bounded filesystem manifest, re-read independently by the host verifier. */
function inputSnapshot(projectRoot:string,readPaths:string[]):{receipt:Buffer;pins:unknown[]}{
  const files:Array<{path:string;bytes:number;sha256:string}>=[],pins:unknown[]=[];let total=0,entries=0;
  function visit(filename:string,depth=0){
    if(++entries>4000||depth>32)fail('THREADED_COMMAND_INPUT_LIMIT');
    if(realpathSync(filename)!==filename)fail('THREADED_COMMAND_INPUT_CHANGED');
    const before=lstatSync(filename);
    if(before.isDirectory()){
      pins.push({path:filename,dev:before.dev,ino:before.ino,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs});
      const names=readdirSync(filename).sort();for(const name of names)visit(path.join(filename,name),depth+1);
      const after=lstatSync(filename);if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs
        ||before.ctimeMs!==after.ctimeMs||JSON.stringify(names)!==JSON.stringify(readdirSync(filename).sort()))fail('THREADED_COMMAND_INPUT_CHANGED');
    }else{
      if(files.length>=2000)fail('THREADED_COMMAND_INPUT_LIMIT');const current=fileSnapshot(filename,8*1024*1024);total+=current.bytes.length;
      if(total>32*1024*1024)fail('THREADED_COMMAND_INPUT_LIMIT');pins.push(current.pin);files.push({path:path.relative(projectRoot,filename),bytes:current.bytes.length,sha256:current.pin.sha256});
    }
  }
  for(const filename of readPaths)visit(filename);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {receipt:Buffer.from(JSON.stringify({schemaVersion:1,profile:'project_manifest_v1',files})+'\n'),pins};
}
/** No arbitrary executable, shell, network or model-selected substitutions are accepted.
 * The only v1 program is an audited, pinned Node worker whose complete persistent
 * effect domain is one exclusive output directory. Native process/group facts
 * are still required separately by the OS adapter before any lease release. */
export function loadThreadedProductionCommands(db:Database.Database,options:{file?:string;ownerId:string;mode:()=>string;
  authorizeMember:(scope:ActionScope)=>string|null;resources:ReturnType<typeof createExecutionResourceCoordinator>}):{
    commands:Record<string,ActionCommandPort>;resolveWorkspace:(scope:ActionScope)=>string|null;workspaceIdentity:(scope:ActionScope)=>string|null;
    status:()=>{configured:true;state:State;version:number;commandCount:number;projectCount:number;profiles:['project_manifest_v1']};close:()=>void;
  }|null{
  if(!options.file)return null;if(process.platform!=='darwin')fail('THREADED_OS_COMMAND_PLATFORM_UNVERIFIED');
  const requested=path.resolve(options.file);let filename:string,initial:ReturnType<typeof fileSnapshot>,config:Configuration;
  try{filename=realpathSync(requested);initial=fileSnapshot(filename,1024*1024);config=validate(parse(initial.bytes),options.ownerId);}
  catch{fail('THREADED_COMMAND_CONFIGURATION_INVALID');}
  let state:State='registered';
  const program=realpathSync(process.execPath),worker=fileURLToPath(new URL('./projectManifestWorker.mjs',import.meta.url));
  const guardian=fileURLToPath(new URL('../execution/guardian.mjs',import.meta.url));
  const programs=[fileSnapshot(program).pin,fileSnapshot(worker).pin,fileSnapshot(guardian).pin],directories:DirectoryPin[]=[];
  for(const p of config.projects){directories.push(directoryPin(p.root));if(p.artifactRoot)directories.push(directoryPin(p.artifactRoot));for(const m of p.members)directories.push(directoryPin(m.workspace));}
  for(const c of config.commands)directories.push(directoryPin(c.cwd));
  const expected=new Map(config.commands.map(c=>[c.id,inputSnapshot(config.projects.find(p=>p.id===c.projectId)!.root,c.readPaths)]));
  function current(){
    if(state!=='registered')return false;
    try{if(realpathSync(requested)!==filename||JSON.stringify(fileSnapshot(filename,1024*1024).pin)!==JSON.stringify(initial.pin))throw new Error();}
    catch{state='configuration_changed';return false;}
    try{
      for(const pin of programs)if(!filePinCurrent(pin))throw new Error();
      for(const pin of directories)if(JSON.stringify(directoryPin(pin.path))!==JSON.stringify(pin))throw new Error();
    }catch{state='path_changed';return false;}
    try{for(const c of config.commands){const live=inputSnapshot(config.projects.find(p=>p.id===c.projectId)!.root,c.readPaths),pin=expected.get(c.id)!;
      if(!live.receipt.equals(pin.receipt)||JSON.stringify(live.pins)!==JSON.stringify(pin.pins))throw new Error();}}
    catch{state='inputs_changed';return false;}return true;
  }
  function selected(scope:ActionScope){
    if(scope.ownerId!==config.ownerId)return null;
    for(const project of config.projects){const member=project.members.find(m=>m.threadId===scope.threadId&&m.agentId===scope.agentId);if(member)return {project,member};}return null;
  }
  function mapping(scope:ActionScope){const s=selected(scope);if(!s)return null;if(!current())fail('THREADED_COMMAND_MAPPING_CHANGED');return {...s,identity:digest({configuration:initial.pin.sha256,version:config.version,
    project:s.project.id,root:s.project.root,workspace:s.member.workspace,...(s.member.workspaceMode==='shared_project'?{workspaceMode:s.member.workspaceMode,artifactRoot:s.project.artifactRoot}:{}),scope:{ownerId:scope.ownerId,threadId:scope.threadId,agentId:scope.agentId},programs,inputs:config.commands.filter(c=>c.threadId===scope.threadId&&c.agentId===scope.agentId)
      .map(c=>({command:c.id,sha256:sha(expected.get(c.id)!.receipt),pins:expected.get(c.id)!.pins}))})};}
  const commands:Record<string,ActionCommandPort>=Object.create(null) as Record<string,ActionCommandPort>,ports:Array<ReturnType<typeof createThreadedOsCommandPort>>=[];
  for(const c of config.commands){
    const project=config.projects.find(p=>p.id===c.projectId)!,expectedReceipt=expected.get(c.id)!.receipt;
    const outputCurrent=(requireReceipt=false)=>{
      try{if(!current())return false;const names=readdirSync(c.writeRoot).sort();
        if(!names.length)return !requireReceipt;if(names.length!==1||names[0]!=='manifest.json')return false;
        return fileSnapshot(path.join(c.writeRoot,'manifest.json'),4*1024*1024).bytes.equals(expectedReceipt);
      }catch{return false;}
    };
    if(!outputCurrent())fail('THREADED_COMMAND_OUTPUT_UNVERIFIABLE');
    const port=createThreadedOsCommandPort(db,{registration:{id:c.id,program,argv:[worker,Buffer.from(JSON.stringify({projectRoot:project.root,readPaths:c.readPaths,
      writeRoot:c.writeRoot,expectedSha256:sha(expectedReceipt),settleDelayMs:c.settleDelayMs})).toString('base64url')],cwd:c.cwd,environment:{},
      workspaces:[...c.readPaths.map(p=>({path:p,access:'read' as const})),{path:c.writeRoot,access:'write' as const}],
      authorization(scope){
        if(scope.threadId!==c.threadId||scope.agentId!==c.agentId||!['closed','execute'].includes(options.mode()))return null;
        try{const m=mapping(scope);if(!m||!outputCurrent())return null;const member=options.authorizeMember(scope);
          return member?digest({mapping:m.identity,command:c.id,member}):null;}catch{return null;}
      },reconcileSideEffects:({exit,cancelled})=>outputCurrent(exit?.code===0&&!cancelled),
    },lease:createThreadedOsCommandResources(db,options.resources)});
    ports.push(port);commands[c.id]=port;
  }
  return {commands,resolveWorkspace(scope){return mapping(scope)?.member.workspace??null;},workspaceIdentity(scope){return mapping(scope)?.identity??null;},
    status(){current();return {configured:true,state,version:config.version,commandCount:config.commands.length,projectCount:config.projects.length,profiles:['project_manifest_v1']};},
    close(){for(const port of ports)port.close();}};
}
