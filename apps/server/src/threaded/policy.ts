import type { FastifyRequest } from 'fastify';
import { THREADED_HTTP_VERSION, THREADED_TOOL_VERSION, THREADED_SCHEMA_VERSION } from '@agent-gand/shared';
import type { ThreadedAdmissionMode, ThreadedCapabilities } from '@agent-gand/shared';
import { ThreadedAccessError } from './access.ts';

export function threadedAdmissionMode(): ThreadedAdmissionMode {
  const mode = process.env.THREADED_COLLABORATION_MODE ?? 'closed';
  if (mode !== 'closed' && mode !== 'observe' && mode !== 'execute') {
    throw new ThreadedAccessError(503, 'THREADED_CONFIGURATION_INVALID', 'THREADED_COLLABORATION_MODE 仅支持 closed / observe / execute');
  }
  return mode;
}

export function threadedCapabilities(): ThreadedCapabilities {
  return {
    httpVersion: THREADED_HTTP_VERSION, toolVersion: THREADED_TOOL_VERSION, schemaVersion: THREADED_SCHEMA_VERSION,
    implemented: { readSnapshots: true, authenticatedWs: true, admission: false, execution: false, tools: false,
      messageReads: true, messagePersistence: true, outbox: true },
    configured: { mode: threadedAdmissionMode() },
    // Verification is deployment evidence; opening a release control cannot self-attest it.
    verified: { readSnapshots: false, authenticatedWs: false, admission: false, execution: false, tools: false,
      messageReads: false, messagePersistence: false, outbox: false },
  };
}

/** Explicitly supplied unknown contracts fail closed; omission negotiates the sole implemented HTTP v1. */
export function assertThreadedRequestContract(request: FastifyRequest, allowThreadId = false, queryFields: readonly string[] = []): void {
  const query = request.query as Record<string, unknown>;
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown> : {};
  const versions = [
    [request.headers['x-gand-threaded-http-version'], THREADED_HTTP_VERSION],
    [request.headers['x-gand-threaded-tool-version'], THREADED_TOOL_VERSION],
    [request.headers['x-gand-threaded-schema-version'], String(THREADED_SCHEMA_VERSION)],
    [query.httpVersion, THREADED_HTTP_VERSION], [body.httpVersion, THREADED_HTTP_VERSION],
    [body.toolVersion, THREADED_TOOL_VERSION], [body.schemaVersion, THREADED_SCHEMA_VERSION],
  ];
  for (const [actual, expected] of versions) if (actual !== undefined && actual !== expected) {
    throw new ThreadedAccessError(409, 'THREADED_VERSION_UNSUPPORTED', '持续协作协议版本不受支持');
  }
  const authorityFields = ['ownerId', 'owner_id', 'instanceOwnerId', 'instance_owner_id', 'actor', 'attemptId', 'generation', 'authorityEpoch'];
  if (authorityFields.some(key => Object.hasOwn(query, key) || Object.hasOwn(body, key))) {
    throw new ThreadedAccessError(400, 'THREADED_IDENTITY_FIELD_REJECTED', '执行身份必须由服务端认证绑定提供');
  }
  const allowedQuery = ['httpVersion', ...(allowThreadId ? ['threadId'] : []), ...queryFields];
  if (Object.keys(query).some(key => !allowedQuery.includes(key))) {
    throw new ThreadedAccessError(400, 'THREADED_REQUEST_INVALID', '持续协作查询参数无效');
  }
}

/** Missing a trusted release pack never enables execution, regardless of configured mode. */
export function rejectThreadedAdmission(): never {
  if (threadedAdmissionMode() === 'closed') throw new ThreadedAccessError(403, 'THREADED_MODE_CLOSED', '持续协作新工作入场已关闭');
  throw new ThreadedAccessError(501, 'THREADED_ADMISSION_NOT_IMPLEMENTED', '持续协作真实后端工作入场尚未开放');
}
