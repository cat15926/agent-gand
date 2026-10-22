// This bounded production command is deliberately not an arbitrary command runner.
// Only Node builtins are imported, environment is empty, and all paths come from
// the pinned server registration. The parent independently verifies the result.
import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,readdirSync,realpathSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const input=JSON.parse(Buffer.from(process.argv[2]??'','base64url').toString('utf8'));
const output=[];let total=0,entries=0;
function visit(filename,depth=0){
  if(++entries>4000||depth>32)throw new Error('Input tree too large');
  if(realpathSync(filename)!==filename)throw new Error('Path changed');
  const stat=lstatSync(filename);
  if(stat.isDirectory()){
    for(const name of readdirSync(filename).sort())visit(path.join(filename,name),depth+1);
    return;
  }
  if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024||output.length>=2000)throw new Error('Unsupported input');
  const descriptor=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(descriptor),bytes=readFileSync(descriptor),after=fstatSync(descriptor),live=lstatSync(filename);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs
      ||before.ctimeMs!==after.ctimeMs||live.dev!==after.dev||live.ino!==after.ino)throw new Error('Input changed');
    total+=bytes.length;if(total>32*1024*1024)throw new Error('Input too large');
    output.push({path:path.relative(input.projectRoot,filename),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }finally{closeSync(descriptor);}
}
for(const filename of input.readPaths)visit(filename);
output.sort((a,b)=>a.path.localeCompare(b.path,'en'));
const receipt=JSON.stringify({schemaVersion:1,profile:'project_manifest_v1',files:output})+'\n';
if(createHash('sha256').update(receipt).digest('hex')!==input.expectedSha256)throw new Error('Inputs changed');
await new Promise(resolve=>setTimeout(resolve,input.settleDelayMs));
if(realpathSync(input.writeRoot)!==input.writeRoot)throw new Error('Output changed');
const temporary=path.join(input.writeRoot,'manifest.json.pending');
// O_EXCL and a fixed temporary filename reject a pre-existing/symlinked output.
writeFileSync(temporary,receipt,{flag:'wx',mode:0o600});
renameSync(temporary,path.join(input.writeRoot,'manifest.json'));
