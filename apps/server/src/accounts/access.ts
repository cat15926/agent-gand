import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { AccountError } from './errors.ts';

const lifetimeMs = 8 * 60 * 60 * 1000;
const cookieName = `gand_accounts_${config.port}`;
const sessions = new Map<string, { csrf: string; expires: number }>();
export const isLoopback = (host: string) => ['127.0.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1'].includes(host.toLowerCase());
const remoteMode = !isLoopback(config.host);
const trustedHosts = new Set(config.accounts.trustedOrigins.map((origin) => new URL(origin).host.toLowerCase()));
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));
export function accessMode(): { mode: 'local' | 'token'; available: boolean } {
  return { mode: remoteMode ? 'token' : 'local', available: !remoteMode || (config.accounts.adminToken?.length ?? 0) >= 32 };
}
function cookie(request: FastifyRequest): string | null {
  const raw = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName + '='));
  const value = raw?.slice(cookieName.length + 1);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}
function session(request: FastifyRequest) {
  const id = cookie(request); const stored = id ? sessions.get(id) : undefined;
  if (!stored || stored.expires <= Date.now()) { if (id) sessions.delete(id); return undefined; }
  return stored;
}
export function managementOwner(request: FastifyRequest): string {
  requireManagementSession(request);
  return digest(cookie(request)!).toString('hex');
}
/** No forwarded headers are trusted. Vite proxy Host/Origin are explicitly allowlisted. */
export function assertManagementBoundary(request: FastifyRequest): void {
  if (!trustedHosts.has((request.headers.host ?? '').toLowerCase())) throw new AccountError(403, '账户管理请求的 Host 不受信任');
  const origin = request.headers.origin;
  if (origin !== undefined && !config.accounts.trustedOrigins.includes(origin)) throw new AccountError(403, '账户管理请求的来源不受信任');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccountError(403, '账户管理不接受跨站请求');
  if (!remoteMode && !isLoopback(request.ip)) throw new AccountError(403, '账户管理仅允许本机访问');
}
export function requireManagementSession(request: FastifyRequest): void {
  if (!accessMode().available) throw new AccountError(503, '远程账户管理尚未启用，请配置至少 32 个字符的 ACCOUNT_ADMIN_TOKEN');
  const stored = session(request);
  if (!stored) throw new AccountError(401, '账户管理会话已过期，请重新连接');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const token = request.headers['x-gand-csrf'];
    if (typeof token !== 'string' || !equal(token, stored.csrf)) throw new AccountError(403, '账户管理请求缺少有效的 CSRF 校验');
  }
}
export function createManagementSession(request: FastifyRequest, reply: FastifyReply): { csrfToken: string; expiresAt: string } {
  if (request.headers['x-gand-bootstrap'] !== '1') throw new AccountError(403, '账户管理需要显式建立会话');
  if (!accessMode().available) throw new AccountError(503, '远程账户管理尚未启用，请配置至少 32 个字符的 ACCOUNT_ADMIN_TOKEN');
  if (remoteMode) {
    const bearer = request.headers.authorization;
    if (!bearer?.startsWith('Bearer ') || !equal(bearer.slice(7), config.accounts.adminToken!)) throw new AccountError(401, '账户管理认证失败');
    if (request.headers.origin && !request.headers.origin.startsWith('https://') && !isLoopback(new URL(request.headers.origin).hostname)) throw new AccountError(403, '远程浏览器账户管理需要 HTTPS');
  }
  for (const [id, stored] of sessions) if (stored.expires <= Date.now()) sessions.delete(id);
  const existing = session(request);
  if (existing) return { csrfToken: existing.csrf, expiresAt: new Date(existing.expires).toISOString() };
  if (sessions.size >= 1000) throw new AccountError(429, '账户管理会话过多，请稍后重试');
  const id = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex'); const expires = Date.now() + lifetimeMs;
  sessions.set(id, { csrf, expires });
  const secure = request.protocol === 'https' || request.headers.origin?.startsWith('https://');
  reply.header('set-cookie', `${cookieName}=${id}; Path=/api/accounts; HttpOnly; SameSite=Strict; Max-Age=${lifetimeMs / 1000}${secure ? '; Secure' : ''}`);
  return { csrfToken: csrf, expiresAt: new Date(expires).toISOString() };
}
export function deleteManagementSession(request: FastifyRequest, reply: FastifyReply): { ok: true } {
  const id = cookie(request); if (id) sessions.delete(id);
  reply.header('set-cookie', `${cookieName}=; Path=/api/accounts; HttpOnly; SameSite=Strict; Max-Age=0`);
  return { ok: true };
}
