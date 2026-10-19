import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { assertManagementBoundary, managementSessionGrant, onManagementSessionInvalidated } from '../accounts/access.ts';
import { AccountError } from '../accounts/errors.ts';

const defaultLifetimeMs = 8 * 60 * 60 * 1000;
const cookieName = `gand_threaded_${config.port}`;
const digest = (value: string) => createHash('sha256').update(value).digest();
const equals = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

export class ThreadedAccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface ThreadedPrincipal { readonly sessionId: string; readonly ownerId: string; }
interface Session {
  ownerId: string; managementOwner: string; csrf: string; expiresAt: number;
  listeners: Set<() => void>; timer: ReturnType<typeof setTimeout>;
}

export function assertThreadedBoundary(request: FastifyRequest): void {
  try { assertManagementBoundary(request); }
  catch (error) {
    if (error instanceof AccountError) throw new ThreadedAccessError(error.status, 'THREADED_BOUNDARY_REJECTED', '持续协作请求来源不受信任');
    throw error;
  }
}

function readCookie(request: FastifyRequest): string | null {
  const values = request.headers.cookie?.split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${cookieName}=`)) ?? [];
  if (values.length !== 1) return null;
  const value = values[0]!.slice(cookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function setCookie(request: FastifyRequest, reply: FastifyReply, id: string, maxAge: number): void {
  const secure = request.protocol === 'https' || request.headers.origin?.startsWith('https://');
  reply.header('set-cookie', `${cookieName}=${id}; Path=/api/threaded; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

/** In-memory credentials expire on restart; business owner identity remains database-backed. */
export function createThreadedAccess(getOwnerId: () => string, options: { now?: () => number; lifetimeMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const lifetimeMs = Math.min(defaultLifetimeMs, Math.max(1, options.lifetimeMs ?? defaultLifetimeMs));
  const sessions = new Map<string, Session>();
  function revoke(id: string): void {
    const stored = sessions.get(id);
    if (!stored) return;
    sessions.delete(id); clearTimeout(stored.timer);
    for (const listener of stored.listeners) { try { listener(); } catch { /* Revocation must reach every connection. */ } }
    stored.listeners.clear();
  }
  function prune(): void { for (const [id, stored] of sessions) if (stored.expiresAt <= now()) revoke(id); }
  const stopManagementWatch = onManagementSessionInvalidated(owner => {
    for (const [id, stored] of sessions) if (stored.managementOwner === owner) revoke(id);
  });
  function active(principal: ThreadedPrincipal): Session {
    const stored = sessions.get(principal.sessionId);
    if (!stored || stored.expiresAt <= now() || stored.ownerId !== principal.ownerId || stored.ownerId !== getOwnerId()) {
      revoke(principal.sessionId);
      throw new ThreadedAccessError(401, 'THREADED_SESSION_REQUIRED', '持续协作会话已失效，请重新连接');
    }
    return stored;
  }
  function requireSession(request: FastifyRequest): ThreadedPrincipal {
    assertThreadedBoundary(request);
    const sessionId = readCookie(request);
    const stored = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !stored) throw new ThreadedAccessError(401, 'THREADED_SESSION_REQUIRED', '请先建立持续协作会话');
    const principal = { sessionId, ownerId: stored.ownerId };
    const current = active(principal);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const token = request.headers['x-gand-csrf'];
      if (typeof token !== 'string' || !equals(token, current.csrf)) {
        throw new ThreadedAccessError(403, 'THREADED_CSRF_REQUIRED', '持续协作写入缺少有效的 CSRF 校验');
      }
    }
    return principal;
  }
  return {
    issue(request: FastifyRequest, reply: FastifyReply) {
      assertThreadedBoundary(request);
      const grant = managementSessionGrant(request);
      prune();
      if (sessions.size >= 1000) throw new ThreadedAccessError(429, 'THREADED_SESSION_LIMIT', '持续协作会话过多');
      const id = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      const expiresAt = Math.min(now() + lifetimeMs, grant.expiresAt);
      if (expiresAt <= now()) throw new ThreadedAccessError(401, 'THREADED_SESSION_REQUIRED', '管理会话已过期');
      const ownerId = getOwnerId();
      const timer = setTimeout(() => revoke(id), Math.max(1, expiresAt - now()));
      timer.unref();
      sessions.set(id, { ownerId, managementOwner: grant.owner, csrf, expiresAt, listeners: new Set(), timer });
      setCookie(request, reply, id, Math.max(1, Math.ceil((expiresAt - now()) / 1000)));
      return { csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() };
    },
    requireSession,
    assertActive(principal: ThreadedPrincipal): void { active(principal); },
    view(principal: ThreadedPrincipal) {
      const stored = active(principal);
      return { csrfToken: stored.csrf, expiresAt: new Date(stored.expiresAt).toISOString() };
    },
    logout(request: FastifyRequest, reply: FastifyReply) {
      const principal = requireSession(request);
      revoke(principal.sessionId); setCookie(request, reply, '', 0);
      return { ok: true as const };
    },
    watch(principal: ThreadedPrincipal, onInvalidated: () => void): () => void {
      const stored = active(principal); stored.listeners.add(onInvalidated);
      return () => { stored.listeners.delete(onInvalidated); };
    },
    close(): void { stopManagementWatch(); for (const id of sessions.keys()) revoke(id); },
  };
}

export type ThreadedAccess = ReturnType<typeof createThreadedAccess>;
