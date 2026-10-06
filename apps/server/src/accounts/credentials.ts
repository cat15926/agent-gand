import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { get, run } from '../db/database.ts';
import { AccountError } from './errors.ts';
import { rememberSecret } from './secrets.ts';

interface CredentialRow {
  account_id: string; version: number; key_id: string; ciphertext: string; nonce: string; tag: string; suffix: string;
}
function masterKey(create = false): Buffer {
  if (config.accounts.masterKey) {
    const raw = config.accounts.masterKey;
    if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new AccountError(503, '账户主密钥配置无效，需要 64 位十六进制值');
    return Buffer.from(raw, 'hex');
  }
  const dir = config.accounts.privateDir;
  const file = path.join(dir, 'account-master-key.json');
  try {
    if (create) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      chmodSync(dir, 0o700);
      let present = true;
      try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error; }
      if (!present) {
        if ((get<{ count: number }>('SELECT COUNT(*) count FROM account_credentials')?.count ?? 0) > 0) throw new AccountError(503, '账户主密钥缺失，请恢复原主密钥；现有密钥未被覆盖');
        try { writeFileSync(file, JSON.stringify({ version: 1, key: randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
    }
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) throw new Error();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      const data = JSON.parse(readFileSync(fd, 'utf8')) as { version?: number; key?: string };
      if (data.version !== 1 || typeof data.key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.key)) throw new Error();
      return Buffer.from(data.key, 'hex');
    } finally { closeSync(fd); }
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError(503, '无法读取账户主密钥，请检查私有目录、文件权限或恢复备份');
  }
}
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 32);
const aad = (accountId: string, version: number, id: string) => Buffer.from(JSON.stringify(['agent-gand-account-v1', accountId, version, id]));

export function writeCredential(accountId: string, version: number, apiKey: string): void {
  rememberSecret(apiKey);
  const key = masterKey(true); const id = keyId(key); const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(accountId, version, id));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  run('INSERT INTO account_credentials (account_id,version,key_id,ciphertext,nonce,tag,suffix,created_at) VALUES (?,?,?,?,?,?,?,?)',
    accountId, version, id, ciphertext.toString('base64'), nonce.toString('base64'), cipher.getAuthTag().toString('base64'), apiKey.slice(-4), new Date().toISOString());
}
/** Server-only read. Never serialize this result into account views, events, or traces. */
export function readCredential(accountId: string, version: number): string {
  const row = get<CredentialRow>('SELECT * FROM account_credentials WHERE account_id=? AND version=?', accountId, version);
  if (!row) throw new AccountError(409, '账户密钥未设置');
  const key = masterKey();
  try {
    if (row.key_id !== keyId(key)) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64'));
    cipher.setAAD(aad(accountId, version, row.key_id)); cipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const value = Buffer.concat([cipher.update(Buffer.from(row.ciphertext, 'base64')), cipher.final()]).toString('utf8');
    rememberSecret(value); return value;
  } catch { throw new AccountError(503, '账户密钥无法解密，请恢复正确的主密钥或密钥备份'); }
}
export function credentialSummary(accountId: string, version: number | null): { hasCredential: boolean; keySuffix: string | null; authentication: 'configured' | 'missing' | 'locked' } {
  if (version === null) return { hasCredential: false, keySuffix: null, authentication: 'missing' };
  const row = get<CredentialRow>('SELECT * FROM account_credentials WHERE account_id=? AND version=?', accountId, version);
  if (!row) return { hasCredential: false, keySuffix: null, authentication: 'missing' };
  try { readCredential(accountId, version); return { hasCredential: true, keySuffix: row.suffix, authentication: 'configured' }; }
  catch { return { hasCredential: true, keySuffix: row.suffix, authentication: 'locked' }; }
}
