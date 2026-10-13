import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realEnvironment } from './helpers/platform-real-environment.mjs';
import { runRealScenarios } from './helpers/platform-real-scenarios.mjs';
import { AcceptanceError } from './helpers/orchestration-acceptance.mjs';

export function parsePlatformRealArgs(args) {
  const options = {}; const names = new Set(['--source-db', '--claude-agent', '--codex-account', '--api-agent', '--output-dir', '--max-starts', '--timeout-ms', '--total-timeout-ms','--campaign']);
  let execute = false, resume = false,retryPublicFault=false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute' && !execute) { execute = true; continue; }
    if (args[i] === '--resume' && !resume) { resume = true; continue; }
    if(args[i]==='--retry-public-fault'&&!retryPublicFault){retryPublicFault=true;continue;}
    if (!names.has(args[i]) || options[args[i]] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new AcceptanceError('INVALID_ACCEPTANCE_ARGUMENT');
    options[args[i]] = args[++i];
  }
  if (!options['--claude-agent'] || !options['--codex-account'] || !options['--api-agent']) throw new AcceptanceError('EXPLICIT_ACCOUNT_SELECTION_REQUIRED');
  for (const key of ['--claude-agent', '--api-agent']) if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options[key])) throw new AcceptanceError('INVALID_ROLE_ID');
  if (!/^[0-9a-f-]{36}$/.test(options['--codex-account'])) throw new AcceptanceError('INVALID_ACCOUNT_ID');
  const integer = (key, fallback, min, max) => { const n = Number(options[key] ?? fallback); if (!Number.isSafeInteger(n) || n < min || n > max) throw new AcceptanceError('INVALID_EXECUTION_LIMIT'); return n; };
  const sourceDb = path.resolve(options['--source-db'] ?? 'apps/server/data/agent-gand.sqlite');
  const outputDir = path.resolve(options['--output-dir'] ?? `apps/server/data/platform-r8-qa/${new Date().toISOString().replaceAll(':', '-')}`);
  if (sourceDb.startsWith(outputDir + path.sep)) throw new AcceptanceError('SOURCE_OUTPUT_OVERLAP');
  const campaign=options['--campaign']??'core';if(!['core','recovery','codex-write'].includes(campaign))throw new AcceptanceError('INVALID_CAMPAIGN');
  if(retryPublicFault&&!resume)throw new AcceptanceError('EXPLICIT_RESUME_REQUIRED');
  return { execute, resume, retryPublicFault,campaign, sourceDb, outputDir, claudeAgent: options['--claude-agent'], codexAccount: options['--codex-account'], apiAgent: options['--api-agent'],
    maxStarts: integer('--max-starts', 24, 3, 30), timeoutMs: integer('--timeout-ms', 180000, 10000, 180000), totalTimeoutMs: integer('--total-timeout-ms', 1200000, 60000, 1800000) };
}

export async function main(args) {
  const options = parsePlatformRealArgs(args);
  if (!options.execute) { console.log(JSON.stringify({ status: 'plan_only', ...options, realInference: false })); return; }
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  let report = { version: 1, scope: 'isolated_real_supplier_tasks', status: 'running', startedAt: new Date().toISOString(), fixtureResultsCountAsReal: false,
    authorization: { claudeSourceRole: options.claudeAgent, codexSourceAccount: options.codexAccount, apiSourceRole: options.apiAgent, maxPlatformStarts: options.maxStarts, timeoutMs: options.timeoutMs, totalTimeoutMs: options.totalTimeoutMs,...(options.campaign!=='core'?{campaign:options.campaign}:{}) }, scenarios: [], runs: [] };
  if(options.resume){const old=JSON.parse(await readFile(path.join(options.outputDir,'result.json'),'utf8'));if(JSON.stringify(old.authorization)!==JSON.stringify(report.authorization)||old.scope!==report.scope)throw new AcceptanceError('RESUME_AUTHORIZATION_MISMATCH');report={...old,status:'running',history:[...(old.history??[]),{finishedAt:old.finishedAt,status:old.status,scenarios:old.scenarios.map(s=>({id:s.id,status:s.status,errorCode:s.errorCode}))}]};}
  const save = () => writeFile(path.join(options.outputDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await save(); let environment;
  try {
    environment = await realEnvironment(options); await environment.start();
    const verified = await (await fetch(environment.baseUrl + '/api/orchestration/options')).json();
    if (verified.verificationEnvironment?.fixture !== false || verified.verificationEnvironment?.claudeSdkWorker !== 'bundled') throw new AcceptanceError('REAL_NORMAL_WORKER_REQUIRED');
    report.environment = { dbPath: environment.dbPath, ...verified.verificationEnvironment, copiedBusinessRows: false, accounts: environment.prepared.accounts };
    if(environment.prepared.accounts.some(a=>a.baseUrl&&((url=>url.protocol!=='https:'||['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname))(new URL(a.baseUrl)))))throw new AcceptanceError('REAL_SUPPLIER_ENDPOINT_REQUIRED');
    await save(); await runRealScenarios({ environment, options, report, save, onProgress: value => console.log(JSON.stringify(value)) });
  } catch (error) { report.status = 'failed'; report.errorCode = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_ENVIRONMENT_FAILED';if(error.fieldErrors)report.fieldErrors=error.fieldErrors; }
  finally { if (environment) await environment.stop(); report.finishedAt = new Date().toISOString(); await save(); }
  console.log(JSON.stringify({ status: report.status, output: path.join(options.outputDir, 'result.json'), platformStarts: report.platformStarts ?? 0 }));
  if (report.status !== 'passed') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
