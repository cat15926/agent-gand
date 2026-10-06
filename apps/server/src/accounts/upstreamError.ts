import type { Response } from 'undici';
import { redactSecrets } from './secrets.ts';

/** Read only a bounded JSON error, without exposing raw HTML, credentials or headers. */
export async function authenticationErrorDetail(response: Pick<Response, 'body'>): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let timedOut = false; let bytes = 0; const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 2000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    if (timedOut) return null;
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const top = payload as Record<string, unknown>;
    const error = top.error && typeof top.error === 'object' && !Array.isArray(top.error) ? top.error as Record<string, unknown> : top;
    const message = typeof error.message === 'string' ? redactSecrets(error.message).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) : '';
    const rawCode = error.code ?? error.type ?? top.code;
    const code = (typeof rawCode === 'string' || typeof rawCode === 'number') && /^[A-Za-z0-9_.-]{1,50}$/.test(String(rawCode)) ? redactSecrets(String(rawCode)) : '';
    return message || code ? `${code ? `业务码 ${code}` : ''}${code && message ? '：' : ''}${message}` : null;
  } catch { return null; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
