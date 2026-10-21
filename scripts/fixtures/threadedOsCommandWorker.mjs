import path from 'node:path';
const [root,name]=process.argv.slice(2);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,`unused-os-worker-${process.pid}.sqlite`),AGENTS_DIR:path.join(root,'agents')});
const {openOsHarness}=await import('./threadedOsCommandHarness.mjs');
const h=await openOsHarness(root,name);const {command,holder}=await h.start();
const row=h.f.db.prepare('SELECT * FROM threaded_os_commands WHERE command_id=?').get(command.commandId);
process.send?.({type:'ready',file:h.f.file,commandId:command.commandId,scope:{ownerId:holder.binding.ownerId,threadId:holder.binding.threadId,agentId:holder.binding.agentId},record:JSON.parse(row.record),claim:JSON.parse(row.claim_record),registration:h.registration});
process.on('message',message=>{if(message.type==='disconnect-owned')h.port.close();if(message.type==='close'){h.close();process.exit(0);}});
setInterval(()=>{},1000);
