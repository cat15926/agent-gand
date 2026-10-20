import type { InvocationExecutionPort } from '../contracts.ts';
import type { BackendAdapterOptions } from './types.ts';
import { executeBackendRequest } from './request.ts';

/** Each loop iteration is exactly one HTTP request; transport compatibility retries are never hidden. */
export function createApiBackend(options: BackendAdapterOptions): InvocationExecutionPort {
  return { async execute(input) {
    const prepared=await options.loadInput(input);
    if (prepared.kind!=='api' || !prepared.apiProtocol || prepared.session.nativeId!==null) throw new Error('THREADED_API_CONFIGURATION_REQUIRED');
    const messages:Array<Record<string,unknown>>=[{role:'user',content:prepared.serializedContext}];
    const anthropic=prepared.apiProtocol==='anthropic-messages', model=prepared.model.replace(/^(openai|anthropic):/,'');
    let toolUnconfirmed=false;
    try {
      for (let sequence=1;sequence<=(prepared.maxRequests??64);sequence++) {
        input.assertAuthorized(); prepared.assertCurrent();
        const body:Record<string,unknown>={model,max_tokens:prepared.maxOutputTokens,stream:true,
          messages:anthropic?messages:[{role:'system',content:prepared.instructions},...messages],
          ...(anthropic?{system:prepared.instructions}:{stream_options:{include_usage:true}})};
        if (prepared.tools?.length) body.tools=prepared.tools.map(tool=>anthropic?
          {name:tool.name,description:tool.description,input_schema:tool.parameters}:
          {type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}});
        const result=await executeBackendRequest(options,input,prepared,{key:`api:${sequence}`,
          pathname:anthropic?'/v1/messages':'/chat/completions',body});
        if (!result.parsed) throw new Error(`THREADED_API_HTTP_${result.status}`);
        const response=result.parsed;
        if (response.stopReason==='max_tokens' || response.stopReason==='length') throw new Error('THREADED_API_OUTPUT_TRUNCATED');
        if (!response.tools.length) {
          input.assertAuthorized(); prepared.assertCurrent();
          const proof=options.recordQuiescence(input.binding,options.evidence.quiescence(input.binding));
          return {kind:'completed',content:response.content,budgetState:'unknown',quiescence:proof};
        }
        if (!prepared.executeTool) throw new Error('THREADED_API_TOOL_PORT_REQUIRED');
        if (anthropic) messages.push({role:'assistant',content:[
          ...(response.content?[{type:'text',text:response.content}]:[]),
          ...response.tools.map(tool=>({type:'tool_use',id:tool.id,name:tool.name,input:tool.input}))]});
        else messages.push({role:'assistant',content:response.content,tool_calls:response.tools.map(tool=>({
          id:tool.id,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.input)}}))});
        const results:Array<Record<string,unknown>>=[];
        for (const tool of response.tools) {
          input.assertAuthorized(); prepared.assertCurrent();
          if (!prepared.tools?.some(allowed=>allowed.name===tool.name)) throw new Error('THREADED_API_TOOL_NOT_ALLOWED');
          toolUnconfirmed=true;
          const text=await prepared.executeTool(tool.name,tool.input,tool.id);
          toolUnconfirmed=false;
          results.push({type:'tool_result',tool_use_id:tool.id,content:text});
          if (!anthropic) messages.push({role:'tool',tool_call_id:tool.id,content:text});
        }
        if (anthropic) messages.push({role:'user',content:results});
      }
      throw new Error('THREADED_API_REQUEST_LIMIT');
    } catch {
      if (toolUnconfirmed) return {kind:'unknown',reason:'THREADED_TOOL_OUTCOME_UNCONFIRMED'};
      try {
        const proof=options.recordQuiescence(input.binding,options.evidence.quiescence(input.binding));
        return input.signal.aborted?{kind:'cancelled',reason:'THREADED_API_CANCELLED',budgetState:'unknown',quiescence:proof}:
          {kind:'failed',reason:'THREADED_API_FAILED',retryable:false,budgetState:'unknown',quiescence:proof};
      } catch { return {kind:'unknown',reason:'THREADED_API_QUIESCENCE_UNCONFIRMED'}; }
    }
  }};
}
