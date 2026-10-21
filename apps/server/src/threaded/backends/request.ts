import type { BackendAdapterOptions, BackendExecuteInput, BackendPreparedInput } from './types.ts';
import { backendUrl, parseBackendResponse, readBackendResponse, type BackendModelResponse } from './http.ts';

export async function executeBackendRequest(options: BackendAdapterOptions, input: BackendExecuteInput,
  prepared: BackendPreparedInput, request: { key: string; pathname: string; body: Record<string, unknown>;
    headers?: Record<string, string>; onChunk?: (chunk: Uint8Array) => void;
    onHeaders?: (status: number, contentType: string) => void }): Promise<{
      status: number; raw: string; contentType: string; parsed?: BackendModelResponse; evidenceReference: string;
    }> {
  input.assertAuthorized(); prepared.assertCurrent(); options.evidence.assertOutsideTransaction();
  const model=typeof request.body.model==='string'?request.body.model:'';
  const expected=prepared.model.replace(/^(openai|anthropic):/,'');
  if (model!==expected) throw new Error('THREADED_BACKEND_MODEL_MISMATCH');
  const countOnly=request.pathname==='/v1/messages/count_tokens';
  const max=countOnly?1:Number(request.body.max_tokens);
  if (!Number.isSafeInteger(max) || max<1 || max>prepared.maxOutputTokens) throw new Error('THREADED_BACKEND_OUTPUT_LIMIT');
  const body=JSON.stringify(request.body);
  const included=!countOnly&&containsPayload(request.body,prepared.serializedContext);
  const {authorization,receipt}=options.evidence.transaction(()=>{
    const authorization=prepared.requests.begin(request.key,{model:prepared.model,maxOutputTokens:max,inputBytes:Buffer.byteLength(body)});
    if(authorization.maxOutputTokens<max)throw new Error('THREADED_BACKEND_AUTHORIZATION_LIMIT');
    const receipt=options.evidence.begin(input.binding,prepared,authorization.id,request.key,body,included);
    return {authorization,receipt};
  });
  try {
    input.assertAuthorized(); prepared.assertCurrent(); options.evidence.assertOutsideTransaction();
    const response=await (options.fetch??globalThis.fetch)(backendUrl(prepared.connection.baseUrl,request.pathname),{
      method:'POST',headers:{'content-type':'application/json',...prepared.connection.headers,...request.headers},
      body,redirect:'error',signal:AbortSignal.any([input.signal,AbortSignal.timeout(prepared.connection.timeoutMs)]),
    });
    input.checkpointActivity?.();
    const contentType=response.headers.get('content-type')??'application/json';
    request.onHeaders?.(response.status,contentType);
    const raw=await readBackendResponse(response,chunk=>{
      input.checkpointActivity?.();
      request.onChunk?.(chunk);
    });
    input.checkpointActivity?.();
    if (!response.ok) {
      const usage=options.evidence.complete(receipt.id,{delivered:false});
      prepared.requests.settle(authorization.id,usage);
      if (included) prepared.delivery('unknown',receipt.reference);
      return {status:response.status,raw,contentType,evidenceReference:receipt.reference};
    }
    if(countOnly) {
      const reported=JSON.parse(raw) as {input_tokens?:unknown};
      if(typeof reported.input_tokens!=='number'||!Number.isSafeInteger(reported.input_tokens)||reported.input_tokens<0) {
        throw new Error('THREADED_BACKEND_TOKEN_COUNT_INVALID');
      }
      const usage=options.evidence.complete(receipt.id,{inputTokens:reported.input_tokens,outputTokens:0,delivered:false});
      prepared.requests.settle(authorization.id,usage);
      return {status:response.status,raw,contentType,evidenceReference:receipt.reference};
    }
    const parsed=parseBackendResponse(prepared.apiProtocol??'anthropic-messages',raw,contentType,prepared.price);
    const usage=options.evidence.complete(receipt.id,{inputTokens:parsed.inputTokens,outputTokens:parsed.outputTokens,
      costMicrousd:parsed.costMicrousd,responseId:parsed.responseId,delivered:included});
    prepared.requests.settle(authorization.id,usage);
    if (included) prepared.delivery('delivered',receipt.reference);
    return {status:response.status,raw,contentType,parsed,evidenceReference:receipt.reference};
  } catch (error) {
    // A final receipt remains immutable even when a later callback fails.
    const saved=options.evidence.getReceipt(receipt.reference);
    if (saved?.state==='sending') {
      options.evidence.unknown(receipt.id);
      prepared.requests.unknown(authorization.id);
      if (included) prepared.delivery('unknown',receipt.reference);
    }
    throw error;
  }
}
function containsPayload(value: unknown, payload: string, depth=0): boolean {
  if (depth>32) return false;
  if (typeof value==='string') return value.includes(payload);
  if (Array.isArray(value)) return value.some(item=>containsPayload(item,payload,depth+1));
  return !!value && typeof value==='object' && Object.values(value).some(item=>containsPayload(item,payload,depth+1));
}
