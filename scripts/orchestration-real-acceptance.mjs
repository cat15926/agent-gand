import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backendSmoke, httpClient } from './helpers/orchestration-acceptance.mjs';

export function parseRealAcceptanceArgs(args) {
  const allowed = new Set(['--base-url', '--claude-agent', '--codex-agent', '--output', '--timeout-ms']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]] !== undefined) throw new Error('无效或重复的验收参数');
    options[args[i]] = args[i + 1];
  }
  if (!options['--claude-agent'] && !options['--codex-agent']) throw new Error('请显式指定 --claude-agent 和/或 --codex-agent；不会自动选择账户');
  for (const flag of ['--claude-agent', '--codex-agent']) if (options[flag] && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(options[flag])) throw new Error('角色 ID 无效');
  const timeoutMs = Number(options['--timeout-ms'] ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 180_000) throw new Error('验收超时须为 10000–180000 毫秒');
  return { baseUrl: options['--base-url'] ?? 'http://127.0.0.1:3010', claude: options['--claude-agent'], codex: options['--codex-agent'], timeoutMs,
    output: path.resolve(options['--output'] ?? 'apps/server/data/orchestration-o7-qa/real-result.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = parseRealAcceptanceArgs(process.argv.slice(2));
    const request = httpClient(input.baseUrl);
    const environment = (await request('/api/orchestration/options')).verificationEnvironment;
    if (!environment || environment.fixture || input.claude && environment.claudeSdkWorker !== 'bundled') throw new Error('真实验收须连接新版正常服务；fixture 或自定义 SDK worker 不能记为真实供应商通过');
    const report = { scope: 'user_account_environment', status: 'running', testedAt: new Date().toISOString(), fixtureResultsCountAsReal: false,
      requirements: ['claude-sdk', 'codex-app-server'], backends: [] };
    await mkdir(path.dirname(input.output), { recursive: true });
    const save = () => writeFile(input.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await save();
    for (const [driver, agentId] of [['claude-sdk', input.claude], ['codex-app-server', input.codex]]) {
      if (!agentId) { report.backends.push({ driver, status: 'not_run', reason: 'USER_ACCOUNT_NOT_SELECTED' }); continue; }
      const index = report.backends.length;
      report.backends.push({ driver, agentId, status: 'running' });
      const result = await backendSmoke(request, { agentId, driver, timeoutMs: input.timeoutMs,
        onCreated: async progress => { report.backends[index] = progress; await save(); } });
      report.backends[index] = result;
      await save();
      console.log(JSON.stringify(result));
    }
    report.status = report.backends.every(item => item.status === 'passed') ? 'passed' : report.backends.some(item => item.status === 'failed') ? 'failed' : 'incomplete';
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: report.status, output: input.output }));
    if (report.status !== 'passed') process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
