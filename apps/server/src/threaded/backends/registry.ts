import type { ThreadedBinding } from '@agent-gand/shared';
import type { InvocationExecutionPort } from '../contracts.ts';
import type { BackendKind } from './types.ts';

export function createThreadedBackendRegistry(options:{
  api:InvocationExecutionPort;claudeSdk:InvocationExecutionPort;
  resolveKind(binding:ThreadedBinding,sessionBindingId:string):BackendKind;
}):InvocationExecutionPort {
  return {execute(input) {
    const kind=options.resolveKind(input.binding,input.sessionBindingId);
    if(kind==='api')return options.api.execute(input);
    if(kind==='claude-sdk')return options.claudeSdk.execute(input);
    throw new Error('THREADED_BACKEND_NOT_ADMITTED');
  }};
}
