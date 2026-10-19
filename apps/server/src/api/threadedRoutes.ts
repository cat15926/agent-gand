import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import { THREADED_HTTP_VERSION, THREADED_SCHEMA_VERSION } from '@agent-gand/shared';
import { db } from '../db/database.ts';
import { AccountError } from '../accounts/errors.ts';
import { createThreadedStore } from '../threaded/store.ts';
import { createThreadedAccess, ThreadedAccessError } from '../threaded/access.ts';
import type { ThreadedAccess, ThreadedPrincipal } from '../threaded/access.ts';
import { assertThreadedRequestContract, rejectThreadedAdmission, threadedAdmissionMode, threadedCapabilities } from '../threaded/policy.ts';

type ThreadedReadStore = Pick<ReturnType<typeof createThreadedStore>, 'getInstanceOwnerId' | 'getThread' | 'listThreads' | 'listMembers'>;
export interface ThreadedRouteContext { store: ThreadedReadStore; access: ThreadedAccess; }
let defaults: ThreadedRouteContext | undefined;
function defaultContext(): ThreadedRouteContext {
  if (!defaults) {
    const store = createThreadedStore(db);
    defaults = { store, access: createThreadedAccess(() => store.getInstanceOwnerId()) };
  }
  return defaults;
}

function errorHandler(error: Error, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ThreadedAccessError) return reply.code(error.status).send({ code: error.code, error: error.message });
  if (error instanceof AccountError) return reply.code(error.status).send({ code: 'THREADED_MANAGEMENT_AUTH_REQUIRED', error: error.message });
  const statusCode = (error as { statusCode?: number }).statusCode;
  const status = statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  return reply.code(status).send({ code: status < 500 ? 'THREADED_REQUEST_INVALID' : 'THREADED_OPERATION_FAILED', error: '持续协作请求无法完成' });
}

/** Register inside the existing account namespace. Its cookie remains scoped to /api/accounts. */
export async function registerThreadedAccessBridge(accounts: FastifyInstance, context = defaultContext()): Promise<void> {
  accounts.post('/api/accounts/threaded/access-session', { bodyLimit: 1024, errorHandler }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    assertThreadedRequestContract(request);
    if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).some(key => !['httpVersion', 'toolVersion', 'schemaVersion'].includes(key)))) {
      throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '持续协作认证参数无效');
    }
    return { ...context.access.issue(request, reply), httpVersion: THREADED_HTTP_VERSION };
  });
}

/** T02 exposes authenticated snapshots only. No dispatcher, executor or global bus is connected. */
export async function registerThreadedRoutes(app: FastifyInstance, context = defaultContext()): Promise<void> {
  threadedAdmissionMode(); // Reject unknown operator configuration before serving requests.
  const { store, access } = context;
  const principals = new WeakMap<FastifyRequest, ThreadedPrincipal>();
  function principal(request: FastifyRequest): ThreadedPrincipal {
    const current = principals.get(request);
    if (!current) throw new ThreadedAccessError(401, 'THREADED_SESSION_REQUIRED', '请先建立持续协作会话');
    access.assertActive(current);
    return current;
  }
  function thread(id: string, ownerId: string) {
    const found = store.getThread(id, ownerId);
    if (!found) throw new ThreadedAccessError(404, 'THREADED_THREAD_NOT_FOUND', '持续协作空间不存在或无权访问');
    return found;
  }
  function snapshot(id: string, ownerId: string) {
    return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: THREADED_SCHEMA_VERSION,
      thread: thread(id, ownerId), members: store.listMembers(id, ownerId) };
  }
  await app.register(async threaded => {
    threaded.setErrorHandler(errorHandler);
    threaded.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
        .header('x-gand-threaded-http-version', THREADED_HTTP_VERSION);
      principals.set(request, access.requireSession(request));
    });
    threaded.addHook('preValidation', async request => {
      assertThreadedRequestContract(request, request.routeOptions.url === '/api/threaded/ws');
      principal(request);
      if (request.routeOptions.url === '/api/threaded/ws') {
        const id = (request.query as { threadId?: unknown }).threadId;
        if (typeof id !== 'string' || !id || id.length > 200) {
          throw new ThreadedAccessError(400, 'THREADED_THREAD_REQUIRED', 'WebSocket 需要明确的持续协作空间');
        }
        thread(id, principal(request).ownerId);
      }
    });
    threaded.get('/capabilities', async () => threadedCapabilities());
    threaded.get('/session', async request => ({ ...access.view(principal(request)), httpVersion: THREADED_HTTP_VERSION }));
    threaded.delete('/session', async (request, reply) => access.logout(request, reply));
    threaded.get('/threads', async request => ({ httpVersion: THREADED_HTTP_VERSION,
      schemaVersion: THREADED_SCHEMA_VERSION, threads: store.listThreads(principal(request).ownerId) }));
    threaded.get<{ Params: { id: string } }>('/threads/:id', async request => snapshot(request.params.id, principal(request).ownerId));
    threaded.get<{ Params: { id: string } }>('/threads/:id/members', async request => {
      const ownerId = principal(request).ownerId;
      thread(request.params.id, ownerId);
      return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: THREADED_SCHEMA_VERSION,
        members: store.listMembers(request.params.id, ownerId) };
    });
    threaded.post('/threads', { bodyLimit: 16_384 }, async () => rejectThreadedAdmission());
    const websocket: WebsocketHandler = (socket, request) => {
      const current = principal(request);
      const id = (request.query as { threadId: string }).threadId;
      const close = () => { socket.close(1008, 'Session or access invalidated'); };
      const unwatch = access.watch(current, close);
      const recheck = setInterval(() => {
        try { access.assertActive(current); thread(id, current.ownerId); }
        catch { close(); }
      }, 1000);
      recheck.unref();
      socket.on('close', () => { clearInterval(recheck); unwatch(); });
      socket.on('error', () => { clearInterval(recheck); unwatch(); });
      // T02 deliberately has no subscription to the unfiltered legacy message bus.
      access.assertActive(current);
      socket.send(JSON.stringify({ type: 'threaded.snapshot', ...snapshot(id, current.ownerId) }));
      socket.on('message', () => { socket.close(1008, 'Snapshot connection is read-only'); });
    };
    threaded.get('/ws', { websocket: true }, websocket);
    threaded.all('/*', { bodyLimit: 16_384 }, async request => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) rejectThreadedAdmission();
      throw new ThreadedAccessError(404, 'THREADED_RESOURCE_NOT_IMPLEMENTED', '持续协作资源尚未实现');
    });
  }, { prefix: '/api/threaded' });
  app.addHook('onClose', async () => { access.close(); if (defaults === context) defaults = undefined; });
}
