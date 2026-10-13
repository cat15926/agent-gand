import {readFile}from'node:fs/promises';
import path from'node:path';
import {realEnvironment}from'./helpers/platform-real-environment.mjs';

const root=path.resolve(process.argv[2]??'');if(!process.argv[2])throw new Error('ACCEPTANCE_DIRECTORY_REQUIRED');
const report=JSON.parse(await readFile(path.join(root,'result.json'),'utf8')),metadata=JSON.parse(await readFile(path.join(root,'environment.json'),'utf8'));
if(report.scope!=='isolated_real_supplier_tasks'||report.environment?.fixture!==false)throw new Error('REAL_ACCEPTANCE_EVIDENCE_REQUIRED');
const a=report.authorization,environment=await realEnvironment({resume:true,sourceDb:metadata.sourceDb,outputDir:root,claudeAgent:a.claudeSourceRole,codexAccount:a.codexSourceAccount,apiAgent:a.apiSourceRole,maxStarts:a.maxPlatformStarts,timeoutMs:a.timeoutMs,totalTimeoutMs:a.totalTimeoutMs,campaign:a.campaign??'core'});
await environment.start();console.log(JSON.stringify({status:'ready',baseUrl:environment.baseUrl,scope:'existing_isolated_acceptance_records',noNewTasksCreated:true}));
await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});await environment.stop();
