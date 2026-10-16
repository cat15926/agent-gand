#!/usr/bin/env node
// Deliberately writes native memory: the platform must give each Scope a different home.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.159.2');process.exit(0);}
if(args.includes('--help')){console.log('--listen generate-ts');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');let threadId,cwd,turnId;
createInterface({input:process.stdin}).on('line',line=>{void(async()=>{
 const m=JSON.parse(line),p=m.params??{};
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='turn/interrupt'){
  send({id:m.id,result:{}});
  const behavior=process.env.G5_FIXTURE_CONTROL?JSON.parse(process.env.G5_FIXTURE_CONTROL):{};
  if(!behavior.omitFinalUsage)send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:10,outputTokens:8}}}});
  // Output after candidate sealing must never enter model results or the event log.
  send({method:'item/completed',params:{threadId,turnId,item:{id:randomUUID(),type:'agentMessage',text:'LATE_SEALED_PRIVATE_MUST_NOT_ESCAPE'}}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});
 }
 if(m.method==='thread/read'||m.method==='thread/resume')throw new Error('G5 must never resume');
 if(m.method==='thread/start'){
  assert.equal(p.ephemeral,true);assert.equal(p.approvalPolicy,'never');assert.equal(p.approvalsReviewer,'user');
  assert.ok(args.includes('project_doc_max_bytes=0'));assert.ok(args.includes('memories.use_memories=false'));
  assert.ok(args.includes('features.shell_tool=false'));assert.ok(args.includes('features.multi_agent=false'));
  assert.equal(existsSync(path.join(process.env.CODEX_HOME,'fixture-memory.txt')),false,'old native home memory');
  cwd=p.cwd;assert.equal(existsSync(path.join(cwd,'fixture-memory.txt')),false,'old native workspace');threadId=randomUUID();
  send({id:m.id,result:{thread:{id:threadId},cwd,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',approvalsReviewer:'user'}});
 }
 if(m.method==='turn/start'){
  assert.equal(p.threadId,threadId);turnId=randomUUID();send({id:m.id,result:{turn:{id:turnId}}});
  writeFileSync(path.join(process.env.CODEX_HOME,'fixture-memory.txt'),p.input[0].text);
  writeFileSync(path.join(cwd,'fixture-memory.txt'),p.input[0].text);
  appendFileSync(process.env.G5_FIXTURE_LOG,JSON.stringify({cwd,home:process.env.CODEX_HOME,prompt:p.input[0].text,threadId})+'\n');
  if(process.env.G5_FIXTURE_CONTROL&&JSON.parse(process.env.G5_FIXTURE_CONTROL).wait)return;
  setTimeout(async()=>{
   send({method:'item/completed',params:{threadId,turnId,item:{id:randomUUID(),type:'agentMessage',text:'Codex scoped fixture result'}}});
   send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:10,outputTokens:8},last:{inputTokens:10,outputTokens:8}}}});
   if(process.env.AGENT_GAND_BRIDGE_URL){
    await new Promise(resolve=>setTimeout(resolve,20));
    const action=process.env.G5_FIXTURE_CONTROL?JSON.parse(process.env.G5_FIXTURE_CONTROL):{name:'agent_complete',arguments:{summary:'当前事项已完成，已核对事实、依据与限制。'}};
    const response=await fetch(new URL('call',process.env.AGENT_GAND_BRIDGE_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.AGENT_GAND_BRIDGE_TOKEN,'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),name:action.name,arguments:action.arguments})});
    assert.equal(response.status,200);const result=await response.json();assert.notEqual(result.isError,true);return;
   }
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  },20);
 }
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exit(1);});});
