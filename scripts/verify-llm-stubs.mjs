/**
 * §7.3 + §8.5 验收驱动脚本（无需真实 key）
 *
 * 阶段 0：无 key 零回归 —— 干净环境启动 server，pipeline/supervisor 跑通，无降级消息
 * 阶段 1：openai-compatible stub —— 请求体格式（model/tools/messages）、tool_calls 过权限门控（审批）、usage 记账
 * 阶段 2：anthropic stub —— headers、system 独立字段、tool_use 解析、usage 记账
 * 阶段 3：supervisor stub —— 合法 JSON 拆解建任务/认领/完成；非法 JSON fallback + 降级 system message
 * 阶段 4：supervisor worker 的工具调用循环（真机 bug 回归：worker 必须下发 tools）
 * 阶段 5：空正文防御（thinking 模型预算耗尽）
 * 阶段 6：伪调用文本防御（正文写成"[调用工具 fs.read]"）
 * 阶段 7：防误杀（长正文合法含伪调用标记）
 * 阶段 8：§8.1 流式输出 —— WS 捕获 llm.delta，断言顺序/拼接一致/usage 流末块/stop_reason（openai+anthropic）
 * 阶段 9：§8.4 并行工具 —— 一轮 2 个 tool span 时间重叠 + 结果齐回传（openai+anthropic）
 * 阶段 10：§8.3 只读直过 —— confirm 档 fs.read 零审批；auto 档白名单外 deny
 * 阶段 11：§8.2 审批超时 —— 独立 server（APPROVAL_TIMEOUT_MS=2500）超时置 expired 不遗留 pending
 * 阶段 12：R6 混合轮 —— 一轮 2 工具 1 审批 1 直过，单个被拒不连坐
 * 阶段 13：worker-3 的 mock 路由门控用例 —— confirm 只读零审批 / auto 白名单外只读 deny /
 *          disallowed 优先 / mock 路由 expired / approved 回归
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
const SERVER_TIMEOUT_PORT = 3311; // §8.2 超时验证（APPROVAL_TIMEOUT_MS=2500）
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

/** 驱动 run 到终态：遇 awaiting_approval 按给定决策处理（默认 approve；R6 拒绝场景用 reject） */
async function driveRun(base, id, timeoutMs = 60000, decision = 'approve') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await api(base, `/api/runs/${id}`)).data;
    if (d?.run?.status === 'completed') return d;
    if (d?.run?.status === 'failed' || Date.now() > deadline) return null;
    if (d?.run?.status === 'awaiting_approval') {
      const list = (await api(base, '/api/approvals?status=pending')).data ?? [];
      for (const a of list.filter((x) => x.runId === id)) {
        await api(base, `/api/approvals/${a.id}/decide`, 'POST', { decision, by: 'user' });
      }
    }
    await sleep(300);
  }
}

/** WS llm.delta 捕获器（§8.1；Node 22 原生 WebSocket，无需依赖） */
function openDeltaTap(wsBase) {
  const tap = { deltas: [], socket: new WebSocket(`${wsBase}/ws`) };
  tap.ready = new Promise((resolve, reject) => {
    tap.socket.addEventListener('open', () => resolve(), { once: true });
    tap.socket.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true });
  });
  tap.socket.addEventListener('message', (m) => {
    try {
      const ev = JSON.parse(m.data);
      if (ev.type === 'llm.delta') tap.deltas.push(ev);
    } catch {
      // 非 JSON 帧忽略
    }
  });
  return tap;
}

/** 两个 span 的重叠毫秒数（并行执行证据，§8.4） */
function overlapMs(a, b) {
  return Math.min(Date.parse(a.endedAt), Date.parse(b.endedAt)) - Math.max(Date.parse(a.startedAt), Date.parse(b.startedAt));
}

/** 两个 span 的批次墙钟毫秒数（串行时 ≈ 两者时长之和，并行时 ≈ 最长者） */
function wallMs(a, b) {
  return Math.max(Date.parse(a.endedAt), Date.parse(b.endedAt)) - Math.min(Date.parse(a.startedAt), Date.parse(b.startedAt));
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
  // ---- §8 v0.3 ----
  // §8.1 流式：纯文本多分片，断言增量顺序/拼接一致/usage 流末块记账
  'stream-oa.agent.md': `---
name: Stream-OA
description: openai 流式分片验证
model: openai:stub-stream
tools: []
disallowedTools: []
permissionMode: confirm
color: '#3578ff'
---

你是 openai 流式验证用 agent。`,
  'stream-an.agent.md': `---
name: Stream-AN
description: anthropic 流式分片验证
model: anthropic:stub-stream
tools: []
disallowedTools: []
permissionMode: confirm
color: '#25a05a'
---

你是 anthropic 流式验证用 agent。`,
  // §8.4 并行：一轮两个 http.get（读类 auto 白名单直过），断言 span 时间重叠
  'par-oa.agent.md': `---
name: Par-OA
description: openai 并行工具验证
model: openai:stub-parallel
tools: [http.get]
disallowedTools: []
permissionMode: auto
color: '#7c5cff'
---

你是 openai 并行工具验证用 agent。`,
  'par-an.agent.md': `---
name: Par-AN
description: anthropic 并行工具验证
model: anthropic:stub-parallel
tools: [http.get]
disallowedTools: []
permissionMode: auto
color: '#aa55cc'
---

你是 anthropic 并行工具验证用 agent。`,
  // §8.3 只读直过：confirm 档 fs.read 不在白名单 → 直过零审批（fs.write 仍在白名单外供对照）
  'ro-reader.agent.md': `---
name: RO-Reader
description: 只读直过验证（confirm 档 fs.read）
model: openai:stub-ro
tools: [fs.write]
disallowedTools: []
permissionMode: confirm
color: '#55aaaa'
---

你是只读直过验证用 agent。`,
  // §8.3 auto 档白名单外 deny（不是审批）
  'autow-agent.agent.md': `---
name: Autow-Agent
description: auto 档白名单外 deny 验证
model: openai:stub-autow
tools: [fs.read]
disallowedTools: []
permissionMode: auto
color: '#aa7755'
---

你是 auto 档 deny 验证用 agent。`,
  // inspector R6 混合轮：一轮 2 工具 1 审批（fs.write）1 直过（http.get），单个被拒不连坐
  'mixed-agent.agent.md': `---
name: Mixed-Agent
description: 混合轮部分拒绝验证
model: openai:stub-mixed
tools: [http.get]
disallowedTools: []
permissionMode: confirm
color: '#cc5577'
---

你是混合轮验证用 agent。`,
  // §8.2 超时：独立 server（APPROVAL_TIMEOUT_MS=2500）下审批过期置 expired
  'tw-agent.agent.md': `---
name: TW-Agent
description: 审批超时 expired 验证
model: openai:stub-tw
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#ccaa55'
---

你是审批超时验证用 agent。`,
  // ---- worker-3 的 mock 路由门控用例（§8.3 判定顺序全覆盖；mock: 路由零 stub server 改动）----
  // confirm 档只读白名单外 → 直过
  'ro-agent.agent.md': `---
name: RO-Agent
description: confirm 档只读直过（mock 路由）
model: mock:ro
tools: [fs.write]
disallowedTools: []
permissionMode: confirm
color: '#55aa88'
---

你是只读直过验证用 agent。`,
  // auto 档白名单外只读 → deny（只读直过不适用 auto）
  'auto-agent.agent.md': `---
name: Auto-Agent
description: auto 档白名单外只读 deny（mock 路由）
model: mock:auto
tools: [fs.write]
disallowedTools: []
permissionMode: auto
color: '#aa8855'
---

你是 auto 档 deny 验证用 agent。`,
  // disallowedTools 命中只读工具仍 deny（判定顺序第 1 位）
  'dis-agent.agent.md': `---
name: Dis-Agent
description: disallowed 优先级验证（mock 路由）
model: mock:dis
tools: [fs.write]
disallowedTools: [fs.read]
permissionMode: confirm
color: '#aa5588'
---

你是 disallowed 优先级验证用 agent。`,
  // confirm 档写工具白名单外 → 审批（approved / expired 两路径回归）
  'wr-agent.agent.md': `---
name: WR-Agent
description: 写工具审批路径回归（mock 路由）
model: mock:wr
tools: [fs.read]
disallowedTools: []
permissionMode: confirm
color: '#8855aa'
---

你是写工具审批回归用 agent。`,
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
  rmSync(path.join(TMP, 'server-timeout.log'), { force: true });
  rmSync(path.join(TMP, 'stub.log'), { force: true });
  // mock 路由 fs.read 的默认入参文件（worker-3 用例：缺失则 span error，影响 ok 断言）
  writeFileSync(path.join(SANDBOX, 'mock-demo.txt'), 'mock demo file for read');
  // 清理沙箱断言文件
  rmSync(path.join(SANDBOX, 'stub-openai.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-anthropic.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-sup-worker.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-autow-deny.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-mixed.txt'), { force: true });
  rmSync(path.join(SANDBOX, 'stub-tw.txt'), { force: true });

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

    // ---- 阶段 8：§8.1 流式输出（WS 捕获 llm.delta）----
    const STREAM_TEXT = '流式输出演示正文：本句将按片段逐块推送，用于验证增量顺序、拼接一致性与 usage 流末块记账。';
    const tap = openDeltaTap(R1.replace('http', 'ws'));
    await tap.ready;

    const soRun = (await api(R1, '/api/runs', 'POST', { goal: 'openai 流式验证', mode: 'pipeline', agentIds: ['stream-oa'] })).data;
    const soDone = await waitRun(R1, soRun.run.id, 'completed', 30000);
    await sleep(500); // 收尾事件冲刷
    const soDeltas = tap.deltas.filter((d) => d.runId === soRun.run.id);
    const soJoined = soDeltas.map((d) => d.text).join('');
    check('S8a openai 流式增量到达且顺序拼接还原全文', soDeltas.length >= 4 && soJoined === STREAM_TEXT, `${soDeltas.length} 片 / 拼接 ${soJoined.length} 字（期望 ${STREAM_TEXT.length}）`);
    const soLlm = (soDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    check('S8b 增量归属 llm span（spanId 匹配）', soDeltas.length > 0 && soDeltas.every((d) => soLlm.some((s) => s.id === d.spanId)));
    const soUsage = ((await api(R1, '/api/usage')).data ?? []).find((u) => u.runId === soRun.run.id);
    check('S8c usage 流末块记账（130/26，1 轮）', soUsage?.tokensIn === 130 && soUsage?.tokensOut === 26 && soUsage?.llmCalls === 1, JSON.stringify(soUsage));
    check('S8d stop_reason 记入 span output', (soLlm[0]?.output ?? '').includes('[stop_reason=stop]'), (soLlm[0]?.output ?? '').slice(-30));

    const snRun = (await api(R1, '/api/runs', 'POST', { goal: 'anthropic 流式验证', mode: 'pipeline', agentIds: ['stream-an'] })).data;
    const snDone = await waitRun(R1, snRun.run.id, 'completed', 30000);
    await sleep(500);
    const snDeltas = tap.deltas.filter((d) => d.runId === snRun.run.id);
    const snJoined = snDeltas.map((d) => d.text).join('');
    check('S9a anthropic 流式增量到达且顺序拼接还原全文', snDeltas.length >= 4 && snJoined === STREAM_TEXT, `${snDeltas.length} 片 / 拼接 ${snJoined.length} 字`);
    const snLlm = (snDone?.events ?? []).filter((e) => e.spanKind === 'llm');
    check('S9b 增量归属 llm span（spanId 匹配）', snDeltas.length > 0 && snDeltas.every((d) => snLlm.some((s) => s.id === d.spanId)));
    const snUsage = ((await api(R1, '/api/usage')).data ?? []).find((u) => u.runId === snRun.run.id);
    check('S9c usage 双段记账（131/27，1 轮）', snUsage?.tokensIn === 131 && snUsage?.tokensOut === 27 && snUsage?.llmCalls === 1, JSON.stringify(snUsage));
    check('S9d stop_reason 记入 span output', (snLlm[0]?.output ?? '').includes('[stop_reason=end_turn]'), (snLlm[0]?.output ?? '').slice(-30));
    tap.socket.close();

    // ---- 阶段 9：§8.4 并行工具（span 时间重叠）----
    const poRun = (await api(R1, '/api/runs', 'POST', { goal: 'openai 并行工具验证', mode: 'pipeline', agentIds: ['par-oa'] })).data;
    const poDone = await driveRun(R1, poRun.run.id);
    const poSpans = (poDone?.events ?? []).filter((e) => e.spanKind === 'tool' && e.status === 'ok');
    check('S10a openai 一轮 2 个 tool span（http.get ×2，分片重组正确）', poSpans.length === 2 && poSpans.every((s) => s.name === 'tool:http.get'), poSpans.map((s) => s.name).join(','));
    check('S10b tool span 时间重叠（并行执行）', poSpans.length === 2 && overlapMs(poSpans[0], poSpans[1]) >= 150, `overlap=${poSpans.length === 2 ? overlapMs(poSpans[0], poSpans[1]) : -1}ms`);
    check('S10c 批次墙钟 ≤550ms（串行需 650ms+）', poSpans.length === 2 && wallMs(poSpans[0], poSpans[1]) <= 550, `wall=${poSpans.length === 2 ? wallMs(poSpans[0], poSpans[1]) : -1}ms`);
    check('S10d 结果齐回传且最终正文到达', poDone !== null && (poDone?.messages ?? []).some((m) => m.from === 'par-oa' && m.kind === 'agent' && m.body.includes('并行工具轮完成')));

    const pnRun = (await api(R1, '/api/runs', 'POST', { goal: 'anthropic 并行工具验证', mode: 'pipeline', agentIds: ['par-an'] })).data;
    const pnDone = await driveRun(R1, pnRun.run.id);
    const pnSpans = (pnDone?.events ?? []).filter((e) => e.spanKind === 'tool' && e.status === 'ok');
    check('S11a anthropic 一轮 2 个 tool span（input_json_delta 重组正确）', pnSpans.length === 2 && pnSpans.every((s) => s.name === 'tool:http.get'), pnSpans.map((s) => s.name).join(','));
    check('S11b tool span 时间重叠（并行执行）', pnSpans.length === 2 && overlapMs(pnSpans[0], pnSpans[1]) >= 150, `overlap=${pnSpans.length === 2 ? overlapMs(pnSpans[0], pnSpans[1]) : -1}ms`);
    check('S11c 批次墙钟 ≤550ms（串行需 650ms+）', pnSpans.length === 2 && wallMs(pnSpans[0], pnSpans[1]) <= 550, `wall=${pnSpans.length === 2 ? wallMs(pnSpans[0], pnSpans[1]) : -1}ms`);
    check('S11d 结果齐回传且最终正文到达', pnDone !== null && (pnDone?.messages ?? []).some((m) => m.from === 'par-an' && m.kind === 'agent' && m.body.includes('并行工具轮完成')));

    // ---- 阶段 10：§8.3 只读直过 + auto 白名单外 deny ----
    const roRun = (await api(R1, '/api/runs', 'POST', { goal: '只读直过验证', mode: 'pipeline', agentIds: ['ro-reader'] })).data;
    const roDone = await waitRun(R1, roRun.run.id, 'completed', 30000);
    check('S12a confirm 档 fs.read 零审批直过', roDone !== null && (roDone?.approvals ?? []).length === 0, `${(roDone?.approvals ?? []).length} 条审批`);
    check('S12b fs.read tool span ok（直行执行）', (roDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.name === 'tool:fs.read' && e.status === 'ok'));
    check('S12c 读到 S1 写入的文件内容', (roDone?.messages ?? []).some((m) => m.kind === 'tool' && m.body.includes('openai stub 工具写入内容')));

    const awRun = (await api(R1, '/api/runs', 'POST', { goal: 'auto 白名单外 deny 验证', mode: 'pipeline', agentIds: ['autow-agent'] })).data;
    const awDone = await waitRun(R1, awRun.run.id, 'completed', 30000);
    check('S12d auto 档白名单外 deny（无审批卡）', awDone !== null && (awDone?.approvals ?? []).length === 0 && (awDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('被权限门控拒绝')));
    check('S12e 被拒工具未执行（无 stub-autow-deny.txt）', !existsSync(path.join(SANDBOX, 'stub-autow-deny.txt')));

    // ---- 阶段 11：§8.2 审批超时置 expired（独立 server，APPROVAL_TIMEOUT_MS=2500）----
    const R2 = `http://localhost:${SERVER_TIMEOUT_PORT}`;
    procs.push(
      up('npx', ['tsx', 'apps/server/src/index.ts'], makeEnv({
        PORT: String(SERVER_TIMEOUT_PORT),
        DB_PATH: path.join(TMP, 'timeout.sqlite'),
        AGENTS_DIR: path.join(TMP, 'agents'),
        LOG_LEVEL: 'warn',
        LLM_OPENAI_API_KEY: 'stub-key',
        LLM_OPENAI_BASE_URL: STUB,
        LLM_ANTHROPIC_API_KEY: 'stub-key',
        LLM_ANTHROPIC_BASE_URL: STUB,
        APPROVAL_TIMEOUT_MS: '2500',
      }), path.join(TMP, 'server-timeout.log')),
    );
    const health2 = await poll(async () => {
      const r = await api(R2, '/api/health').catch(() => null);
      return r && r.status === 200 ? r.data : null;
    }, 30000);
    check('S13a 超时环境 server 启动', health2?.ok === true, JSON.stringify(health2));
    const twRun = (await api(R2, '/api/runs', 'POST', { goal: '审批超时验证', mode: 'pipeline', agentIds: ['tw-agent'] })).data;
    const twDone = await waitRun(R2, twRun.run.id, 'completed', 30000);
    const twAppr = (twDone?.approvals ?? [])[0];
    check('S13b 超时置 expired（decidedBy=system:timeout）', twAppr?.status === 'expired' && twAppr?.decidedBy === 'system:timeout' && twAppr?.decidedAt !== null, JSON.stringify({ status: twAppr?.status, by: twAppr?.decidedBy }));
    check('S13c 超时按拒绝处理后 run 继续 completed', twDone !== null);
    check('S13d 无遗留 pending', ((await api(R2, '/api/approvals?status=pending')).data ?? []).filter((a) => a.runId === twRun.run.id).length === 0);
    check('S13e 有超时说明 system 消息 + 工具未执行', (twDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('超时')) && !existsSync(path.join(SANDBOX, 'stub-tw.txt')));

    // ---- 阶段 12：R6 混合轮（一轮 2 工具 1 审批 1 直过，单个被拒不连坐）----
    const mxRun = (await api(R1, '/api/runs', 'POST', { goal: '混合轮部分拒绝验证', mode: 'pipeline', agentIds: ['mixed-agent'] })).data;
    const mxApproval = await poll(async () => {
      const list = (await api(R1, '/api/approvals?status=pending')).data ?? [];
      return list.find((a) => a.runId === mxRun.run.id) ?? null;
    }, 20000);
    check('S14a 混合轮 fs.write 审批卡到达', mxApproval !== null && mxApproval.toolName === 'fs.write', mxApproval?.toolName);
    const mxDone = await driveRun(R1, mxRun.run.id, 60000, 'reject');
    check('S14b 拒绝只跳过该工具：http.get 照跑（tool span ok）', (mxDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.name === 'tool:http.get' && e.status === 'ok'));
    check('S14c 被拒工具未执行（无 stub-mixed.txt）', !existsSync(path.join(SANDBOX, 'stub-mixed.txt')));
    check('S14d 拒绝说明 + run completed', mxDone !== null && (mxDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('人工已拒绝')));

    // ---- 阶段 13：worker-3 的 mock 路由门控用例（§8.3 判定顺序全覆盖；编号 S15 避免与其余冲突）----
    const w3aRun = (await api(R1, '/api/runs', 'POST', { goal: '请调用 [tool:fs.read] 读取资料', mode: 'pipeline', agentIds: ['ro-agent'] })).data;
    const w3aDone = await waitRun(R1, w3aRun.run.id, 'completed', 30000);
    check('S15a confirm 档只读 fs.read 零审批直过 + span ok（worker-3）', w3aDone !== null && (w3aDone?.approvals ?? []).length === 0 && (w3aDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.name === 'tool:fs.read' && e.status === 'ok'), `${(w3aDone?.approvals ?? []).length} 审批`);

    const w3bRun = (await api(R1, '/api/runs', 'POST', { goal: '请调用 [tool:fs.read] 读取资料', mode: 'pipeline', agentIds: ['auto-agent'] })).data;
    const w3bDone = await waitRun(R1, w3bRun.run.id, 'completed', 30000);
    check('S15b auto 档白名单外只读 deny：零审批零 tool span + system 说明（worker-3）', w3bDone !== null && (w3bDone?.approvals ?? []).length === 0 && !(w3bDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.status === 'ok') && (w3bDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('权限门控拒绝')));

    const w3cRun = (await api(R1, '/api/runs', 'POST', { goal: '请调用 [tool:fs.read] 读取资料', mode: 'pipeline', agentIds: ['dis-agent'] })).data;
    const w3cDone = await waitRun(R1, w3cRun.run.id, 'completed', 30000);
    check('S15c disallowed 命中只读工具仍 deny（判定顺序第 1 位，worker-3）', w3cDone !== null && (w3cDone?.approvals ?? []).length === 0 && (w3cDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('disallowedTools')));

    // S15d expired（mock 路由，复用 R2 超时 server）：不批准 → 2.5s 过期
    const w3dRun = (await api(R2, '/api/runs', 'POST', { goal: '请调用 [tool:fs.write] 写入文件', mode: 'pipeline', agentIds: ['wr-agent'] })).data;
    const w3dDone = await waitRun(R2, w3dRun.run.id, 'completed', 30000);
    const w3dAppr = (w3dDone?.approvals ?? [])[0];
    check('S15d mock 路由超时 expired 全链路（worker-3）', w3dAppr?.status === 'expired' && w3dAppr?.decidedBy === 'system:timeout' && w3dDone !== null && !(w3dDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.name === 'tool:fs.write' && e.status === 'ok') && (w3dDone?.messages ?? []).some((m) => m.kind === 'system' && m.body.includes('超时')), JSON.stringify({ status: w3dAppr?.status, by: w3dAppr?.decidedBy }));

    // S15e approved 回归：及时批准 → 执行成功
    const w3eRun = (await api(R1, '/api/runs', 'POST', { goal: '请调用 [tool:fs.write] 写入文件', mode: 'pipeline', agentIds: ['wr-agent'] })).data;
    const w3eDone = await driveRun(R1, w3eRun.run.id);
    check('S15e approved 回归：tool:fs.write span ok + completed（worker-3）', w3eDone !== null && (w3eDone?.events ?? []).some((e) => e.spanKind === 'tool' && e.name === 'tool:fs.write' && e.status === 'ok'));
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
