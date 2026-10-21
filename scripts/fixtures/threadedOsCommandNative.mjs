import {appendFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const [directory,mode]=process.argv.slice(2);
appendFileSync(`${directory}/starts.jsonl`,JSON.stringify({pid:process.pid,environment:process.env.FIXTURE_ENV??null,unexpected:process.env.THREADED_OS_UNEXPECTED_ENV??null})+'\n');
if(mode==='child'){setInterval(()=>{},1000);}
else if(mode==='complete'){setTimeout(()=>process.exit(0),250);}
else {
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,directory,'child'],{env:process.env,stdio:'ignore',detached:false});
  writeFileSync(`${directory}/pids.json`,JSON.stringify({native:process.pid,child:child.pid}));
  process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
}
