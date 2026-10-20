import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { getSessionInfo, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { sdkOptions, type SdkWorkerInput } from '../../execution/sdkOptions.ts';
import { diagnostic } from '../../execution/errors.ts';

const send=(message:unknown)=>process.stdout.write(JSON.stringify(message)+'\n');
const controller=new AbortController(), decisions=new Map<string,(value:boolean)=>void>();
const lines=createInterface({input:process.stdin});let started=false;
lines.on('close',()=>{controller.abort();for(const resolve of decisions.values())resolve(false);});
lines.on('line',line=>{
  try {
    const message=JSON.parse(line);
    if(message.method==='sdk/start'&&!started){started=true;void run(message.params as SdkWorkerInput);}
    else if(message.method==='sdk/interrupt'){controller.abort();for(const resolve of decisions.values())resolve(false);}
    else if(message.id!==undefined&&!message.method){decisions.get(String(message.id))?.(message.result?.allow===true);decisions.delete(String(message.id));}
    else throw new Error('invalid protocol');
  }catch{send({method:'sdk/error',params:{message:'SDK worker protocol invalid'}});}
});
async function run(input:SdkWorkerInput) {
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
