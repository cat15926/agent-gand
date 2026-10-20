import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import { THREADED_HTTP_VERSION, THREADED_SCHEMA_VERSION } from '@agent-gand/shared';
import { db } from '../db/database.ts';
import { AccountError } from '../accounts/errors.ts';
import { createThreadedStore } from '../threaded/store.ts';
import { createThreadedAccess, ThreadedAccessError } from '../threaded/access.ts';
import type { ThreadedAccess, ThreadedPrincipal } from '../threaded/access.ts';
import { assertThreadedRequestContract, rejectThreadedAdmission, threadedAdmissionMode, threadedCapabilities } from '../threaded/policy.ts';
import { threadedLifecycle, threadedRuntime } from '../threaded/service.ts';
import type { createThreadedCollaboration } from '../threaded/collaboration.ts';
import { ThreadedCollaborationError } from '../threaded/collaborationTypes.ts';
import type {RoutingPolicy} from '../threaded/collaborationTypes.ts';
import { ThreadedAuthorityError } from '../threaded/contracts.ts';
import { ThreadedMessageError } from '../threaded/messageContracts.ts';
import type { ThreadedMessageReadScope } from '../threaded/messageContracts.ts';
import { ThreadedMessageAclError } from '../threaded/acl.ts';
import type { createThreadedMessages } from '../threaded/messages.ts';
import type { ThreadedInternalNotification } from '../threaded/outbox.ts';
import { threadedMessaging, closeThreadedMessaging } from '../threaded/messagingService.ts';

type ThreadedReadStore = Pick<ReturnType<typeof createThreadedStore>, 'getInstanceOwnerId' | 'getThread' | 'listThreads' | 'listMembers'>;
export interface ThreadedRouteContext {
  store: ThreadedReadStore;
  access: ThreadedAccess;
  lifecycle?: Pick<typeof threadedLifecycle, 'requestControl' | 'decideApproval'>;
  messages?: Pick<ReturnType<typeof createThreadedMessages>, 'acceptUserMessage' | 'getMessage' | 'listMessages' | 'searchMessages' | 'getAttachment' | 'getSources'>;
  /** Default production admission remains closed. T06 will supply the full admission policy. */
  messageAdmission?: () => void;
  onMessageNotification?: (listener: (hint: ThreadedInternalNotification) => void) => () => void;
  collaboration?: ReturnType<typeof createThreadedCollaboration>;
}
let defaults: ThreadedRouteContext | undefined;
function defaultContext(): ThreadedRouteContext {
  if (!defaults) {
    const store = createThreadedStore(db);
    const messaging = threadedMessaging();
    defaults = { store, access: createThreadedAccess(() => store.getInstanceOwnerId()), lifecycle: threadedLifecycle,
      messages: messaging.messages, onMessageNotification: messaging.onNotification,collaboration:threadedRuntime.collaboration };
  }
  return defaults;
}

function errorHandler(error: Error, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ThreadedAccessError) return reply.code(error.status).send({ code: error.code, error: error.message });
  if (error instanceof ThreadedAuthorityError) return reply.code(error.status).send({ code: error.code, error: error.message });
  if (error instanceof ThreadedCollaborationError) return reply.code(error.status).send({code:error.code,error:error.message});
  if (error instanceof ThreadedMessageError || error instanceof ThreadedMessageAclError) {
    return reply.code(error.status).send({ code: error.code, error: error.message });
  }
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

/** Authenticated snapshots and lifecycle controls. New work and provider execution remain closed. */
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
      const url = request.routeOptions.url;
      const queries = url === '/api/threaded/threads/:id/messages' ? ['afterSeq', 'limit']
        : url === '/api/threaded/threads/:id/messages/search' ? ['q', 'afterSeq', 'limit']
          :url==='/api/threaded/threads/:id/waits'?['agentId']:[];
      assertThreadedRequestContract(request, url === '/api/threaded/ws', queries);
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
    function messageScope(request: FastifyRequest<{ Params: { id: string } }>): ThreadedMessageReadScope {
      const ownerId = principal(request).ownerId;
      thread(request.params.id, ownerId);
      if (!context.messages) throw new ThreadedAccessError(503, 'THREADED_MESSAGES_UNAVAILABLE', '持续协作消息尚未接入');
      return { ownerId, threadId: request.params.id, viewer: { kind: 'owner' } };
    }
    function page(request: FastifyRequest): { afterSeq: number; limit: number } {
      const query = request.query as Record<string, unknown>;
      function integer(key: string, fallback: number, min: number, max: number) {
        if (query[key] === undefined) return fallback;
        if (typeof query[key] !== 'string' || !/^\d+$/.test(query[key] as string)) throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '消息分页参数无效');
        const number = Number(query[key]);
        if (!Number.isSafeInteger(number) || number < min || number > max) throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '消息分页参数无效');
        return number;
      }
      return { afterSeq: integer('afterSeq', 0, 0, Number.MAX_SAFE_INTEGER), limit: integer('limit', 50, 1, 100) };
    }
    function notFound(): never { throw new ThreadedAccessError(404, 'THREADED_MESSAGE_NOT_FOUND', '消息不存在或无权访问'); }
    threaded.get<{ Params: { id: string } }>('/threads/:id/messages', async request => {
      const scope = messageScope(request);
      return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: 1, messages: context.messages!.listMessages(scope, page(request)) };
    });
    threaded.get<{ Params: { id: string } }>('/threads/:id/messages/search', async request => {
      const scope = messageScope(request);
      const query = (request.query as { q?: unknown }).q;
      if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '消息搜索参数无效');
      return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: 1,
        messages: context.messages!.searchMessages(scope, { ...page(request), query }) };
    });
    threaded.get<{ Params: { id: string; messageId: string } }>('/threads/:id/messages/:messageId', async request => {
      const scope = messageScope(request);
      const message = context.messages!.getMessage(scope, request.params.messageId);
      return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: 1, message: message ?? notFound() };
    });
    threaded.get<{ Params: { id: string; messageId: string } }>('/threads/:id/messages/:messageId/sources', async request => {
      const scope = messageScope(request);
      const sources = context.messages!.getSources(scope, request.params.messageId);
      return { httpVersion: THREADED_HTTP_VERSION, schemaVersion: 1, messages: sources ?? notFound() };
    });
    threaded.get<{ Params: { id: string; attachmentId: string } }>('/threads/:id/attachments/:attachmentId', async (request, reply) => {
      const scope = messageScope(request);
      const found = context.messages!.getAttachment(scope, request.params.attachmentId) ?? notFound();
      const name = encodeURIComponent(found.attachment.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      reply.header('content-disposition', `attachment; filename*=UTF-8''${name}`)
        .header('x-content-type-options', 'nosniff').type('application/octet-stream');
      return reply.send(found.content);
    });
    threaded.post<{ Params: { id: string } }>('/threads/:id/messages', { bodyLimit: 2_000_000 }, async request => {
      const scope = messageScope(request);
      const body = request.body as Record<string, unknown> | undefined;
      const fields = ['clientRequestId', 'body', 'targets', 'audience', 'visibility', 'state', 'attachments', 'sourceRefs', 'httpVersion', 'toolVersion', 'schemaVersion'];
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))
        || typeof body.clientRequestId !== 'string' || !body.clientRequestId.trim() || body.clientRequestId.length > 200
        || typeof body.body !== 'string') throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '消息提交参数无效');
      (context.messageAdmission ?? rejectThreadedAdmission)();
      const input={
        ownerId: scope.ownerId, threadId: scope.threadId, clientRequestId: body.clientRequestId, body: body.body,
        ...Object.fromEntries(['targets', 'audience', 'visibility', 'state', 'attachments', 'sourceRefs']
          .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])),
      };
      const result=context.collaboration?.routing.acceptUserMessage(input);
      return {httpVersion:THREADED_HTTP_VERSION,schemaVersion:1,...(result??{receipt:context.messages!.acceptUserMessage(input)})};
    });
    if(context.collaboration){
      threaded.get<{Params:{id:string}}>('/threads/:id/routing-policy',async request=>{const scope=messageScope(request);
        return {httpVersion:THREADED_HTTP_VERSION,routing:context.collaboration!.routing.getPolicy(scope.ownerId,scope.threadId)};});
      threaded.put<{Params:{id:string}}>('/threads/:id/routing-policy',async request=>{
        const scope=messageScope(request),body=request.body as Record<string,unknown>|undefined;
        if(!body||!body.policy||typeof body.policy!=='object'||Array.isArray(body.policy)||!Number.isSafeInteger(body.expectedVersion)
          ||Object.keys(body).some(k=>!['policy','expectedVersion','httpVersion','toolVersion','schemaVersion'].includes(k)))throw new ThreadedAccessError(400,'THREADED_REQUEST_INVALID','路由配置参数无效');
        return {httpVersion:THREADED_HTTP_VERSION,routing:context.collaboration!.routing.configure(scope.ownerId,scope.threadId,body.policy as RoutingPolicy,Number(body.expectedVersion))};
      });
      threaded.post<{Params:{id:string}}>('/threads/:id/routing-preview',async request=>{
        const scope=messageScope(request),body=request.body as Record<string,unknown>|undefined;
        if(!body||typeof body.body!=='string'||Object.keys(body).some(k=>!['body','targets','httpVersion','toolVersion','schemaVersion'].includes(k)))throw new ThreadedAccessError(400,'THREADED_REQUEST_INVALID','路由参数无效');
        return {httpVersion:THREADED_HTTP_VERSION,route:context.collaboration!.routing.preview({ownerId:scope.ownerId,threadId:scope.threadId,body:body.body,
          ...(body.targets===undefined?{}:{targets:body.targets as string[]})})};
      });
      threaded.get<{Params:{id:string};Querystring:{agentId:string}}>('/threads/:id/waits',async request=>{
        const scope=messageScope(request),agentId=request.query.agentId;
        if(typeof agentId!=='string'||!store.listMembers(scope.threadId,scope.ownerId).some(m=>m.agentId===agentId))notFound();
        const waits=context.collaboration!.cooperation.list({ownerId:scope.ownerId,threadId:scope.threadId,agentId}) as Array<{
          id:string;kind:string;state:string;version:number;deadline:number|null;record:string;outcome:string|null}>;
        return {httpVersion:THREADED_HTTP_VERSION,waits:waits.map(w=>({id:w.id,kind:w.kind,state:w.state,version:w.version,deadline:w.deadline,
          question:(JSON.parse(w.record) as {question?:string}).question??null,outcome:w.outcome?JSON.parse(w.outcome):null}))};
      });
      threaded.post<{Params:{id:string;waitId:string}}>('/threads/:id/decisions/:waitId/responses',async request=>{
        const scope=messageScope(request),body=request.body as Record<string,unknown>|undefined;
        if(!body||typeof body.body!=='string'||typeof body.clientRequestId!=='string'||!Number.isSafeInteger(body.expectedVersion)
          ||Object.keys(body).some(k=>!['body','clientRequestId','expectedVersion','httpVersion','toolVersion','schemaVersion'].includes(k)))throw new ThreadedAccessError(400,'THREADED_REQUEST_INVALID','回应参数无效');
        (context.messageAdmission??rejectThreadedAdmission)();
        return {httpVersion:THREADED_HTTP_VERSION,receipt:context.collaboration!.cooperation.answerDecision({ownerId:scope.ownerId,threadId:scope.threadId,
          waitId:request.params.waitId,body:body.body,clientRequestId:body.clientRequestId,expectedVersion:Number(body.expectedVersion)})};
      });
    }
    function controlInput(request: FastifyRequest, decision = false) {
      const body = request.body as Record<string, unknown> | undefined;
      const field = decision ? 'decision' : 'action';
      const allowed = decision ? ['approve', 'reject'] : ['pause', 'stop', 'resume'];
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => ![field, 'requestId', 'httpVersion', 'toolVersion', 'schemaVersion'].includes(key))
        || typeof body[field] !== 'string' || !allowed.includes(body[field] as string)
        || typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 200) {
        throw new ThreadedAccessError(400, 'THREADED_CONTROL_INVALID', '持续协作控制参数无效');
      }
      if (!context.lifecycle) throw new ThreadedAccessError(503, 'THREADED_LIFECYCLE_UNAVAILABLE', '持续协作控制尚未接入');
      return { value: body[field] as string, requestId: body.requestId };
    }
    type ControlParams = { id: string; invocationId?: string; agentId?: string };
    for (const [url, kind] of [
      ['/threads/:id/controls', 'thread'],
      ['/threads/:id/members/:agentId/controls', 'member'],
      ['/threads/:id/invocations/:invocationId/controls', 'invocation'],
    ] as const) {
      threaded.post<{ Params: ControlParams }>(url, { bodyLimit: 4096 }, async request => {
        const ownerId = principal(request).ownerId;
        thread(request.params.id, ownerId);
        const input = controlInput(request);
        return context.lifecycle!.requestControl({
          ownerId, requestId: input.requestId, action: input.value as 'pause' | 'stop' | 'resume',
          scope: { kind, threadId: request.params.id, invocationId: request.params.invocationId, agentId: request.params.agentId },
        });
      });
    }
    threaded.post<{ Params: { id: string; approvalId: string } }>('/threads/:id/approvals/:approvalId/decision', { bodyLimit: 4096 }, async request => {
      const ownerId = principal(request).ownerId;
      thread(request.params.id, ownerId);
      const input = controlInput(request, true);
      return context.lifecycle!.decideApproval({ ownerId, threadId: request.params.id, approvalId: request.params.approvalId,
        decision: input.value as 'approve' | 'reject', requestId: input.requestId });
    });
    const websocket: WebsocketHandler = (socket, request) => {
      const current = principal(request);
      const id = (request.query as { threadId: string }).threadId;
      const close = () => { socket.close(1008, 'Session or access invalidated'); };
      const unwatch = access.watch(current, close);
      const unwatchMessages = context.onMessageNotification?.(hint => {
        if (hint.threadId !== id || hint.ownerId !== current.ownerId) return;
        try {
          access.assertActive(current); thread(id, current.ownerId);
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'threaded.change', httpVersion: THREADED_HTTP_VERSION,
            schemaVersion: 1, eventId: hint.eventId, eventType: hint.eventType, threadId: id,
            sourceId: hint.sourceId, sourceVersion: hint.sourceVersion }));
        } catch { close(); }
      });
      const recheck = setInterval(() => {
        try { access.assertActive(current); thread(id, current.ownerId); }
        catch { close(); }
      }, 1000);
      recheck.unref();
      socket.on('close', () => { clearInterval(recheck); unwatch(); unwatchMessages?.(); });
      socket.on('error', () => { clearInterval(recheck); unwatch(); unwatchMessages?.(); });
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
  app.addHook('onClose', async () => { access.close(); if (defaults === context) { defaults = undefined; closeThreadedMessaging(); } });
}
