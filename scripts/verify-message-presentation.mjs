import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {completedWerewolfReplay} from '../apps/web/src/services/flowReplayPresentation.ts';
const root=await mkdtemp(path.join(tmpdir(),'gand-message-presentation-'));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',DB_PATH:path.join(root,'test.sqlite')});
const {flowDefinition,reduceFlow}=await import('../apps/server/src/collaboration/protocols/definitions.ts');
const {closeDatabase}=await import('../apps/server/src/db/database.ts');
try{

// A recorded real delivery, including its original whitespace, must stay intact.
const body=(await readFile(new URL('../docs/reports/werewolf-entry-fix-real-replay-2026-10-18.md',import.meta.url),'utf8')).split('\n---\n\n')[1].trimEnd();
const message={kind:'agent',messageType:'collaboration_result',body,meta:{autonomousEmissionId:'accepted',authorizedBy:'task_sources'}};
const flow={protocol:'werewolf-five-v1',step:4,phase:'terminal',status:'completed'};
const saved=JSON.stringify(message),replay=completedWerewolfReplay(message,flow);
assert.ok(replay);assert.equal(replay.winner,'wolf');assert.equal(replay.players.length,5);assert.equal(replay.stages.length,4);
assert.equal(replay.stages.reduce((n,s)=>n+s.actions.length,0),12);
assert.equal(replay.players.find(p=>p.id==='role-b1ed6bb4').role,'wolf');
assert.equal(replay.stages[1].lines.find(l=>l.actor==='role-b1ed6bb4').claim,'villager','a public claim stays distinct from revealed identity');
assert.equal(JSON.stringify(message),saved,'presentation must never rewrite the authoritative message');

for(const candidate of [
 {...message,kind:'user'}, {...message,messageType:'informational'}, {...message,meta:{}},
 {...message,meta:{...message.meta,authorizedBy:'frozen_protocol'}},
 {...message,body:body.replace('终局身份：','未公开身份：')},
 {...message,body:body.replace('阶段 4：','阶段 5：')},
 {...message,body:body.replace('第1夜结束：','未知协议事件：')},
 {...message,body:body.replace('"kind":"inspect"','"kind":"inspect","privateClue":"secret"')},
 {...message,body:body.replace('"kind":"inspect"','"kind":"review"')},
 {...message,body:body.replace('"target":"coder-jitui"','"target":"unrelated-role"')},
 {...message,body:body.replace('role-b1ed6bb4=wolf','role-b1ed6bb4=seer')},
])assert.equal(completedWerewolfReplay(candidate,flow),null,'unknown, ordinary or nonterminal messages must use the original Markdown view');
for(const candidate of [undefined,{...flow,status:'running'},{...flow,phase:'vote'},{...flow,protocol:'review-ballot-v1'},{...flow,step:3}])assert.equal(completedWerewolfReplay(message,candidate),null);

// Exercise the other canonical endings using the real frozen protocol reducer.
// A seer may be killed on night one; good-side wins end after three stages.
for(const seerKilled of [false,true]){
 const players=['wolf','seer','a','b','c'],definition=flowDefinition('werewolf-five-v1');
 let state={phase:'night',round:1,alive:players,roles:{wolf:'wolf',seer:'seer',a:'villager',b:'villager',c:'villager'},clues:{},history:[],winner:null};
 const actions=[];
 const commit=value=>{actions.push(value);state=reduceFlow(definition.id,state,value,players);};
 commit({wolf:{kind:'attack',target:seerKilled?'seer':'c'},seer:{kind:'inspect',target:'wolf'}});
 commit(Object.fromEntries(state.alive.map(id=>[id,{kind:'statement',target:id==='wolf'?'a':'wolf',claim:'unspecified',confidence:'low'}])));
 commit(Object.fromEntries(state.alive.map(id=>[id,{kind:'vote',target:id==='wolf'?'a':'wolf'}])));
 const terminalBody=`流程结束 · ${definition.id}\n\n规则：${definition.rules}\n\n完整回放：\n${state.history.map((event,i)=>`${i+1}. ${event}`).join('\n\n')}\n\n已接受的独立行动：\n${actions.map((row,i)=>`阶段 ${i+1}：`+Object.entries(row).map(([id,value])=>`${id} ${JSON.stringify(value)}`).join('；')).join('\n')}`;
 const result=completedWerewolfReplay({...message,body:terminalBody},{...flow,step:3});
 assert.ok(result);assert.equal(result.winner,'villagers');assert.equal(result.stages.length,3);assert.equal(result.stages[0].lines[0].target,seerKilled?'seer':'c');
}
console.log('Message presentation verified: real replay retained, both endings, public claims, terminal gates and safe original-text fallback.');

}finally{closeDatabase();await rm(root,{recursive:true,force:true});}
