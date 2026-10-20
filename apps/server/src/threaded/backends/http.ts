import type { BackendPreparedInput } from './types.ts';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const string = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
export interface BackendModelResponse {
  content: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicrousd?: number;
  stopReason: string;
  tools: Array<{ id: string; name: string; input: unknown }>;
}
export function backendUrl(base: string, pathname: string): string {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('THREADED_BACKEND_ENDPOINT_INVALID');
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = prefix.endsWith('/v1') && pathname.startsWith('/v1/') ? prefix + pathname.slice(3) : prefix + pathname;
  return url.toString();
}
export async function readBackendResponse(response: Response, onChunk?: (chunk: Uint8Array) => void): Promise<string> {
  if (!response.body) throw new Error('THREADED_BACKEND_EMPTY_RESPONSE');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let body = '', bytes = 0, done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      bytes += next.value.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('THREADED_BACKEND_RESPONSE_LIMIT');
      onChunk?.(next.value); body += decoder.decode(next.value, { stream:true });
    }
    return body + decoder.decode();
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Strict terminal parsing: EOF or valid JSON alone never stands in for a model completion. */
export function parseBackendResponse(protocol: NonNullable<BackendPreparedInput['apiProtocol']>, body: string,
  contentType: string, price?: BackendPreparedInput['price']): BackendModelResponse {
  const streaming = contentType.includes('text/event-stream');
  const records: Obj[] = []; let done = false;
  if (streaming) {
    for (const frame of body.replace(/\r\n/g,'\n').split(/\n\n/)) {
      const data = frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { done=true; continue; }
      const value = JSON.parse(data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('THREADED_BACKEND_FRAME_INVALID');
      records.push(value as Obj);
    }
  } else records.push(object(JSON.parse(body)));
  let id: string|undefined, stop = '', text = '', input: number|undefined, output: number|undefined;
  let cacheRead: number|undefined, cacheWrite: number|undefined;
  const tools = new Map<number,{id:string;name:string;json:string;value?:unknown}>();
  const usage = (v: unknown) => {
    const u=object(v);
    input = number(protocol==='anthropic-messages'?u.input_tokens:u.prompt_tokens) ?? input;
    output = number(protocol==='anthropic-messages'?u.output_tokens:u.completion_tokens) ?? output;
    cacheRead = number(protocol==='anthropic-messages'?u.cache_read_input_tokens:object(u.prompt_tokens_details).cached_tokens) ?? cacheRead;
    cacheWrite = number(u.cache_creation_input_tokens) ?? cacheWrite;
  };
  for (const record of records) {
    if (record.error || record.type === 'error') throw new Error('THREADED_BACKEND_REMOTE_ERROR');
    if (protocol === 'anthropic-messages') {
      if (!streaming) {
        id=string(record.id); stop=string(record.stop_reason)??''; usage(record.usage); done=!!stop;
        for (const [index, raw] of (Array.isArray(record.content)?record.content:[]).entries()) {
          const block=object(raw);
          if (block.type==='text' && typeof block.text==='string') text+=block.text;
          if (block.type==='tool_use') tools.set(index,{id:string(block.id)??'',name:string(block.name)??'',json:'',value:block.input});
        }
      } else if (record.type==='message_start') { const message=object(record.message); id=string(message.id);usage(message.usage); }
      else if (record.type==='content_block_start') {
        const block=object(record.content_block), index=number(record.index);
        if (index===undefined) throw new Error('THREADED_BACKEND_BLOCK_INVALID');
        if (block.type==='text' && typeof block.text==='string') text+=block.text;
        if (block.type==='tool_use') tools.set(index,{id:string(block.id)??'',name:string(block.name)??'',json:''});
      } else if (record.type==='content_block_delta') {
        const delta=object(record.delta), index=number(record.index);
        if (delta.type==='text_delta' && typeof delta.text==='string') text+=delta.text;
        if (delta.type==='input_json_delta') {
          const tool=index===undefined?undefined:tools.get(index);
          if (!tool || typeof delta.partial_json!=='string') throw new Error('THREADED_BACKEND_TOOL_FRAME_INVALID');
          tool.json+=delta.partial_json;
        }
      } else if (record.type==='message_delta') { stop=string(object(record.delta).stop_reason)??stop;usage(record.usage); }
      else if (record.type==='message_stop') done=true;
    } else {
      id=string(record.id)??id; usage(record.usage);
      const choice=object(Array.isArray(record.choices)?record.choices[0]:undefined);
      stop=string(choice.finish_reason)??stop;
      const message=object(streaming?choice.delta:choice.message);
      if (typeof message.content==='string') text+=message.content;
      for (const [position, raw] of (Array.isArray(message.tool_calls)?message.tool_calls:[]).entries()) {
        const call=object(raw), fn=object(call.function), index=number(call.index)??position;
        const tool=tools.get(index)??{id:'',name:'',json:''};
        tool.id=string(call.id)??tool.id;
        if (typeof fn.name==='string') tool.name+=fn.name;
        if (typeof fn.arguments==='string') tool.json+=fn.arguments;
        tools.set(index,tool);
      }
      if (!streaming) done=!!stop;
    }
  }
  if (!id || !stop || !done) throw new Error('THREADED_BACKEND_TERMINAL_UNCONFIRMED');
  const result:BackendModelResponse={content:text,responseId:id,stopReason:stop,tools:[...tools.values()].map(tool=>{
    if (!tool.id || !tool.name) throw new Error('THREADED_BACKEND_TOOL_INVALID');
    return {id:tool.id,name:tool.name,input:tool.value??JSON.parse(tool.json||'{}')};
  }),inputTokens:input===undefined?undefined:input+(protocol==='anthropic-messages'?(cacheRead??0)+(cacheWrite??0):0),
    outputTokens:output,cacheReadTokens:cacheRead,cacheWriteTokens:cacheWrite};
  if (price && input!==undefined && output!==undefined && (!cacheRead || price.cacheReadPerMillion!==undefined) &&
    (!cacheWrite || price.cacheWritePerMillion!==undefined)) {
    const base=protocol==='openai-chat-completions'?input-(cacheRead??0):input;
    const cost=base*price.inputPerMillion+output*price.outputPerMillion+
      (cacheRead??0)*(price.cacheReadPerMillion??0)+(cacheWrite??0)*(price.cacheWritePerMillion??0);
    if (base>=0 && Number.isFinite(cost) && cost>=0 && Number.isSafeInteger(Math.ceil(cost))) result.costMicrousd=Math.ceil(cost);
  }
  return result;
}
