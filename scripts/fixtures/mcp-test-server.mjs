import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-gand-test-mcp', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'ping') { reply(request.id, {}); return; }
  if (request.method === 'tools/list') {
    reply(request.id, {
      tools: [{
        name: 'echo',
        description: 'Return the received arguments.',
        inputSchema: { type: 'object', additionalProperties: true },
      }],
    });
    return;
  }
  if (request.method === 'tools/call') {
    reply(request.id, {
      content: [{ type: 'text', text: `mcp echo: ${JSON.stringify(request.params?.arguments ?? {})}` }],
    });
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
});
