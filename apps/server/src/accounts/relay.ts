import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fetch as upstreamFetch } from 'undici';
import type { ResolvedAccount } from './resolver.ts';
import { assertNotRevoked } from './resolver.ts';
import { rememberSecret, redactSecrets, secretSafeDelta } from './secrets.ts';
import { AccountError } from './errors.ts';
import { anthropicAuthHeaders } from './headers.ts';
import { authenticationErrorDetail } from './upstreamError.ts';

/** Execution-local relay: supplier credentials never enter native process environments. */
export async function createCredentialRelay(account: ResolvedAccount, backend: 'anthropic' | 'openai', signal: AbortSignal, noTools = false, onAuthenticationFailure?: (status: number, detail: string | null) => void, connectionTest = false) {
  if (!account.apiKey) throw new AccountError(409, '账户缺少 API Key');
  const token = randomBytes(32).toString('hex'); rememberSecret(token);
  const lifetime = new AbortController(); const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const task = (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const supplied = backend === 'anthropic' ? req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '') : req.headers.authorization?.replace(/^Bearer /, '');
        if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) || req.headers.origin) { res.writeHead(403).end(); return; }
        const allowed = backend === 'anthropic' ? ['/v1/messages', '/v1/messages/count_tokens'] : ['/responses', '/responses/compact'];
        if (req.method !== 'POST' || !allowed.includes(url.pathname) || [...url.searchParams].some(([name, value]) => name !== 'beta' || value !== 'true')) { res.writeHead(403).end(); return; }
        assertNotRevoked(account.accountId);
        const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 20 * 1024 * 1024) throw new Error('请求过大'); chunks.push(buffer); }
        let body = Buffer.concat(chunks).toString('utf8');
        if (noTools) { const parsed = JSON.parse(body); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式无效'); delete parsed.tools; delete parsed.tool_choice; delete parsed.parallel_tool_calls; body = JSON.stringify(parsed); }
        if (connectionTest && backend === 'anthropic') { const parsed = JSON.parse(body); parsed.thinking = { type: 'disabled' }; parsed.max_tokens = 512; body = JSON.stringify(parsed); }
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(backend === 'anthropic' ? { ...anthropicAuthHeaders(account.apiKey!, account.connection), 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01') } : { authorization: `Bearer ${account.apiKey}` }) };
        if (backend === 'anthropic' && typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
        const relative = backend === 'anthropic' && account.connection.baseUrl.endsWith('/v1') ? url.pathname.slice(3) : url.pathname;
        const upstream = await upstreamFetch(account.connection.baseUrl.replace(/\/+$/, '') + relative + url.search, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(account.connection.timeoutMs)]) });
        if ((upstream.status === 401 || upstream.status === 403) && onAuthenticationFailure) {
          const detail = await authenticationErrorDetail(upstream);
          res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: { type: 'authentication_error', message: detail ?? '模型服务拒绝认证' } }));
          if (!signal.aborted && !lifetime.signal.aborted) onAuthenticationFailure(upstream.status, detail);
          return;
        }
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
        if (upstream.body) {
          const decoder = new TextDecoder(); const safe = secretSafeDelta((text) => res.write(text));
          for await (const chunk of upstream.body) safe.push(decoder.decode(chunk, { stream: true }));
          safe.push(decoder.decode()); safe.finish();
        }
        res.end();
      } catch { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: redactSecrets('模型认证转发失败，请检查账户连接或认证状态') })); }
    })();
    requests.add(task); void task.finally(() => requests.delete(task));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('认证转发启动失败');
  return { baseUrl: `http://127.0.0.1:${address.port}`, token, async close() {
    lifetime.abort(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await Promise.allSettled(requests);
  } };
}
