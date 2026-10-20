import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { BudgetAuthorization, BudgetUsageEvidence } from '../budgetTypes.ts';
import type { ResourceClaimRecord, ResourceEvidence } from '../../execution/resources/types.ts';
import type { BackendPreparedInput } from './types.ts';
import type { ProcessRegistration } from '../../execution/ownedProcess.ts';
import type { ThreadedContextManifest, ThreadedContextDeliveryOutcome } from '../contextTypes.ts';
import type { ThreadedSessionAnchorEvidence, ThreadedSessionCompactionEvidence, ThreadedSessionContextDecision } from '../sessionContextTypes.ts';
import type { QuiescenceProof } from '../contracts.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const referenceId = (value: string, prefix: string) => value.startsWith(prefix) ? value.slice(prefix.length) : null;
type Receipt = {
  id: string; binding_id: string; authorization_id: string; owner_id: string; thread_id: string;
  invocation_id: string; attempt_id: string; claim_id: string; generation: number; fencing_token: string;
  manifest_id: string; payload_hash: string; native_id: string | null; backend_version: string;
  state: 'sending' | 'complete' | 'unknown'; delivered: number; payload_included: number;
  input_tokens: number | null; output_tokens: number | null; cost_microusd: number | null;
};
const sameBinding = (row: Receipt, binding: ThreadedBinding) => row.binding_id === binding.id &&
  row.owner_id === binding.ownerId && row.thread_id === binding.threadId && row.invocation_id === binding.invocationId &&
  row.attempt_id === binding.attemptId && row.claim_id === binding.claimId && row.generation === binding.generation &&
  row.fencing_token === binding.fencingToken;
export function verifyThreadedBackendUsage(db: Database.Database, binding: ThreadedBinding,
  authorization: BudgetAuthorization, usage: BudgetUsageEvidence): boolean {
  const id = referenceId(usage.evidenceReference, 'threaded-backend-request:');
  if (!id) return false;
  const row = db.prepare('SELECT * FROM threaded_backend_requests WHERE id=?').get(id) as Receipt | undefined;
  return !!row && row.state === 'complete' && sameBinding(row, binding) && row.authorization_id === authorization.id &&
    (usage.outputTokens ?? null) === row.output_tokens && (usage.costMicrousd ?? null) === row.cost_microusd;
}
export function verifyThreadedBackendResourceEvidence(db: Database.Database, claim: ResourceClaimRecord, evidence: ResourceEvidence): boolean {
  const id = typeof evidence.reference === 'string' ? referenceId(evidence.reference, 'threaded-backend-quiescence:') : null;
  if (!id || claim.request.mode !== 'threaded') return false;
  const row = db.prepare(`SELECT q.*,b.attempt_id FROM threaded_backend_quiescence q
    JOIN threaded_execution_bindings b ON b.id=q.binding_id WHERE q.id=?`).get(id) as {
      binding_id:string;claim_id: string; generation: number; fencing_token: string; reason: string; side_effects: string; attempt_id: string;
      request_count:number;process_count:number;
    } | undefined;
  return !!row && row.claim_id === claim.identity.claimId && row.generation === claim.identity.generation &&
    row.fencing_token === claim.identity.fencingToken && row.attempt_id === claim.identity.attemptId &&
    row.reason === evidence.reason && row.side_effects === evidence.sideEffects &&
    quiescentFacts(db,row.binding_id,row.request_count,row.process_count);
}
function quiescentFacts(db:Database.Database,bindingId:string,requestCount:number,processCount:number):boolean {
  const requests=db.prepare("SELECT COUNT(*) n,SUM(state<>'complete') unresolved FROM threaded_backend_requests WHERE binding_id=?")
    .get(bindingId) as {n:number;unresolved:number|null};
  const processes=db.prepare("SELECT COUNT(*) n,SUM(state<>'verified_stopped') unresolved FROM threaded_backend_processes WHERE binding_id=?")
    .get(bindingId) as {n:number;unresolved:number|null};
  return requests.n===requestCount && processes.n===processCount && !requests.unresolved && !processes.unresolved;
}
export function verifyThreadedBackendDelivery(db: Database.Database, binding: ThreadedBinding,
  manifest: ThreadedContextManifest, outcome: ThreadedContextDeliveryOutcome): boolean {
  const id=referenceId(outcome.evidence.reference,'threaded-backend-request:');
  const row=id?db.prepare('SELECT * FROM threaded_backend_requests WHERE id=?').get(id) as Receipt|undefined:undefined;
  if (!row || !sameBinding(row,binding) || row.manifest_id!==manifest.id || row.payload_hash!==manifest.payloadHash ||
    row.native_id!==manifest.session.nativeId) return false;
  return outcome.status==='delivered' ? row.state==='complete' && row.delivered===1
    : outcome.status==='unknown' && (row.state==='unknown'||row.state==='complete'&&row.delivered===0);
}
function nativeRecord(db:Database.Database,reference:string,binding:ThreadedBinding,manifest:ThreadedContextManifest,
  decision:ThreadedSessionContextDecision,kind:'anchor'|'compact') {
  const id=referenceId(reference,'threaded-backend-native:');
  const row=id?db.prepare('SELECT * FROM threaded_backend_native_events WHERE id=?').get(id) as {
    binding_id:string;manifest_id:string;native_id:string;backend_version:string;kind:string;record:string;
  }|undefined:undefined;
  if(!row||row.binding_id!==binding.id||row.manifest_id!==manifest.id||row.native_id!==decision.session.nativeId||row.kind!==kind)return null;
  return row;
}
export function verifyThreadedBackendAnchor(db:Database.Database,binding:ThreadedBinding,manifest:ThreadedContextManifest,
  decision:ThreadedSessionContextDecision,evidence:ThreadedSessionAnchorEvidence,proof:QuiescenceProof):boolean {
  const row=nativeRecord(db,evidence.reference,binding,manifest,decision,'anchor');
  if(!row||row.backend_version!==evidence.backendVersion||JSON.stringify(JSON.parse(row.record))!==JSON.stringify(evidence))return false;
  const request=db.prepare('SELECT * FROM threaded_backend_requests WHERE id=?').get(evidence.requestReceiptId) as Receipt|undefined;
  return !!request&&sameBinding(request,binding)&&request.state==='complete'&&request.delivered===1&&
    proof.claimId===binding.claimId&&proof.generation===binding.generation&&proof.fencingToken===binding.fencingToken;
}
export function verifyThreadedBackendCompaction(db:Database.Database,binding:ThreadedBinding,manifest:ThreadedContextManifest,
  decision:ThreadedSessionContextDecision,evidence:ThreadedSessionCompactionEvidence):boolean {
  const row=nativeRecord(db,evidence.reference,binding,manifest,decision,'compact');
  return !!row&&row.backend_version===evidence.backendVersion&&JSON.stringify(JSON.parse(row.record))===JSON.stringify(evidence);
}
/** Only transports own this producer. UI/model input receives references, never writer methods. */
export function createThreadedBackendEvidence(db: Database.Database, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const receipt = (id: string) => db.prepare('SELECT * FROM threaded_backend_requests WHERE id=?').get(id) as Receipt | undefined;
  return {
    transaction<T>(action:()=>T):T { return db.transaction(action).immediate(); },
    assertOutsideTransaction() { if (db.inTransaction) fail('THREADED_BACKEND_IO_IN_TRANSACTION'); },
    begin(binding: ThreadedBinding, prepared: BackendPreparedInput, authorizationId: string, requestKey: string,
      requestBody: string, payloadIncluded: boolean) {
      const id = randomUUID();
      db.prepare(`INSERT INTO threaded_backend_requests(id,binding_id,authorization_id,owner_id,thread_id,invocation_id,attempt_id,
        claim_id,generation,fencing_token,backend,request_key,manifest_id,payload_hash,request_hash,native_id,session_version,
        backend_version,model,state,payload_included,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sending',?,?)`)
        .run(id,binding.id,authorizationId,binding.ownerId,binding.threadId,binding.invocationId,binding.attemptId,
          binding.claimId,binding.generation,binding.fencingToken,prepared.kind,requestKey,prepared.contextManifestId,
          hash(prepared.serializedContext),hash(requestBody),prepared.session.nativeId,prepared.session.version,
          prepared.session.backendVersion,prepared.model,payloadIncluded?1:0,now());
      return { id, reference: `threaded-backend-request:${id}` };
    },
    complete(id: string, value: { inputTokens?: number; outputTokens?: number; costMicrousd?: number; responseId?: string; delivered: boolean }) {
      for (const number of [value.inputTokens,value.outputTokens,value.costMicrousd]) {
        if (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) fail('THREADED_BACKEND_INVALID_USAGE');
      }
      const row = receipt(id) ?? fail('THREADED_BACKEND_RECEIPT_REQUIRED');
      if (row.state !== 'sending') fail('THREADED_BACKEND_RECEIPT_FINAL');
      db.prepare(`UPDATE threaded_backend_requests SET state='complete',input_tokens=?,output_tokens=?,cost_microusd=?,
        response_id=?,delivered=?,settled_at=? WHERE id=? AND state='sending'`)
        .run(value.inputTokens??null,value.outputTokens??null,value.costMicrousd??null,value.responseId??null,
          value.delivered && row.payload_included ? 1 : 0,now(),id);
      return { ...(value.outputTokens === undefined ? {} : { outputTokens:value.outputTokens }),
        ...(value.costMicrousd === undefined ? {} : { costMicrousd:value.costMicrousd }),
        evidenceReference:`threaded-backend-request:${id}` };
    },
    unknown(id: string) {
      db.prepare("UPDATE threaded_backend_requests SET state='unknown',settled_at=? WHERE id=? AND state='sending'").run(now(),id);
    },
    registerProcess(binding: ThreadedBinding, owner: ProcessRegistration) {
      db.prepare("INSERT INTO threaded_backend_processes(token,binding_id,host,pid,state,created_at) VALUES(?,?,?,?,'registered',?)")
        .run(owner.token,binding.id,hostname(),owner.pid,now());
    },
    processClosed(token: string) {
      db.prepare("UPDATE threaded_backend_processes SET state='closed',stopped_at=? WHERE token=? AND state='registered'").run(now(),token);
    },
    processes(binding: ThreadedBinding) {
      return db.prepare('SELECT token,host,pid,state FROM threaded_backend_processes WHERE binding_id=?')
        .all(binding.id) as Array<{token:string;host:string;pid:number;state:string}>;
    },
    confirmProcessStopped(token: string) {
      db.prepare("UPDATE threaded_backend_processes SET state='verified_stopped',stopped_at=? WHERE token=? AND state='closed'").run(now(),token);
    },
    quiescence(binding: ThreadedBinding, reason: 'not_started'|'process_exited'|'reconciled' = 'process_exited') {
      const requests=(db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests WHERE binding_id=?').get(binding.id) as {n:number}).n;
      const processes=(db.prepare('SELECT COUNT(*) n FROM threaded_backend_processes WHERE binding_id=?').get(binding.id) as {n:number}).n;
      if (!quiescentFacts(db,binding.id,requests,processes) || reason==='not_started'&&(requests||processes)) {
        fail('THREADED_BACKEND_QUIESCENCE_UNCONFIRMED');
      }
      const id = randomUUID(), sideEffects = reason === 'not_started' ? 'none' : 'reconciled';
      db.prepare(`INSERT INTO threaded_backend_quiescence(id,binding_id,claim_id,generation,fencing_token,reason,side_effects,request_count,process_count,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,binding.id,binding.claimId,binding.generation,binding.fencingToken,reason,sideEffects,requests,processes,now());
      return { reason, sideEffects, reference:`threaded-backend-quiescence:${id}` } as const;
    },
    getReceipt(reference: string) { const id=referenceId(reference,'threaded-backend-request:'); return id ? receipt(id)??null : null; },
    nativeAnchor(binding:ThreadedBinding,prepared:BackendPreparedInput,requestReference:string,terminalRecordUuid:string,inputUserUuid?:string,compactionBoundary?:string,resumeToken=terminalRecordUuid) {
      const requestId=referenceId(requestReference,'threaded-backend-request:'),row=requestId?receipt(requestId):undefined;
      if(!row||!sameBinding(row,binding)||row.state!=='complete'||!row.delivered||!prepared.session.nativeId)fail('THREADED_BACKEND_ANCHOR_RECEIPT_REQUIRED');
      const id=randomUUID(),value:ThreadedSessionAnchorEvidence={reference:`threaded-backend-native:${id}`,
        nativeId:prepared.session.nativeId!,backendVersion:prepared.session.backendVersion,requestReceiptId:row!.id,
        terminalRecordUuid,resumeToken,...(inputUserUuid?{inputUserUuid}:{}),...(compactionBoundary?{compactionBoundary}:{})};
      db.prepare(`INSERT INTO threaded_backend_native_events(id,binding_id,manifest_id,native_id,backend_version,kind,record,created_at)
        VALUES(?,?,?,?,?,'anchor',?,?)`).run(id,binding.id,prepared.contextManifestId,value.nativeId,value.backendVersion,JSON.stringify(value),now());
      return value;
    },
    nativeCompaction(binding:ThreadedBinding,prepared:BackendPreparedInput,boundary:string) {
      if(!prepared.session.nativeId)fail('THREADED_BACKEND_NATIVE_ID_REQUIRED');
      const id=randomUUID(),value:ThreadedSessionCompactionEvidence={reference:`threaded-backend-native:${id}`,
        nativeId:prepared.session.nativeId!,backendVersion:prepared.session.backendVersion,boundary};
      db.prepare(`INSERT INTO threaded_backend_native_events(id,binding_id,manifest_id,native_id,backend_version,kind,record,created_at)
        VALUES(?,?,?,?,?,'compact',?,?)`).run(id,binding.id,prepared.contextManifestId,value.nativeId,value.backendVersion,JSON.stringify(value),now());
      return value;
    },
  };
}
