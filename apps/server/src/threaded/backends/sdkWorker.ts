import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool, getSessionInfo, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BackendTool } from './types.ts';
import { sdkOptions, type SdkWorkerInput } from '../../execution/sdkOptions.ts';
import { diagnostic } from '../../execution/errors.ts';

const send=(message:unknown)=>process.stdout.write(JSON.stringify(message)+'\n');
const controller=new AbortController(), decisions=new Map<string,(value:boolean)=>void>();
const toolResults=new Map<string,(value:string)=>void>();
const lines=createInterface({input:process.stdin});let started=false;
lines.on('close',()=>{controller.abort();for(const resolve of decisions.values())resolve(false);for(const resolve of toolResults.values())resolve('{"ok":false,"code":"THREADED_TOOL_INTERRUPTED"}');});
lines.on('line',line=>{
  try {
    const message=JSON.parse(line);
    if(message.method==='sdk/start'&&!started){started=true;void run(message.params as SdkWorkerInput&{applicationTools?:BackendTool[]});}
    else if(message.method==='sdk/interrupt'){controller.abort();for(const resolve of decisions.values())resolve(false);}
    else if(message.id!==undefined&&!message.method){const key=String(message.id);
      if(toolResults.has(key)){toolResults.get(key)!(String(message.result?.text??''));toolResults.delete(key);}
      else{decisions.get(key)?.(message.result?.allow===true);decisions.delete(key);}}
    else throw new Error('invalid protocol');
  }catch{send({method:'sdk/error',params:{message:'SDK worker protocol invalid'}});}
});
async function run(input:SdkWorkerInput&{applicationTools?:BackendTool[]}) {
  try {
    if(!input.session?.id)throw new Error('session id required');
    if(input.session.resume) {
      const info=await getSessionInfo(input.session.id,{dir:input.cwd});
      if(!info||info.sessionId!==input.session.id||info.cwd!==input.cwd){send({method:'sdk/resumeUnavailable',params:{}});return;}
    }
    const options=sdkOptions(input,(id,tool,args)=>new Promise(resolve=>{
      const key=`tool:${id}`;decisions.set(key,resolve);
      send({id:key,method:'sdk/permission',params:{tool,input:args,toolUseId:id}});
    }));
    if(input.applicationTools?.length){
      const definitions=input.applicationTools.map(definition=>{
        const schema=z.fromJSONSchema(definition.parameters) as z.ZodObject;
        return tool(definition.name,definition.description,schema.shape,async args=>{
          const key=`application:${randomUUID()}`;
          const result=await new Promise<string>(resolve=>{toolResults.set(key,resolve);send({id:key,method:'sdk/applicationTool',params:{name:definition.name,input:args}});});
          return {content:[{type:'text' as const,text:result}]};
        });
      });
      options.mcpServers={threaded:createSdkMcpServer({name:'threaded',version:'1.0.0',tools:definitions})};
      options.disallowedTools=[];options.allowedTools=input.applicationTools.map(t=>`mcp__threaded__${t.name}`);
    }
    options.hooks??={};
    options.hooks.PostToolUse=[...(options.hooks.PostToolUse??[]),{hooks:[async(event,id)=>{
      if(event.hook_event_name==='PostToolUse'&&id&&['Read','Grep','Glob'].includes(event.tool_name))
        send({method:'sdk/nativeToolCompleted',params:{tool:event.tool_name,toolUseId:id}});
      return {};
    }]}];
    options.abortController=controller;
    options.spawnClaudeCodeProcess=opts=>{
      const child=spawn(opts.command,opts.args,{cwd:opts.cwd,env:opts.env,detached:false,shell:false,stdio:['pipe','pipe','pipe']});
      child.stderr.on('data',chunk=>process.stderr.write(diagnostic(String(chunk))));return child;
    };
    const result=query({prompt:input.prompt,options});
    try {for await(const message of result)send({method:'sdk/message',params:{message}});}
    finally{result.close();}
    const info=await getSessionInfo(input.session.id,{dir:input.cwd});
    const messages=await getSessionMessages(input.session.id,{dir:input.cwd});
    if(messages.length>10_000)throw new Error('session inspection limit');
    const user=[...messages].reverse().find(message=>message.type==='user'&&JSON.stringify(message.message).includes(JSON.stringify(input.prompt).slice(1,-1)));
    const last=messages.at(-1);
    if(info?.sessionId===input.session.id&&info.cwd===input.cwd&&user&&last) {
      send({method:'sdk/checkpoint',params:{sessionId:input.session.id,anchorUuid:last.uuid,inputUserUuid:user.uuid}});
    }
    send({method:'sdk/done',params:{}});
  }catch{send({method:'sdk/error',params:{message:'SDK worker failed'}});}
}
