import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createThreadedRelease} from '../../apps/server/src/threaded/release.ts';
const db=new Database(process.argv[2],{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
process.send?.({type:'ready'});
process.once('message',message=>{
  try{const release=createThreadedRelease(db,{mode:()=>message.mode??'execute',members:()=>message.members??[],now:()=>message.clock??1});
    const result=release.change(message.input);
    if(message.crashAfterCommit){process.send?.({type:'committed',result});return;}
    process.send?.({type:'result',result});
  }catch(error){process.send?.({type:'result',error:{code:error.code,message:error.message}});}
  db.close();process.disconnect();
});
