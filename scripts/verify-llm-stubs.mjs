/**
 * §7.3 验收驱动脚本（无需真实 key）
 *
 * 阶段 0：无 key 零回归 —— 干净环境启动 server，pipeline/supervisor 跑通，无降级消息
 * 阶段 1：openai-compatible stub —— 请求体格式（model/tools/messages）、tool_calls 过权限门控（审批）、usage 记账
 * 阶段 2：anthropic stub —— headers、system 独立字段、tool_use 解析、usage 记账
 * 阶段 3：supervisor stub —— 合法 JSON 拆解建任务/认领/完成；非法 JSON fallback + 降级 system message
 *
 * 用法：node scripts/verify-llm-stubs.mjs
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const TMP = '/tmp/gand-llm-verify';
const STUB_PORT = 3999;
const SERVER_REGRESS_PORT = 3309;
const SERVER_STUB_PORT = 3310;
const SANDBOX = path.join(REPO, 'apps/server/data/sandbox');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs = 30000, interval = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
}
async function api(base, p, method = 'GET', body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}
async function waitRun(base, id, expect = 'completed', timeoutMs = 30000) {
  return poll(async () => {
    const d = (await api(base, `/api/runs/${id}`)).data;
    return d?.run?.status === expect ? d : null;
  }, timeoutMs);
}

/** 驱动 run 到终态：遇 awaiting_approval 自动 approve（多任务/多轮工具会多次触发审批） */
async function driveRun(base, id, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await api(base, `/api/runs/${id}`)).data;
    if (d?.run?.status === 'completed') return d;
    if (d?.run?.status === 'failed' || Date.now() > deadline) return null;
    if (d?.run?.status === 'awaiting_approval') {
      const list = (await api(base, '/api/approvals?status=pending')).data ?? [];
      for (const a of list.filter((x) => x.runId === id)) {
        await api(base, `/api/approvals/${a.id}/decide`, 'POST', { decision: 'approve', by: 'user' });
      }
    }
    await sleep(300);
  }
}

/** 起一个子进程（日志落盘，失败时可 tail） */
function up(cmd, args, env, logFile) {
  const log = (chunk) => appendLog(logFile, chunk);
  const child = spawn(cmd, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  return child;
}
const logStreams = new Map();
function appendLog(file, chunk) {
  const entry = logStreams.get(file) ?? { first: true };
  const prefix = entry.first ? `\n===== ${new Date().toISOString()} =====\n` : '';
  entry.first = false;
  logStreams.set(file, entry);
  writeFileSync(file, prefix + chunk.toString(), { flag: 'a' });
}

/** 干净 env（可剔除 LLM_*，可覆盖） */
function makeEnv(overrides, { stripLlm = false } = {}) {
  const env = { ...process.env };
  if (stripLlm) {
    for (const k of Object.keys(env)) if (k.startsWith('LLM_')) delete env[k];
  }
  return { ...env, ...overrides };
}

/** S0 无 key 回归用的纯 mock agent（仓库 agents/ 可能已指向真实模型 + .env 带真实 key） */
const mockAgentDefs = {
  'planner.agent.md': `---
name: Planner
description: mock 回归用规划者
model: mock:planner
tools: [fs.read, search.files]
permissionMode: readonly
color: '#7c5cff'
---

你是回归验证用的规划者。`,
  'coder.agent.md': `---
name: Coder
description: mock 回归用执行者
model: mock:coder
tools: [fs.read, fs.write]
permissionMode: confirm
color: '#2f9e6e'
---

你是回归验证用的执行者。`,
  'reviewer.agent.md': `---
name: Reviewer
description: mock 回归用检查者
model: mock:reviewer
tools: [fs.read]
permissionMode: auto
color: '#e0a13c'
---

你是回归验证用的检查者。`,
};

const stubAgentDefs = {
  // openai 路由 + confirm + fs.write 不在白名单 → need_approval（验收门控）
  'oa-planner.agent.md': `---
name: OA-Planner
description: openai stub 验证用规划者
model: openai:stub-gpt
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#3578ff'
---

你是 openai stub 验证用的规划者。`,
  // anthropic 路由 + auto + fs.write 在白名单 → 直过
  'an-coder.agent.md': `---
name: AN-Coder
description: anthropic stub 验证用执行者
model: anthropic:stub-claude
tools: [fs.write]
disallowedTools: []
permissionMode: auto
color: '#25a05a'
---

你是 anthropic stub 验证用的执行者。`,
  // supervisor 用 openai stub 做结构化拆解；worker 为 mock
  'sup-leader.agent.md': `---
name: Sup-Leader
description: 结构化拆解验证用主管
model: openai:stub-gpt
tools: []
disallowedTools: []
permissionMode: confirm
color: '#7c5cff'
---

你是结构化拆解验证用的主管。`,
  'sup-w1.agent.md': `---
name: Sup-W1
description: 结构化拆解验证用工人1
model: mock:w1
tools: []
disallowedTools: []
permissionMode: confirm
color: '#888888'
---

你是工人 1。`,
  'sup-w2.agent.md': `---
name: Sup-W2
description: 结构化拆解验证用工人2
model: mock:w2
tools: []
disallowedTools: []
permissionMode: confirm
color: '#999999'
---

你是工人 2。`,
  // supervisor worker 工具路径验证：openai worker 模型 + confirm + fs.write 不在白名单 → 审批
  'sworker1.agent.md': `---
name: SWorker1
description: supervisor 工具路径验证用工人
model: openai:stub-gpt-worker
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#aa7755'
---

你是 supervisor 工具路径验证用的工人。`,
  // 空正文防御验证：soft（nudge 后恢复）与 hard（重试后仍空，走兜底）
  'poet-soft.agent.md': `---
name: Poet-Soft
description: 空正文软模式验证（nudge 后恢复）
model: openai:stub-empty
tools: []
disallowedTools: []
permissionMode: confirm
color: '#55aaaa'
---

你是空正文软模式验证用诗人。`,
  'poet-hard.agent.md': `---
name: Poet-Hard
description: 空正文硬模式验证（重试后仍空）
model: openai:stub-empty-hard
tools: []
disallowedTools: []
permissionMode: confirm
color: '#aa5555'
---

你是空正文硬模式验证用诗人。`,
  // 伪调用文本验证（run c674d39e 形态：正文写成"[调用工具 fs.read]"）
  'review-pseudo.agent.md': `---
name: Review-Pseudo
description: 伪调用文本验证（nudge 后产出真实正文）
model: openai:stub-pseudo
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#5577cc'
---

你是伪调用文本验证用审查者。`,
  // 防误杀验证：长结论中合法提及伪调用标记，不得被启发式判为空正文
  'mention-agent.agent.md': `---
name: Mention-Agent
description: 防误杀验证（正文合法含标记）
model: openai:stub-mention
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#66aa66'
---

你是防误杀验证用审查者。`,
};

async function main() {
  // ---- 准备临时目录（独立 mock agents 目录 + stub agents 目录，避免依赖仓库当前 agents 配置）----
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(path.join(TMP, 'mock-agents'), { recursive: true });
  for (const [file, content] of Object.entries(mockAgentDefs)) {
    writeFileSync(path.join(TMP, 'mock-agents', file), content);
  }
  mkdirSync(path.join(TMP, 'agents'), { recursive: true });
  for (const [file, content] of Object.entries(stubAgentDefs)) {
    writeFileSync(path.join(TMP, 'agents', file), content);
  }
  rmSync(path.join(TMP, 'server-regress.log'), { force: true });
  rmSync(path.join(TMP, 'server-stub.log'), { force: true });
  rmSync(path.join(TMP, 'stub.log'), { force: true });
  // 清理沙箱断言文件
  rmSync(path.join(SANDBOX, 'stub-openai.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-anthropic.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-sup-worker.txt'), { force: true });

  const procs = [];
  try {
    // ---- 阶段 0：无 key 零回归 ----
    const R0 = `http://localhost:${SERVER_REGRESS_PORT}`;
    procs.push(
      up('npx', ['tsx', 'apps/server/src/index.ts'], makeEnv(
        {
          PORT: String(SERVER_REGRESS_PORT),
          DB_PATH: path.join(TMP, 'regress.sqlite'),
          AGENTS_DIR: path.join(TMP, 'mock-agents'),
          LOG_LEVEL: 'warn',
        },
        { stripLlm: true },
      ), path.join(TMP, 'server-regress.log')),
    );
    const health0 = await poll(async () => {
      const r = await api(R0, '/api/health').catch(() => null);
      return r && r.status === 200 ? r.data : null;
    }, 30000);
    check('S0a 无 key 启动 health ok + agents=3', health0?.ok === true && health0?.agents === 3, JSON.stringify(health0));
    const pipeRun = (await api(R0, '/api/runs', 'POST', { goal: '演示', mode: 'pipeline', agentIds: ['planner', 'coder', 'reviewer'] })).data;
    const pipeDone = await waitRun(R0, pipeRun.run.id);
    check('S0b 无 key pipeline run completed', pipeDone !== null);
    const supRun = (await api(R0, '/api/runs', 'POST', { goal: '无 key 主管模式回归验证', mode: 'supervisor', agentIds: ['planner', 'coder', 'reviewer'] })).data;
    const supDone = await waitRun(R0, supRun.run.id, 'completed', 60000);
    check('S0c 无 key supervisor run completed', supDone !== null);
    check('S0d mock supervisor 无降级消息（零回归）', !(supDone?.messages ?? []).some((m) => m.body.includes('降级')));

    // ---- 起 stub LLM 端点 ----
    procs.push(up('node', ['scripts/llm-stub-server.mjs', String(STUB_PORT)], makeEnv({}), path.join(TMP, 'stub.log')));
    const STUB = `http://127.0.0.1:${STUB_PORT}`;
    const stubUp = await poll(async () => (await api(STUB, '/__inspect').catch(() => null)) !== null, 15000);
    check('S1a llm-stub-server 就绪', stubUp === true);

    // ---- 起 stub 环境的 server ----
    const R1 = `http://localhost:${SERVER_STUB_PORT}`;
    procs.push(
      up('npx', ['tsx', 'apps/server/src/index.ts'], makeEnv({
        PORT: String(SERVER_STUB_PORT),
        DB_PATH: path.join(TMP, 'stub.sqlite'),
        AGENTS_DIR: path.join(TMP, 'agents'),
        LOG_LEVEL: 'warn',
        LLM_OPENAI_API_KEY: 'stub-key',
        LLM_OPENAI_BASE_URL: STUB,
        LLM_ANTHROPIC_API_KEY: 'stub-key',
        LLM_ANTHROPIC_BASE_URL: STUB,
      }), path.join(TMP, 'server-stub.log')),
    );
    const health1 = await poll(async () => {
      const r = await api(R1, '/api/health').catch(() => null);
      return r && r.status === 200 ? r.data : null;
    }, 30000);
    check('S1b stub 环境启动 health ok', health1?.ok === true, JSON.stringify(health1));

    // ---- 阶段 1：openai-compatible stub ----
    const oaRun = (await api(R1, '/api/runs', 'POST', { goal: 'openai stub 验证', mode: 'pipeline', agentIds: ['oa-planner'] })).data;
    const oaApproval = await poll(async () => {
      const list = (await api(R1, '/api/approvals?status=pending')).data ?? [];
      return list.find((a) => a.runId === oaRun.run.id) ?? null;
    }, 20000);
    check('S1c tool_calls 触发审批（confirm 门控）', oaApproval !== null && oaApproval.toolName === 'fs.write', oaApproval?.toolName);
    const oaDone = await driveRun(R1, oaRun.run.id);
    check('S1d openai pipeline run completed', oaDone !== null);
    const oaUsage = ((await api(R1, '/api/usage')).data ?? []).find((u) => u.runId === oaRun.run.id);
    // 工具循环：round0（tool_calls）+ round1（工具结果回传后收尾）→ 2 次 llm 调用
    check('S1e usage 从 stub 响应记账（222/44，2 轮）', oaUsage?.tokensIn === 222 && oaUsage?.tokensOut === 44 && oaUsage?.llmCalls === 2, JSON.stringify(oaUsage));
    check('S1f 工具已执行（沙箱 stub-openai.txt）', existsSync(path.join(SANDBOX, 'stub-openai.txt')), existsSync(path.join(SANDBOX, 'stub-openai.txt')) ? readFileSync(path.join(SANDBOX, 'stub-openai.txt'), 'utf-8') : 'missing');
    const insp1 = (await api(STUB, '/__inspect')).data;
    const oaBody = insp1.lastOpenAI?.body ?? {};
    check('S1g 请求体 model 去前缀（stub-gpt）', oaBody.model === 'stub-gpt', oaBody.model);
    check('S1h 请求体 messages[0] 为 system', Array.isArray(oaBody.messages) && oaBody.messages[0]?.role === 'system');
    check('S1i 请求体含工具 schema（fs.read）', Array.isArray(oaBody.tools) && oaBody.tools.some((t) => t.function?.name === 'fs.read'));
    check('S1j 请求头 Bearer 鉴权', insp1.lastOpenAI?.headers?.authorization === 'Bearer stub-key');

    // ---- 阶段 2：anthropic stub ----
    const anRun = (await api(R1, '/api/runs', 'POST', { goal: 'anthropic stub 验证', mode: 'pipeline', agentIds: ['an-coder'] })).data;
    const anDone = await waitRun(R1, anRun.run.id);
    check('S2a anthropic pipeline run completed（auto 白名单直过）', anDone !== null && (anDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.status === 'ok'));
    const anUsage = ((await api(R1, '/api/usage')).data ?? []).find((u) => u.runId === anRun.run.id);
    check('S2b usage 从 stub 响应记账（154/66，2 轮）', anUsage?.tokensIn === 154 && anUsage?.tokensOut === 66 && anUsage?.llmCalls === 2, JSON.stringify(anUsage));
    check('S2c 工具已执行（沙箱 stub-anthropic.txt）', existsSync(path.join(SANDBOX, 'stub-anthropic.txt')));
    const insp2 = (await api(STUB, '/__inspect')).data;
    const anBody = insp2.lastAnthropic?.body ?? {};
    check('S2d 请求头 x-api-key + anthropic-version', insp2.lastAnthropic?.headers?.['x-api-key'] === 'stub-key' && insp2.lastAnthropic?.headers?.['anthropic-version'] === '2023-06-01');
    check('S2e system 独立字段且为字符串', typeof anBody.system === 'string' && anBody.system.length > 0);
    check('S2f messages 不含 system 角色', Array.isArray(anBody.messages) && anBody.messages.every((m) => m.role !== 'system'));
    check('S2g 含 tools（input_schema）', Array.isArray(anBody.tools) && anBody.tools.some((t) => t.name === 'fs.write' && t.input_schema));

    // ---- 阶段 3：supervisor 结构化拆解 ----
    const gRun = (await api(R1, '/api/runs', 'POST', { goal: 'stub 结构化拆解验证', mode: 'supervisor', agentIds: ['sup-leader', 'sup-w1', 'sup-w2'] })).data;
    const gDone = await waitRun(R1, gRun.run.id, 'completed', 60000);
    const gTasks = gDone?.tasks ?? [];
    check('S3a 合法 JSON → 创建 3 条任务且全部 completed', gTasks.length === 3 && gTasks.every((t) => t.status === 'completed'), gTasks.map((t) => t.title).join(' | '));
    const gA = gTasks.find((t) => t.title.includes('任务A'));
    const gB = gTasks.find((t) => t.title.includes('任务B'));
    const gC = gTasks.find((t) => t.title.includes('任务C'));
    check('S3b assignee 按 JSON 指派', gA?.assignee === 'sup-w1' && gB?.assignee === 'sup-w2' && gC?.assignee === 'sup-w1', `${gA?.assignee}/${gB?.assignee}/${gC?.assignee}`);
    check('S3c blockedBy 标题引用解析为 id', gB?.blockedBy?.length === 1 && gB.blockedBy[0] === gA?.id);
    check('S3c2 空 blockedBy 的结构化任务无前驱（P3a 回归）', Array.isArray(gC?.blockedBy) && gC.blockedBy.length === 0 && Array.isArray(gA?.blockedBy) && gA.blockedBy.length === 0, JSON.stringify(gC?.blockedBy));
    check('S3d 无降级消息', !(gDone?.messages ?? []).some((m) => m.body.includes('降级')));

    const bRun = (await api(R1, '/api/runs', 'POST', { goal: 'BADJSON 非法拆解降级验证', mode: 'supervisor', agentIds: ['sup-leader', 'sup-w1', 'sup-w2'] })).data;
    const bDone = await waitRun(R1, bRun.run.id, 'completed', 60000);
    check('S3e 非法 JSON → fallback mock 拆解仍完成', (bDone?.tasks ?? []).length >= 2 && bDone.tasks.every((t) => t.status === 'completed'), bDone?.tasks?.map((t) => t.title.slice(0, 8)).join(' | '));
    check('S3f 降级 system message 存在', (bDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('降级')));

    // ---- 阶段 4：supervisor worker 的工具调用循环（真机 bug 回归：worker 必须下发 tools）----
    const wRun = (await api(R1, '/api/runs', 'POST', { goal: 'supervisor worker 工具循环验证', mode: 'supervisor', agentIds: ['sup-leader', 'sworker1'] })).data;
    const wApproval = await poll(async () => {
      const list = (await api(R1, '/api/approvals?status=pending')).data ?? [];
      return list.find((a) => a.runId === wRun.run.id) ?? null;
    }, 20000);
    check('S4a worker 工具调用触发审批（confirm 门控）', wApproval !== null && wApproval.toolName === 'fs.write' && wApproval.agentId === 'sworker1', `${wApproval?.agentId}/${wApproval?.toolName}`);
    const wDone = await driveRun(R1, wRun.run.id, 60000);
    check('S4b supervisor run completed（工具循环后）', wDone !== null);
    check('S4c 工具已执行（沙箱 stub-sup-worker.txt）', existsSync(path.join(SANDBOX, 'stub-sup-worker.txt')), existsSync(path.join(SANDBOX, 'stub-sup-worker.txt')) ? readFileSync(path.join(SANDBOX, 'stub-sup-worker.txt'), 'utf-8') : 'missing');
    const wToolSpans = (wDone?.events ?? []).filter((e) => e.spanKind === 'tool');
    check('S4d run events 有 ok 的 tool span', wToolSpans.some((e) => e.status === 'ok'));
    const wLlmSpans = (wDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    const workerLlmHasTools = wLlmSpans.some((e) => {
      try { return (JSON.parse(e.input ?? '{}').tools ?? []).includes('fs.read'); } catch { return false; }
    });
    check('S4e llm span input 记录了 tools 名单（③）', workerLlmHasTools, wLlmSpans.map((e) => e.input?.slice(0, 60)).join(' · '));
    check('S4f 任务全部 completed', (wDone?.tasks ?? []).length >= 2 && wDone.tasks.every((t) => t.status === 'completed'));

    // ---- 阶段 5：空正文防御（thinking 模型预算耗尽）----
    const pRun = (await api(R1, '/api/runs', 'POST', { goal: '写一首唐诗', mode: 'pipeline', agentIds: ['poet-soft'] })).data;
    const pDone = await waitRun(R1, pRun.run.id, 'completed', 30000);
    check('S5a 空正文→nudge→重试恢复（run completed）', pDone !== null);
    const pAgentMsgs = (pDone?.messages ?? []).filter((m) => m.from === 'poet-soft' && m.kind === 'agent');
    check('S5b 最终 agent 消息非空', pAgentMsgs.length > 0 && pAgentMsgs.every((m) => m.body.trim().length > 0), `${pAgentMsgs.length} 条`);
    const pLlm = (pDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    check('S5c llm span 记录 stop_reason（②）', pLlm.some((e) => (e.output ?? '').includes('[stop_reason=max_tokens]')), pLlm.map((e) => (e.output ?? '').slice(-30)).join(' · '));
    check('S5d 第二次调用 input 含 nudge', pLlm.length === 2 && (pLlm[1]?.input ?? '').includes('请直接输出结论正文'));

    const hRun = (await api(R1, '/api/runs', 'POST', { goal: '写一首唐诗（硬模式）', mode: 'pipeline', agentIds: ['poet-hard'] })).data;
    const hDone = await waitRun(R1, hRun.run.id, 'completed', 30000);
    check('S5e 重试后仍空 → run completed 但 agent span error', hDone !== null && (hDone?.events ?? []).some((e) => e.spanKind === 'agent' && e.status === 'error'));
    check('S5f 无空 agent 消息 + 有 system 失败说明', (hDone?.messages ?? []).every((m) => !(m.from === 'poet-hard' && m.kind === 'agent' && m.body.trim().length === 0)) && (hDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('空正文')));

    // ---- 阶段 6：伪调用文本防御（正文写成"[调用工具 fs.read]"）----
    const sRun = (await api(R1, '/api/runs', 'POST', { goal: '审查草稿', mode: 'pipeline', agentIds: ['review-pseudo'] })).data;
    const sDone = await waitRun(R1, sRun.run.id, 'completed', 30000);
    check('S6a 伪调用文本→nudge→真实正文（run completed）', sDone !== null);
    const sAgentMsgs = (sDone?.messages ?? []).filter((m) => m.from === 'review-pseudo' && m.kind === 'agent');
    check('S6b 最终 agent 消息为真实正文（非伪调用标记）', sAgentMsgs.length > 0 && sAgentMsgs.every((m) => !/^\[?(?:调用工具|使用工具|tool[:：])/m.test(m.body.trim()) && m.body.trim().length > 0), sAgentMsgs[0]?.body?.slice(0, 40));
    const sLlm = (sDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    check('S6c 两次调用且第二次 input 含 nudge', sLlm.length === 2 && (sLlm[1]?.input ?? '').includes('请直接输出结论正文'));
    check('S6d 首次 llm span output 标注伪调用重试', (sLlm[0]?.output ?? '').includes('nudge'));

    // ---- 阶段 7：防误杀（长正文合法含伪调用标记）----
    const mRun = (await api(R1, '/api/runs', 'POST', { goal: '防误杀验证', mode: 'pipeline', agentIds: ['mention-agent'] })).data;
    const mDone = await waitRun(R1, mRun.run.id, 'completed', 30000);
    check('S7a 含标记的长结论正常发布（run completed）', mDone !== null);
    const mAgentMsgs = (mDone?.messages ?? []).filter((m) => m.from === 'mention-agent' && m.kind === 'agent');
    check('S7b 正文原样发布（含标记且非空）', mAgentMsgs.length === 1 && mAgentMsgs[0].body.includes('[调用工具 fs.read]') && mAgentMsgs[0].body.includes('PASS'), mAgentMsgs[0]?.body?.slice(0, 30));
    const mLlm = (mDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    check('S7c 未触发 nudge 重试（仅 1 次 llm 调用）', mLlm.length === 1, `llm=${mLlm.length}`);
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await sleep(500);
    for (const p of procs) if (!p.killed) p.kill('SIGKILL');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log('失败项:');
    for (const f of failed) console.log('  ✗ ' + f.name);
    console.log(`日志: ${TMP}/`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('驱动脚本异常:', err);
  process.exitCode = 1;
});
