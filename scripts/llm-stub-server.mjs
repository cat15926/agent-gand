/**
 * 本地 LLM stub 端点（规格 §7.3.2/3/4 验收用，无真实 key）
 *
 * 一个 HTTP 服务同时模拟两种 API：
 *   POST /chat/completions   → openai-compatible 响应（含 tool_calls + usage）
 *   POST /v1/messages        → anthropic 响应（含 tool_use block + usage）
 *   GET  /__inspect          → 返回最近一次捕获的请求（body + 关键 headers），供断言
 *
 * 行为由请求内容确定性切换：
 *   - user 消息含「严格只输出 JSON」标记 → supervisor 结构化拆解：返回 JSON tasks
 *     （goal 含 BADJSON 时返回非法 JSON，用于 fallback 验证）
 *   - 其余 → 返回演示文案 + 一个 fs.write 工具调用（openai: tool_calls；anthropic: tool_use）
 *
 * 用法：node scripts/llm-stub-server.mjs [port]   # 默认 3999
 */
import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '3999', 10);

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

/** 演示文案 + fs.write 工具调用（两种 API 各自的形状与文件名，便于分别断言） */
const DEMO_TEXT = '【llm-stub】已处理目标（stub 响应）';
const TOOL_WRITE_OPENAI = { path: 'stub-openai.txt', content: 'openai stub 工具写入内容' };
const TOOL_WRITE_ANTHROPIC = { path: 'stub-anthropic.txt', content: 'anthropic stub 工具写入内容' };
const TOOL_WRITE_WORKER = { path: 'stub-sup-worker.txt', content: 'supervisor worker stub 工具写入内容' };
/** 防误杀用例正文：合法地在长结论中提及伪调用标记（不得被启发式误判为空正文） */
const LEGIT_MENTION_TEXT =
  '审查结论：PASS。备注：过程中模型曾试图[调用工具 fs.read]，已被权限门控正确处理；产物内容完整、逻辑清晰，无需修改，建议归档。';

async function handle(req, res) {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/__inspect') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
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

  const decompose = isDecompose(body);
  const bad = decompose && isBadJsonGoal(body);
  let payload;

  if (isOpenAI) {
    state.lastOpenAI = capture;
    // worker 模型（stub-gpt-worker）单独落一个沙箱文件，供 supervisor 工具路径断言
    const isWorkerModel = String(body.model ?? '').includes('worker');
    const mode = emptyMode(body);
    const content = decompose
      ? bad
        ? '这不是合法的JSON{{{'
        : JSON.stringify({ tasks: STUB_TASKS.tasks.map((t, i) => ({ ...t, assignee: rosterIds(body)[i % rosterIds(body).length] })) })
      : mode === 'soft' && !hasNudge(body)
        ? '' // 空正文 + max_tokens（thinking 预算耗尽模拟）
        : mode === 'hard'
          ? ''
          : mode === 'pseudo' && !hasNudge(body)
            ? '[调用工具 fs.read]' // 伪调用文本（真机实证形态）
            : mode === 'mention'
              ? LEGIT_MENTION_TEXT // 防误杀：长结论中合法提及标记
              : DEMO_TEXT;
    const message = { content };
    if (!decompose && !hasToolResult(body) && !mode) {
      // openai tool_calls 形状（仅首轮；工具结果回传后收尾，避免无限循环）
      message.tool_calls = [
        {
          id: 'call_stub_1',
          type: 'function',
          function: {
            name: 'fs.write',
            arguments: JSON.stringify(isWorkerModel ? TOOL_WRITE_WORKER : TOOL_WRITE_OPENAI),
          },
        },
      ];
    }
    payload = {
      choices: [{ message, finish_reason: mode && !hasNudge(body) ? 'max_tokens' : 'stop' }],
      usage: decompose
        ? { prompt_tokens: 88, completion_tokens: 44 }
        : { prompt_tokens: 111, completion_tokens: 22 },
    };
  } else {
    state.lastAnthropic = capture;
    const content = decompose
      ? bad
        ? [{ type: 'text', text: '这不是合法的JSON{{{' }]
        : [{ type: 'text', text: JSON.stringify(STUB_TASKS) }]
      : hasToolResult(body)
        ? [{ type: 'text', text: DEMO_TEXT }] // 工具结果已回传：收尾，不再 tool_use
        : [
            { type: 'text', text: DEMO_TEXT },
            { type: 'tool_use', id: 'toolu_stub_1', name: 'fs.write', input: TOOL_WRITE_ANTHROPIC },
          ];
    payload = {
      content,
      usage: decompose
        ? { input_tokens: 88, output_tokens: 44 }
        : { input_tokens: 77, output_tokens: 33 },
    };
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`llm-stub-server 就绪: http://127.0.0.1:${port}（/chat/completions + /v1/messages + /__inspect）`);
});
