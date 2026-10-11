import type { FastifyInstance } from 'fastify';
import { assertManagementBoundary, managementOwner, requireManagementSession } from '../accounts/access.ts';
import { OrchestrationError } from '../orchestration/normalize.ts';
import { AccountError } from '../accounts/errors.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { getManagedArtifact, listManagedArtifacts, readManagedArtifact, releaseManagedArtifact } from '../artifacts/store.ts';
import { confirmArtifactRestore, confirmArtifactSnapshot, deleteArtifactSnapshot, listArtifactSnapshots, previewArtifactRestore, previewArtifactSnapshot, readSnapshotContent } from '../artifacts/snapshots.ts';

/** Same owner session and CSRF boundary as account/business management; never accept a viewer override. */
export async function registerArtifactRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async managed => {
    managed.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
      assertManagementBoundary(request); requireManagementSession(request);
    });
    managed.setErrorHandler((error,_request,reply) => {
      const status = error instanceof OrchestrationError || error instanceof AccountError ? error.status : (error as {statusCode?:number}).statusCode ?? 500;
      return reply.code(status).send({ error: status >= 500 ? '受控文件校验或存储失败，请检查服务端记录与产物备份' : redactSecrets(error instanceof Error ? error.message : String(error)), ...(error instanceof OrchestrationError ? {code:error.code} : {}) });
    });
    managed.get<{ Params: { roomId: string } }>('/api/accounts/artifacts/rooms/:roomId', async req => ({ files: listManagedArtifacts(req.params.roomId) }));
    managed.get<{ Params: { id: string } }>('/api/accounts/artifacts/:id/content', async req => {
      const file = getManagedArtifact(req.params.id);
      return { file, contentBase64: readManagedArtifact(file.id).toString('base64') };
    });
    managed.post<{ Params: { id: string }; Body: Parameters<typeof releaseManagedArtifact>[1] }>('/api/accounts/artifacts/:id/release', async req => {
      if (!req.body || Object.keys(req.body).some(key => !['expectedVersion','visibility','audience','reason'].includes(key))) throw new OrchestrationError(400,'ARTIFACT_RELEASE_INVALID','文件授权请求包含未知字段');
      return releaseManagedArtifact(req.params.id,req.body,managementOwner(req));
    });
    const fields = (body:unknown,allowed:string[]) => {
      if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!allowed.includes(k))) throw new OrchestrationError(400,'SNAPSHOT_INPUT_INVALID','快照请求包含无效或未知字段');
    };
    managed.get<{Params:{runId:string}}>('/api/accounts/artifact-snapshots/runs/:runId',async req=>({snapshots:listArtifactSnapshots(req.params.runId)}));
    managed.post<{Params:{runId:string};Body:NonNullable<Parameters<typeof previewArtifactSnapshot>[1]>}>('/api/accounts/artifact-snapshots/runs/:runId/preview',async req=>{fields(req.body,['paths','stageIds']);return previewArtifactSnapshot(req.params.runId,req.body);});
    managed.post<{Params:{runId:string};Body:Parameters<typeof confirmArtifactSnapshot>[1]}>('/api/accounts/artifact-snapshots/runs/:runId',async req=>{fields(req.body,['paths','stageIds','fingerprint']);return confirmArtifactSnapshot(req.params.runId,req.body);});
    managed.post<{Params:{id:string}}>('/api/accounts/artifact-snapshots/:id/restore-preview',async req=>previewArtifactRestore(req.params.id));
    managed.get<{Params:{id:string;kind:string;index:string}}>('/api/accounts/artifact-snapshots/:id/content/:kind/:index',async req=>{
      if(!['file','text'].includes(req.params.kind)) throw new OrchestrationError(400,'SNAPSHOT_INPUT_INVALID','产物类型无效');
      return readSnapshotContent(req.params.id,req.params.kind as 'file'|'text',Number(req.params.index));
    });
    managed.post<{Params:{id:string};Body:Parameters<typeof confirmArtifactRestore>[1]}>('/api/accounts/artifact-snapshots/:id/restores',async req=>{fields(req.body,['fingerprint','clientRequestId']);return confirmArtifactRestore(req.params.id,req.body);});
    managed.delete<{Params:{id:string};Body:{digest:string}}>('/api/accounts/artifact-snapshots/:id',async req=>{fields(req.body,['digest']);deleteArtifactSnapshot(req.params.id,req.body.digest);return {deleted:true};});
  });
}
