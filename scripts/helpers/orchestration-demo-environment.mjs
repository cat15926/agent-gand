import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Deliberately isolated demo: no .env, no business DB, no real supplier commands. */
export async function createDemoEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), 'gand-o7-demo-'));
  const repo = path.resolve(import.meta.dirname, '../..');
  const native = path.join(root, 'native-fixture');
  await copyFile(path.join(repo, 'scripts/fixtures/external-agent-o4.mjs'), native); await chmod(native, 0o755);
  await writeFile(path.join(root, 'native.jsonl'), '');
  Object.assign(process.env, { NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
    DB_PATH: path.join(root, 'demo.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
    ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', COORDINATION_PLANNER_MODEL: '', COORDINATION_PLANNER_ACCOUNT_REF: '',
    COORDINATION_RUNTIME_KERNEL: 'execute', APPROVAL_TIMEOUT_MS: '0', EXTERNAL_WORKSPACE_MODE: 'isolated',
    EXTERNAL_AGENT_TIMEOUT_MS: '15000', EXTERNAL_WORKSPACE_DIR: path.join(root, 'workspaces'), EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: native,
    EXTERNAL_CODEX_COMMAND: native, EXTERNAL_CLAUDE_COMMAND: native, EXTERNAL_CODEX_HOME: path.join(root, 'codex'), EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'),
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', LLM_OPENAI_API_KEY: '', LLM_ANTHROPIC_API_KEY: '',
    ORCHESTRATION_ENTRY_MODE: 'execute', ORCHESTRATION_ENABLED_WORKFLOWS: 'routine,analysis_summary,development_review,supervisor_decomposition,bounded_debate',
    ORCHESTRATION_ENABLED_DRIVERS: 'builtin-llm,claude-sdk,codex-app-server', ORCHESTRATION_LEGACY_ENTRY_ENABLED: 'true',
    FAKE_D_LOG: path.join(root, 'native.jsonl'), FAKE_O2_SERVER_ROOT: path.join(repo, 'apps/server') });
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = (url, ...args) => {
    const target = new URL(typeof url === 'object' && url.url ? url.url : String(url));
    if (target.hostname !== '127.0.0.1') { externalRequests++; throw new Error('O7 demo prohibits supplier requests'); }
    return originalFetch(url, ...args);
  };
  const { config } = await import('../../apps/server/src/config.ts');
  if (config.dbPath !== path.join(root, 'demo.sqlite') || config.accounts.privateDir !== path.join(root, 'private')) {
    globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
    throw new Error('O7 演示配置被提前初始化，拒绝打开非本次隔离数据库');
  }
  const database = await import('../../apps/server/src/db/database.ts');
  // Also isolate the platform fs tool root (ordinary config defaults to the business sandbox).
  config.sandboxDir = path.join(root, 'sandbox');
  const registry = await import('../../apps/server/src/agents/registry.ts');
  const { mockProvider } = await import('../../apps/server/src/llm/provider.ts');
  const { createAccount } = await import('../../apps/server/src/accounts/store.ts');
  const { registerExternal } = await import('../../apps/server/src/workspaces/external.ts');
  const { recoverDurableHolds } = await import('../../apps/server/src/runs/recovery.ts');
  const { claimRuntimeHost, releaseRuntimeHost } = await import('../../apps/server/src/execution/host.ts');
  const { shutdownExternalAgents } = await import('../../apps/server/src/execution/runner.ts');
  const { default: Fastify } = await import('../../apps/server/node_modules/fastify/fastify.js');
  const { default: cors } = await import('../../apps/server/node_modules/@fastify/cors/index.js');
  const { default: websocket } = await import('../../apps/server/node_modules/@fastify/websocket/index.js');
  const { registerRoutes } = await import('../../apps/server/src/api/routes.ts');
  const { registerWs } = await import('../../apps/server/src/api/ws.ts');
  const app = Fastify();
  claimRuntimeHost();
  await app.register(cors, { origin: ['http://127.0.0.1:5174', 'http://localhost:5174'] });
  await app.register(websocket);
  await registerRoutes(app); await registerWs(app);
  const role = (id, name, extra = {}) => ({ id, name, description: 'O7 隔离演示，使用模拟模型', systemPrompt: '完成可验收的实际交付，遵守当前任务约束。',
    model: 'mock:' + id, capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#547ac7', avatar: '🤖', ...extra });
  for (const [id, name] of [['aa', '分析员 A'], ['bb', '分析员 B'], ['summary', '汇总者']]) await registry.createAgent(role(id, name));
  await registry.createAgent(role('planner', '主管', { capabilities: ['coordinate', 'execute'] }));
  await registry.createAgent(role('reviewer', '独立评审者', { capabilities: ['review'] }));
  await registry.createAgent(role('writer', '需审批的执行者', { permissionMode: 'confirm', tools: ['fs.read'] }));
  const sdk = createAccount({ displayName: 'O7 模拟 Claude 账户', provider: 'custom', apiKey: 'o7-fixture-not-real', baseUrl: 'http://127.0.0.1:9', protocols: ['anthropic-messages'], models: ['fixture-session'], defaultModel: 'fixture-session' });
  const codex = createAccount({ displayName: 'O7 模拟 Codex 账户', provider: 'custom', apiKey: 'o7-fixture-not-real', baseUrl: 'http://127.0.0.1:9', protocols: ['openai-responses'], models: ['fixture-session'], defaultModel: 'fixture-session' });
  for (const [id, name, driver, accountRef] of [['sdk', 'Claude SDK（模拟）', 'claude-sdk', sdk.id], ['codex', 'Codex（模拟）', 'codex-app-server', codex.id]])
    await registry.createAgent(role(id, name, { model: 'fixture-session', requiresAccount: true, accountRef, execution: { kind: 'external', driver, platformTools: [] } }));
  const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'README.md'), 'O7 demo baseline\n');
  execFileSync('git', ['init', '-q', source]); execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=O7 Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'demo baseline']);
  const workspace = 'ext:' + registerExternal({ path: source, trusted: true }).id;
  const calls = [];
  const respond = (content, toolCalls = []) => ({ content, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn', usage: { tokensIn: 1, tokensOut: 2, costUsd: 0 } });
  mockProvider.chat = async req => {
    const text = req.messages.map(item => item.content).join('\n');
    calls.push({ model: req.model, startedAt: Date.now(), text });
    await new Promise(resolve => setTimeout(resolve, text.includes('O7:pause') ? 650 : 40));
    if (text.includes('O7:failure') && req.model === 'mock:bb') throw new Error('O7 fixture required branch failure');
    if (text.includes('__AGENT_GAND_O4_DAG__')) return respond(JSON.stringify({ tasks: [{ title: '分析接口', body: '只读分析接口', assignee: 'aa', reviewRequired: false, acceptanceCriteria: ['提供分析结论'], blockedBy: [] }] }));
    if (req.model === 'mock:reviewer') return respond(JSON.stringify({ verdict: 'PASS', summary: '已核对当前冻结交付，符合验收要求。', issues: [] }));
    if (req.model === 'mock:writer' && !req.messages.some(item => item.role === 'tool' || item.content.includes('【工具结果】fs.write'))) return respond('', [{ id: 'o7-write', name: 'fs.write', input: JSON.stringify({ path: 'o7-approved.txt', content: 'O7 approved fixture write\n' }) }]);
    if (req.tools?.some(item => item.name === 'agent.complete')) return respond('', [{ id: 'o7-complete', name: 'agent.complete', input: JSON.stringify({ summary: '2 + 2 = 4。已完成只读分析，提供完整的交付结果与验证依据。' }) }]);
    return respond('2 + 2 = 4。已完成只读分析，提供完整的交付结果与验证依据。');
  };
  const timer = setInterval(recoverDurableHolds, 200); timer.unref();
  return { root, app, database, calls, workspace, source, get externalRequests() { return externalRequests; },
    nativeCalls: async () => (await readFile(path.join(root, 'native.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
    close: async () => { clearInterval(timer); await shutdownExternalAgents(); await app.close(); releaseRuntimeHost();
      await new Promise(resolve => setTimeout(resolve, 250)); database.closeDatabase(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); } };
}
