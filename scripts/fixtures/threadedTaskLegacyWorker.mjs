import assert from 'node:assert/strict';
import path from 'node:path';
const [file,taskId]=process.argv.slice(2);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:file,AGENTS_DIR:path.join(path.dirname(file),'agents')});
const tasks=await import('../../apps/server/src/messaging/tasks.ts');
const {closeDatabase}=await import('../../apps/server/src/db/database.ts');
try{
  assert.equal(tasks.getTask(taskId),undefined);assert.ok(!tasks.listTasks().some(t=>t.id===taskId));
  for(const action of [()=>tasks.claimTask(taskId,'other-member'),()=>tasks.completeTask(taskId,'other-member','bypass'),()=>tasks.cancelTask(taskId)])assert.throws(action,/task 不存在/);
  const legacy=tasks.createTask({title:'Legacy positive control',createdBy:'user'});tasks.claimTask(legacy.id,'api-member');tasks.completeTask(legacy.id,'api-member','legacy result');
  assert.equal(tasks.getTask(legacy.id).status,'completed');console.log(JSON.stringify({ok:true,threadedReadHidden:true,threadedWritesRejected:true,legacyPositiveControl:true}));
}finally{closeDatabase();}
