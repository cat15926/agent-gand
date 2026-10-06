import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'apps/server/data/orchestration-o7-qa/local-suite.json');
const env = { ...process.env, NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', VERIFY_O6_UI: '1' };
for (const key of Object.keys(env)) if (/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_API_|CODEX_ACCESS_|CLAUDE_CODE_OAUTH_|ACCOUNT_MASTER_KEY|ACCOUNT_ADMIN_TOKEN)/.test(key)) delete env[key];
const loader = path.join(root, 'apps/server/node_modules/tsx/dist/loader.mjs');
const stages = ['orchestration-o1', 'orchestration-o2', 'orchestration-o3', 'orchestration-o4', 'orchestration-o6', 'orchestration-o7',
  'claude-sdk-mcp-protocol', 'claude-sdk-session-protocol', 'codex-app-server-protocol', 'codex-mcp-protocol', 'accounts-connection', 'orchestration-o5'];
const report = { scope: 'isolated_local_fixture', startedAt: new Date().toISOString(), status: 'running', stages: [],
  realBackendAcceptance: { 'claude-sdk': 'not_run', 'codex-app-server': 'not_run' } };
await mkdir(path.dirname(output), { recursive: true });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
for (const stage of stages) {
  if (stage === 'orchestration-o5' && !env.PLAYWRIGHT_MODULE) {
    report.stages.push({ name: stage, status: 'not_run', reason: 'PLAYWRIGHT_MODULE_REQUIRED' }); await save(); continue;
  }
  console.log(`开始验证 ${stage}`);
  const started = Date.now();
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', loader, path.join(root, `scripts/verify-${stage}.mjs`)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Keep failure diagnostics bounded; successful raw fixture bodies are not stored in the report.
    let tail = ''; child.stdout.on('data', chunk => { tail = (tail + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-12000); });
    child.once('error', () => resolve(-1));
    child.once('exit', code => { if (code !== 0) console.error(tail); resolve(code ?? -1); });
  });
  const status = exitCode === 0 ? 'passed' : 'failed';
  report.stages.push({ name: stage, status, exitCode, elapsedMs: Date.now() - started });
  await save(); console.log(`${stage}: ${status}`);
}
report.status = report.stages.every(item => item.status === 'passed') ? 'passed' : report.stages.some(item => item.status === 'failed') ? 'failed' : 'incomplete';
report.finishedAt = new Date().toISOString(); await save();
console.log(JSON.stringify({ status: report.status, stages: report.stages, output }, null, 2));
if (report.status !== 'passed') process.exitCode = 2;
