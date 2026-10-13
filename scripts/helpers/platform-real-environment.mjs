import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { AcceptanceError } from './orchestration-acceptance.mjs';
import {syncNativeRefresh,authDigest}from'./platform-native-refresh.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(repo, 'apps/server/package.json'));
export const Database = require('better-sqlite3');

/** Selected credentials stay on this host; business rows and global native profiles are never copied. */
export async function realEnvironment(options) {
  const root = options.outputDir;
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const dbPath = path.join(root, 'acceptance.sqlite');
  const source = new Database(options.sourceDb, { readonly: true, fileMustExist: true });
  try {
    if (source.prepare("SELECT COUNT(*) n FROM accounts").get().n === 0) throw new AcceptanceError('SOURCE_ACCOUNTS_MISSING');
  } finally { source.close(); }
  const dotenv = {};
  try { for (const line of (await readFile(path.join(repo, 'apps/server/.env'), 'utf8')).split('\n')) {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) dotenv[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  } } catch {}
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'production', DB_PATH: dbPath,
    AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent',
    PORT: String(port), HOST: '127.0.0.1', ACCOUNT_TRUSTED_ORIGINS: `http://127.0.0.1:${port}`,
    EXTERNAL_WORKSPACE_DIR: path.join(root, 'workspaces'), EXTERNAL_WORKSPACE_MODE: 'isolated',
    EXTERNAL_CLAUDE_HOME: path.join(root, 'native-claude'), EXTERNAL_CODEX_HOME: path.join(root, 'native-codex'),
    EXTERNAL_AGENT_TIMEOUT_MS: String(options.timeoutMs), LLM_TIMEOUT_MS: String(options.timeoutMs), LLM_MAX_TOKENS: '2048',
    COORDINATION_RUNTIME_KERNEL: 'execute', ORCHESTRATION_ENTRY_MODE: 'execute', ORCHESTRATION_LEGACY_ENTRY_ENABLED: 'false',
    ORCHESTRATION_ENABLED_WORKFLOWS: 'routine', ORCHESTRATION_ENABLED_DRIVERS: 'builtin-llm,claude-sdk,codex-app-server',
    COORDINATION_PLANNER_MODEL: '', COORDINATION_PLANNER_ACCOUNT_REF: '', MCP_SERVER_CMD: '', ACCOUNT_ADMIN_TOKEN: '',
    EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: '', R8_ROOT: root, R8_MAX_STARTS: String(options.maxStarts), R8_DEADLINE: String(Date.now() + options.totalTimeoutMs),R8_CAMPAIGN:options.campaign??'core' };
  for (const name of Object.keys(env)) if (/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_API_|CODEX_ACCESS_|CLAUDE_CODE_OAUTH_|ACCOUNT_MASTER_KEY)/.test(name)) delete env[name];
  env.LLM_MAX_TOKENS = '2048'; env.LLM_TIMEOUT_MS = String(options.timeoutMs);
  // Only legacy API role configuration and an optional explicitly configured master key are used at preparation.
  for (const name of ['LLM_ANTHROPIC_API_KEY', 'LLM_ANTHROPIC_BASE_URL', 'LLM_OPENAI_API_KEY', 'LLM_OPENAI_BASE_URL', 'ACCOUNT_MASTER_KEY'])
    if (dotenv[name] || process.env[name]) env[name] = process.env[name] || dotenv[name];
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  const launch = (mode) => fork(path.join(repo, 'scripts/helpers/platform-real-worker.mjs'), [mode, options.sourceDb, options.claudeAgent, options.codexAccount, options.apiAgent], {
    cwd: repo, env, execArgv: ['--import', path.join(repo, 'apps/server/node_modules/tsx/dist/loader.mjs')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const prepared = options.resume ? await (async()=>{const previous=JSON.parse(await readFile(path.join(root,'environment.json'),'utf8'));if(previous.sourceDb!==options.sourceDb||previous.constraints.logicalStartLimit!==options.maxStarts)throw new AcceptanceError('RESUME_ENVIRONMENT_MISMATCH');return {type:'prepared',accounts:previous.prepared,workspace:previous.workspace,nativeRefresh:previous.nativeRefresh??[]};})() : await new Promise((resolve, reject) => {
    const prep = launch('prepare'); let result;
    const timer = setTimeout(() => { prep.kill('SIGTERM'); reject(new AcceptanceError('PREPARATION_TIMEOUT')); }, 30_000);
    prep.stdout.resume(); prep.stderr.resume();
    prep.on('message', message => { if (message.type === 'prepared') result = message; if (message.type === 'error') result = message; });
    prep.once('error', () => { clearTimeout(timer); reject(new AcceptanceError('PREPARATION_PROCESS_FAILED')); });
    prep.once('exit', code => { clearTimeout(timer);if(code===0&&result?.type==='prepared')resolve(result);else{const error=new AcceptanceError(result?.code??'PREPARATION_FAILED');error.fieldErrors=result?.details;reject(error);} });
  });
  // Remove API secrets from the server environment. All inference now uses managed accounts in the isolated DB.
  for (const name of Object.keys(env)) if (/^(LLM_.*KEY|ACCOUNT_MASTER_KEY)/.test(name)) delete env[name];
  async function start() {
    child = launch('serve'); child.stdout.resume(); child.stderr.resume();
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null) throw new AcceptanceError('ISOLATED_SERVER_EXITED');
      try { const r = await fetch(baseUrl + '/api/orchestration/options', { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new AcceptanceError('ISOLATED_SERVER_START_TIMEOUT');
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child;
    await new Promise(resolve => { current.once('exit', resolve); current.kill(signal); const timer = setTimeout(() => current.kill('SIGKILL'), 10_000); timer.unref(); });
    if(signal!=='SIGKILL')for(const binding of prepared.nativeRefresh??[]){const result=await syncNativeRefresh(binding);await writeFile(path.join(root,'native-refresh-result.json'),JSON.stringify(result)+'\n',{mode:0o600});
      if(result.status==='refreshed_source'){const file=path.join(path.dirname(binding.sourceDb),'native-refresh-chain.json');let parents;try{parents=JSON.parse(await readFile(file,'utf8'));}catch{continue;}
        for(const parent of parents.filter(p=>p.copyPath===binding.sourcePath&&p.accountId===binding.accountId&&p.generation===binding.generation)){const synced=await syncNativeRefresh(parent);if(synced.status==='refreshed_source')parent.initialDigest=authDigest(await readFile(parent.sourcePath));await writeFile(path.join(root,'native-parent-refresh-result.json'),JSON.stringify(synced)+'\n',{mode:0o600});}await writeFile(file,JSON.stringify(parents)+'\n',{mode:0o600});
      }
    }
  }
  if(!options.resume)await writeFile(path.join(root, 'environment.json'), JSON.stringify({ version: 1, sourceDb: options.sourceDb, isolatedDb: dbPath, prepared: prepared.accounts,workspace:prepared.workspace,nativeRefresh:prepared.nativeRefresh,
    constraints: { logicalStartLimit: options.maxStarts, supplierInternalCalls: 'unknown', timeoutMs: options.timeoutMs, currency: 'USD', mode: 'estimate', unknownReserve: 0.1 }, businessDataCopied: false }, null, 2) + '\n', { mode: 0o600 });
  return { root, dbPath, baseUrl, prepared, start, stop, get pid() { return child?.pid; }, read: (sql, ...args) => {
    const db = new Database(dbPath, { readonly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); }
  } };
}
