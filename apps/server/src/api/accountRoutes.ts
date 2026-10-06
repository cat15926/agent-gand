import type { AccountBackend } from '@agent-gand/shared';
import type { FastifyInstance } from 'fastify';
import { testAccount, revokeAccount } from '../accounts/actions.ts';
import { startLogin, loginOperation, cancelLogin, checkLogin, cancelSessionLogins, pendingLogin } from '../accounts/login.ts';
import { verifyIdentity, removeNativeCredentials } from '../accounts/native.ts';
import { assertFields, object } from '../accounts/validation.ts';
import { compatibleBackends } from '../accounts/compatibility.ts';
import { AccountError } from '../accounts/errors.ts';
import { accessMode, assertManagementBoundary, createManagementSession, deleteManagementSession, requireManagementSession, managementOwner } from '../accounts/access.ts';
import { checkAccount, clearCredential, createAccount, deleteAccount, getAccount, listAccounts, references, replaceCredential, updateAccount } from '../accounts/store.ts';

/** Encapsulated hooks and error handler cover every credential request, including parse failures. */
export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (accounts) => {
    accounts.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      assertManagementBoundary(request);
      const url = request.routeOptions.url;
      if (url === '/api/accounts/access' || (url === '/api/accounts/session' && request.method === 'POST')) return;
      requireManagementSession(request);
    });
    accounts.setErrorHandler((error, request, reply) => {
      // Never log error objects, request bodies or native credential material in this module.
      if (error instanceof AccountError) return reply.code(error.status).send({ error: error.message, fieldErrors: error.fieldErrors });
      const statusCode = (error as { statusCode?: number }).statusCode;
      const status = statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
      if (status === 500) request.log.error({ code: 'ACCOUNT_OPERATION_FAILED' }, '账户管理操作失败');
      return reply.code(status).send({ error: status < 500 ? '账户请求格式无效' : '账户操作失败，请检查服务端配置或恢复备份' });
    });
    accounts.get('/api/accounts/access', async () => accessMode());
    accounts.post('/api/accounts/session', { bodyLimit: 1024 }, async (request, reply) => createManagementSession(request, reply));
    accounts.delete('/api/accounts/session', async (request, reply) => { await cancelSessionLogins(managementOwner(request)); return deleteManagementSession(request, reply); });
    accounts.get<{ Querystring: { includeArchived?: string } }>('/api/accounts', async (request) => ({
      accounts: listAccounts(request.query.includeArchived === '1'), features: { roleBinding: true, nativeLogin: true, liveTest: true },
    }));
    accounts.post('/api/accounts', { bodyLimit: 65_536 }, async (request, reply) => {
      const account = createAccount(request.body); return reply.code(201).send(account);
    });
    accounts.get<{ Params: { id: string } }>('/api/accounts/:id', async (request) => getAccount(request.params.id));
    accounts.patch<{ Params: { id: string } }>('/api/accounts/:id', { bodyLimit: 65_536 }, async (request) => updateAccount(request.params.id, request.body));
    accounts.post<{ Params: { id: string } }>('/api/accounts/:id/credentials', { bodyLimit: 20_000 }, async (request) => replaceCredential(request.params.id, request.body));
    accounts.delete<{ Params: { id: string } }>('/api/accounts/:id/credentials', async (request) => clearCredential(request.params.id, request.body));
    accounts.post<{ Params: { id: string } }>('/api/accounts/:id/check', async (request) => { const account = getAccount(request.params.id); if (account.source === 'managed' && account.authType === 'native_login' && account.identityGeneration) { try { await verifyIdentity(account.id, account.identityGeneration); } catch (error) { if (!(error instanceof AccountError) || error.status !== 409) throw error; } } return checkAccount(account.id); });
    accounts.post<{ Params: { id: string } }>('/api/accounts/:id/test', { bodyLimit: 2048 }, async (request) => testAccount(request.params.id, request.body));
    accounts.post<{ Params: { id: string } }>('/api/accounts/:id/revoke', { bodyLimit: 1024 }, async (request) => revokeAccount(request.params.id, request.body));
    accounts.get<{ Params: { id: string } }>('/api/accounts/:id/login', async (request) => { getAccount(request.params.id); return pendingLogin(request.params.id, managementOwner(request)); });
    accounts.post<{ Params: { id: string } }>('/api/accounts/:id/login', { bodyLimit: 1024 }, async (request) => {
      const input = object(request.body); assertFields(input, ['expectedVersion']); return startLogin(request.params.id, input.expectedVersion, managementOwner(request));
    });
    accounts.get<{ Params: { operationId: string } }>('/api/accounts/logins/:operationId', async (request) => loginOperation(request.params.operationId, managementOwner(request)));
    accounts.delete<{ Params: { operationId: string } }>('/api/accounts/logins/:operationId', async (request) => cancelLogin(request.params.operationId, managementOwner(request)));
    accounts.post<{ Params: { operationId: string } }>('/api/accounts/logins/:operationId/check', async (request) => checkLogin(request.params.operationId, managementOwner(request)));
    accounts.get<{ Params: { id: string }; Querystring: { backend?: string } }>('/api/accounts/:id/models', async (request) => {
      const account = getAccount(request.params.id);
      if (request.query.backend && !compatibleBackends(account.connection, account.nativeClient).includes(request.query.backend as AccountBackend)) throw new AccountError(400, '接入方式与账户不兼容');
      return { models: account.connection.models.map((id) => ({ id, source: 'account' })), defaultModel: account.connection.defaultModel, detected: false };
    });
    accounts.get<{ Params: { id: string } }>('/api/accounts/:id/references', async (request) => { getAccount(request.params.id); return references(request.params.id); });
    accounts.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request) => { const account = getAccount(request.params.id); const result = deleteAccount(account.id, request.body); if (account.authType === 'native_login') await removeNativeCredentials(account.id); return result; });
  });
}
