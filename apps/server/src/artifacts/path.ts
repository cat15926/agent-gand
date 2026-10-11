import path from 'node:path';
import { OrchestrationError } from '../orchestration/errors.ts';
const fail = (code: string, message: string): never => { throw new OrchestrationError(400,code,message); };
export function managedPath(value: string): string {
  if (!value || value.length > 240 || path.isAbsolute(value) || /[\\\x00-\x1f]/.test(value)
    || value.split('/').some(part => !part || part === '..' || part === '.') || ['shared','archive','.git','.claude','.codex','.agents'].some(part => value.split('/').map(segment=>segment.toLowerCase()).includes(part))) {
    fail('ARTIFACT_PATH_INVALID', '受控文件需使用普通相对路径，不能指向共享区、归档或执行配置');
  }
  return value;
}
