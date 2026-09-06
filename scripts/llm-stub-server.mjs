/**
 * 本地 LLM stub 端点（规格 §7.3.2/3/4 + §8.1/8.4 验收用，无真实 key）
 *
 * 一个 HTTP 服务同时模拟两种 API：
 *   POST /chat/completions   → openai-compatible 响应（含 tool_calls + usage）
 *   POST /v1/messages        → anthropic 响应（含 tool_use block + usage）
 *   GET  /__inspect          → 返回最近一次捕获的请求（body + 关键 headers），供断言
 *   GET  /__slow?ms=N        → 延迟 N 毫秒后响应（并行工具 span 重叠证据用，§8.4）
 *
 * 行为由请求内容确定性切换：
 *   - user 消息含「严格只输出 JSON」标记 → supervisor 结构化拆解：返回 JSON tasks
 *     （goal 含 BADJSON 时返回非法 JSON，用于 fallback 验证）
 *   - 模型名含 stub-stream / stub-parallel / stub-ro / stub-autow / stub-mixed / stub-tw
 *   - 模型名含 stub-fs（§9 S16）：goal 携带 FSOP:W/R/S/PWD 指令驱动路径工具
 *     → §8 各专项形态（流式分片 / 并行双工具 / 只读直过 / auto 拒绝 / 混合轮 / 超时）
 *   - 其余 → 返回演示文案 + 一个 fs.write 工具调用（openai: tool_calls；anthropic: tool_use）
 *
 * 流式（§8.1）：请求体 stream:true 时以 SSE 分片响应——
 *   openai 形状：delta.content 片段 + tool_calls[index] 分片（name 与 arguments 都跨片，R3）
 *               + finish_reason + usage 末块 + [DONE]
 *   anthropic 形状：message_start(usage) + text 块 text_delta 片段
 *               + tool_use 块 input_json_delta 原始字符串分片（R1）+ message_delta(stop_reason/usage)
 *
 * 用法：node scripts/llm-stub-server.mjs [port]   # 默认 3999
 */
import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '3999', 10);
const SLOW_BASE = `http://127.0.0.1:${port}`;

/** 结构化拆解的 stub 任务（assignee 对应 verify 脚本里的 sup-w1/sup-w2）。
 *  任务C 故意不带 blockedBy：验证结构化任务空依赖不会被误挂前驱（inspector-2 P3a 回归用例） */
const STUB_TASKS = {
  tasks: [
    { title: 'stub 任务A', body: '由 stub 结构化拆解生成', assignee: 'sup-w1' },
    { title: 'stub 任务B', body: '依赖任务A', assignee: 'sup-w2', blockedBy: ['stub 任务A'] },
    { title: 'stub 任务C', body: '与A并行，无依赖', assignee: 'sup-w1' },
  ],
};

const state = {
  lastOpenAI: null, // { headers, body }
  lastAnthropic: null,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** 提取全部消息文本（判定模式用） */
function allText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  return msgs.map((m) => String(m.content ?? '')).join('\n');
}

/** 从结构化拆解 prompt 中解析团队成员 id（"- <id>：描述" 行），assignee 动态重映射 */
function rosterIds(body) {
  const ids = [...allText(body).matchAll(/^- (\S+?)：/gm)].map((m) => m[1]);
  return ids.length > 0 ? ids : ['sup-w1', 'sup-w2'];
}

function isDecompose(body) {
  return allText(body).includes('严格只输出 JSON');
}

/** 已有工具结果回传（【工具结果】标记）→ 本轮不再返回 tool_calls（模拟"用完工具就收尾"） */
function hasToolResult(body) {
  return allText(body).includes('【工具结果】');
}

function isBadJsonGoal(body) {
  return allText(body).includes('BADJSON');
}

/** 空正文模式（§空正文防御验证）：
 *  - 模型含 'stub-empty'：默认返回空正文 + finish_reason=max_tokens；
 *    注入 nudge（'请直接输出结论正文'）后返回正常正文（模拟 thinking 预算耗尽后被引导恢复）
 *  - 模型含 'stub-empty-hard'：永远空正文（验证重试后失败的兜底路径）
 *  - 模型含 'stub-pseudo'：默认返回伪调用文本 '[调用工具 fs.read]'（run c674d39e 实证形态）；
 *    nudge 后返回正常正文（验证伪调用判定→nudge→真实正文） */
function emptyMode(body) {
  const model = String(body.model ?? '');
  if (model.includes('stub-empty-hard')) return 'hard';
  if (model.includes('stub-empty')) return 'soft';
  if (model.includes('stub-pseudo')) return 'pseudo';
  if (model.includes('stub-mention')) return 'mention';
  return null;
}

function hasNudge(body) {
  return allText(body).includes('请直接输出结论正文');
}

/** §9 S16：goal 携带 FSOP 指令驱动任意路径工具调用（隔离/shared/archive/逃逸/cwd 用例）
 *  W:path::content → fs.write；R:path → fs.read；S:pattern → search.files；PWD → shell.run pwd */
function fsopFor(body) {
  const text = allText(body);
  const w = /FSOP:W:([^:\s]+)::(.*)$/m.exec(text);
  if (w) return { id: 'call_fs_w', name: 'fs.write', input: { path: w[1], content: w[2] } };
  const r = /FSOP:R:(\S+)/.exec(text);
  if (r) return { id: 'call_fs_r', name: 'fs.read', input: { path: r[1] } };
  const s = /FSOP:S:(\S+)/.exec(text);
  if (s) return { id: 'call_fs_s', name: 'search.files', input: { pattern: s[1] } };
  if (/FSOP:PWD/.test(text)) return { id: 'call_fs_pwd', name: 'shell.run', input: { cmd: 'pwd' } };
  return null;
}

/** 演示文案 + fs.write 工具调用（两种 API 各自的形状与文件名，便于分别断言） */
const DEMO_TEXT = '【llm-stub】已处理目标（stub 响应）';
const TOOL_WRITE_OPENAI = { path: 'stub-openai.txt', content: 'openai stub 工具写入内容' };
const TOOL_WRITE_ANTHROPIC = { path: 'stub-anthropic.txt', content: 'anthropic stub 工具写入内容' };
const TOOL_WRITE_WORKER = { path: 'stub-sup-worker.txt', content: 'supervisor worker stub 工具写入内容' };
/** 防误杀用例正文：合法地在长结论中提及伪调用标记（不得被启发式误判为空正文） */
const LEGIT_MENTION_TEXT =
  '审查结论：PASS。备注：过程中模型曾试图[调用工具 fs.read]，已被权限门控正确处理；产物内容完整、逻辑清晰，无需修改，建议归档。';
/** §8.1 流式专用正文：分片由序列化器切，verify 断言拼接相等 */
const STREAM_TEXT = '流式输出演示正文：本句将按片段逐块推送，用于验证增量顺序、拼接一致性与 usage 流末块记账。';
const PARALLEL_DONE_TEXT = '并行工具轮完成：两个慢速 http.get 均已返回，且执行时间重叠。';
const RO_DONE_TEXT = '只读直过验证完成：confirm 档的 fs.read 未经审批直接执行并读到内容。';
const AUTOW_DONE_TEXT = 'auto 档白名单外工具已按 deny 处理，流程继续。';
const MIXED_DONE_TEXT = '混合轮完成：只读 http.get 直过执行，写类工具走审批。';
const TW_DONE_TEXT = '审批超时（expired）后按拒绝处理，流程继续。';

/** 本轮要返回的工具调用（结构化；序列化器负责分片形状）。
 *  hasToolResult 后一律收尾（无工具）。 */
function toolCallsFor(body, isOpenAI) {
  if (isDecompose(body) || hasToolResult(body) || emptyMode(body)) return [];
  const model = String(body.model ?? '');
  if (model.includes('stub-parallel')) {
    // §8.4：一轮两个工具调用（读类直过，verify 断言 span 时间重叠）
    return [
      { id: 'call_slow_a', name: 'http.get', input: { url: `${SLOW_BASE}/__slow?ms=300` } },
      { id: 'call_slow_b', name: 'http.get', input: { url: `${SLOW_BASE}/__slow?ms=350` } },
    ];
  }
  if (model.includes('stub-ro')) {
    // §8.3：confirm 档 fs.read → 只读直过（不建审批）。
    // §9 后跨 run 读 S1 的文件不再可能——改读 shared/ 预置文件（verify setup 落盘）
    return [{ id: 'call_ro_read', name: 'fs.read', input: { path: 'shared/stub-ro-shared.txt' } }];
  }
  if (model.includes('stub-autow')) {
    // §8.3：auto 档白名单外写类 → deny（不是审批）
    return [{ id: 'call_autow', name: 'fs.write', input: { path: 'stub-autow-deny.txt', content: '不应写入' } }];
  }
  if (model.includes('stub-mixed')) {
    // inspector R6：一轮 2 工具 1 审批 1 直过——单个被拒不连坐
    return [
      { id: 'call_mixed_write', name: 'fs.write', input: { path: 'stub-mixed.txt', content: '混合轮写入' } },
      { id: 'call_mixed_get', name: 'http.get', input: { url: `${SLOW_BASE}/__slow?ms=250` } },
    ];
  }
  if (model.includes('stub-tw')) {
    // §8.2：审批超时路径（verify 用 APPROVAL_TIMEOUT_MS 调小的独立 server）
    return [{ id: 'call_tw', name: 'fs.write', input: { path: 'stub-tw.txt', content: '超时前不应写入' } }];
  }
  if (model.includes('stub-fs')) {
    // §9 S16：FSOP 指令驱动的路径工具调用（每 run 一个操作，单对象包成数组）
    const op = fsopFor(body);
    return op === null ? [] : [op];
  }
  if (model.includes('stub-stream')) return []; // 流式专项：纯文本
  if (isOpenAI) {
    // worker 模型（stub-gpt-worker）单独落一个沙箱文件，供 supervisor 工具路径断言
    const isWorkerModel = model.includes('worker');
    return [
      {
        id: 'call_stub_1',
        name: 'fs.write',
        input: isWorkerModel ? TOOL_WRITE_WORKER : TOOL_WRITE_OPENAI,
      },
    ];
  }
  return [{ id: 'toolu_stub_1', name: 'fs.write', input: TOOL_WRITE_ANTHROPIC }];
}

/** 本轮正文（完整字符串；SSE 分片由序列化器切） */
function contentFor(body, isOpenAI) {
  const model = String(body.model ?? '');
  const decompose = isDecompose(body);
  const bad = decompose && isBadJsonGoal(body);
  if (decompose) {
    return bad
      ? '这不是合法的JSON{{{'
      : isOpenAI
        ? JSON.stringify({ tasks: STUB_TASKS.tasks.map((t, i) => ({ ...t, assignee: rosterIds(body)[i % rosterIds(body).length] })) })
        : JSON.stringify(STUB_TASKS);
  }
  if (model.includes('stub-stream')) return STREAM_TEXT;
  if (model.includes('stub-parallel') && hasToolResult(body)) return PARALLEL_DONE_TEXT;
  if (model.includes('stub-ro') && hasToolResult(body)) return RO_DONE_TEXT;
  if (model.includes('stub-autow') && hasToolResult(body)) return AUTOW_DONE_TEXT;
  if (model.includes('stub-mixed') && hasToolResult(body)) return MIXED_DONE_TEXT;
  if (model.includes('stub-tw') && hasToolResult(body)) return TW_DONE_TEXT;
  if (model.includes('stub-fs') && hasToolResult(body)) return 'FSOP 完成：工具结果已回传，按结果给出结论。';
  const mode = emptyMode(body);
  if (mode === 'soft' && !hasNudge(body)) return ''; // 空正文 + max_tokens（thinking 预算耗尽模拟）
  if (mode === 'hard') return '';
  if (mode === 'pseudo' && !hasNudge(body)) return '[调用工具 fs.read]'; // 伪调用文本（真机实证形态）
  if (mode === 'mention') return LEGIT_MENTION_TEXT; // 防误杀：长结论中合法提及标记
  return DEMO_TEXT;
}

/** usage 数值（openai 形状；anthropic 见 usageForAnthropic） */
function usageFor(body) {
  const model = String(body.model ?? '');
  if (model.includes('stub-stream')) return { in: 130, out: 26 }; // §8.1 流式记账专项数值
  return isDecompose(body) ? { in: 88, out: 44 } : { in: 111, out: 22 };
}

/** anthropic 侧流式/非流式的 usage 形状（原 §7 数值：decompose 88/44，其余 77/33） */
function usageForAnthropic(body) {
  const model = String(body.model ?? '');
  if (model.includes('stub-stream')) return { in: 131, out: 27 };
  return isDecompose(body) ? { in: 88, out: 44 } : { in: 77, out: 33 };
}

/** finish/stop 原因：空/伪调用未 nudge 时 max_tokens；有工具调用时 openai=tool_calls、anthropic=tool_use */
function finishFor(body, isOpenAI, toolCalls) {
  const mode = emptyMode(body);
  if (mode && !hasNudge(body)) return 'max_tokens';
  if (toolCalls.length > 0) return isOpenAI ? 'tool_calls' : 'tool_use';
  return isOpenAI ? 'stop' : 'end_turn';
}

// ---- 分片工具（§8.1：跨片重组验证） ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 文本按 n 字切片（保留原串拼接还原） */
function chunkText(s, n = 12) {
  if (s.length === 0) return [];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** JSON 参数串切成非空片段（模拟 input_json_delta / arguments 分片） */
function chunkJson(s, n = 15) {
  if (s.length === 0) return [];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** 工具名跨片（R3：name 也可能分片到达） */
function splitName(name) {
  const mid = Math.max(1, Math.ceil(name.length / 2));
  return [name.slice(0, mid), name.slice(mid)];
}

// ---- SSE 序列化（openai / anthropic 两种形状） ----

async function writeOpenAISse(res, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ choices: [{ delta: { role: 'assistant', content: '' } }] });
  for (const piece of chunkText(plan.content)) {
    send({ choices: [{ delta: { content: piece } }] });
    await sleep(8);
  }
  plan.toolCalls.forEach((tc, i) => {
    const [n1, n2] = splitName(tc.name);
    send({ choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: n1 } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: i, function: { name: n2 } }] } }] }); // name 后半片
    for (const frag of chunkJson(JSON.stringify(tc.input))) {
      send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: frag } }] } }] });
    }
  });
  send({ choices: [{ delta: {}, finish_reason: plan.finish }] });
  send({ choices: [], usage: { prompt_tokens: plan.usage.in, completion_tokens: plan.usage.out } });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function writeAnthropicSse(res, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const send = (ev) => {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  send({ type: 'message_start', message: { id: 'msg_stub_stream', role: 'assistant', usage: { input_tokens: plan.usage.in, output_tokens: 0 } } });
  let idx = 0;
  if (plan.content.length > 0) {
    send({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    for (const piece of chunkText(plan.content)) {
      send({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: piece } });
      await sleep(8);
    }
    send({ type: 'content_block_stop', index: idx });
    idx += 1;
  }
  for (const tc of plan.toolCalls) {
    send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } });
    for (const frag of chunkJson(JSON.stringify(tc.input))) {
      send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: frag } });
    }
    send({ type: 'content_block_stop', index: idx });
    idx += 1;
  }
  send({ type: 'message_delta', delta: { stop_reason: plan.finish, stop_sequence: null }, usage: { output_tokens: plan.usage.out } });
  send({ type: 'message_stop' });
  res.end();
}

// ---- 非流式 JSON（兼容：请求未带 stream 时保持 §7 原形状） ----

function openAiJsonPayload(plan) {
  const message = { content: plan.content };
  if (plan.toolCalls.length > 0) {
    message.tool_calls = plan.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
  }
  return {
    choices: [{ message, finish_reason: plan.finish }],
    usage: { prompt_tokens: plan.usage.in, completion_tokens: plan.usage.out },
  };
}

function anthropicJsonPayload(plan) {
  const content = [];
  if (plan.content.length > 0) content.push({ type: 'text', text: plan.content });
  for (const tc of plan.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  return {
    content,
    usage: { input_tokens: plan.usage.in, output_tokens: plan.usage.out },
  };
}

async function handle(req, res) {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/__inspect') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  // §8.4 并行工具 span 重叠证据：延迟响应端点
  if (req.method === 'GET' && url.startsWith('/__slow')) {
    const ms = Math.min(Math.max(Number.parseInt(new URL(url, 'http://stub').searchParams.get('ms') ?? '300', 10) || 300, 1), 5000);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`slow response after ${ms}ms`);
    }, ms);
    return;
  }

  const isOpenAI = req.method === 'POST' && url === '/chat/completions';
  const isAnthropic = req.method === 'POST' && url === '/v1/messages';
  if (!isOpenAI && !isAnthropic) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `stub 未实现该路由: ${req.method} ${url}` }));
    return;
  }

  const raw = await readBody(req);
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
    return;
  }
  const capture = {
    headers: {
      authorization: req.headers.authorization ?? null,
      'x-api-key': req.headers['x-api-key'] ?? null,
      'anthropic-version': req.headers['anthropic-version'] ?? null,
      'content-type': req.headers['content-type'] ?? null,
    },
    body,
  };
  if (isOpenAI) state.lastOpenAI = capture;
  else state.lastAnthropic = capture;

  const plan = {
    content: contentFor(body, isOpenAI),
    toolCalls: toolCallsFor(body, isOpenAI),
    usage: isAnthropic ? usageForAnthropic(body) : usageFor(body),
  };
  plan.finish = finishFor(body, isOpenAI, plan.toolCalls);

  if (body.stream === true) {
    // §8.1：SSE 分片响应（provider 一律流式请求）
    if (isOpenAI) await writeOpenAISse(res, plan);
    else await writeAnthropicSse(res, plan);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(isOpenAI ? openAiJsonPayload(plan) : anthropicJsonPayload(plan)));
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('stub handler error:', err); // 保留原始错误现场（headersSent 后 writeHead 会二次崩）
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    } else {
      res.destroy(); // SSE 已开流：断流结束，由 provider 侧报错
    }
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`llm-stub-server 就绪: http://127.0.0.1:${port}（/chat/completions + /v1/messages + /__inspect + /__slow，SSE 已支持）`);
});
