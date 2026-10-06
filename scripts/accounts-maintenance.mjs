import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { config } from '../apps/server/src/config.ts';

// Deliberately avoid database.ts: inspecting a pre-migration database must never initialize or migrate it.
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tableNames = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const rows = (db, tables, name) => tables.has(name) ? db.prepare(`SELECT * FROM ${name}`).all() : [];
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
async function present(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function identity(pid) {
  try { const result = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim(); return result && !result.startsWith('Z') ? result.replace(/^\S+\s+/, '') : null; }
  catch { return null; }
}
function assertOffline(db, tables) {
  const owner = rows(db, tables, 'external_runtime_host')[0];
  if (owner && (owner.host !== hostname() || identity(owner.pid) === owner.identity)) throw new Error('服务仍在运行，请正常停止服务后备份');
  if (rows(db, tables, 'external_native_processes').some((r) => r.status === 'active')) throw new Error('存在未清理的原生进程，请先通过服务恢复并清理');
  if (rows(db, tables, 'account_login_operations').some((r) => ['starting', 'pending'].includes(r.status)) || rows(db, tables, 'account_checks').some((r) => r.status === 'running')) throw new Error('存在未完成的账户登录或测试，请先取消或恢复');
}
async function masterMaterial(privateDir, configured) {
  if (configured) { if (!/^[a-fA-F0-9]{64}$/.test(configured)) throw new Error(); return Buffer.from(configured, 'hex'); }
  const directory = await lstat(privateDir); const file = path.join(privateDir, 'account-master-key.json');
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error();
    const value = json(await handle.readFile('utf8'));
    if (value?.version !== 1 || !/^[a-fA-F0-9]{64}$/.test(value?.key ?? '')) throw new Error();
    return Buffer.from(value.key, 'hex');
  } finally { await handle.close(); }
}
export async function auditAccounts(options = config) {
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = tableNames(db); const issues = []; const add = (code, fields = {}) => issues.push({ code, ...fields });
    const runs = rows(db, tables, 'runs'); const revocations = rows(db, tables, 'account_revocations');
    const accounts = rows(db, tables, 'accounts'); const versions = rows(db, tables, 'account_versions'); const credentials = rows(db, tables, 'account_credentials');
    const identities = rows(db, tables, 'account_native_identities'); const bindings = rows(db, tables, 'run_account_bindings'); const snapshots = rows(db, tables, 'run_agent_snapshots');
    if (!tables.has('accounts') || !tables.has('run_planner_snapshots')) add('MIGRATION_PENDING');
    if (db.pragma('quick_check', { simple: true }) !== 'ok') add('DATABASE_INTEGRITY_FAILED');
    let key = null;
    if (credentials.length) { try { key = await masterMaterial(options.accounts.privateDir, options.accounts.masterKey); } catch { add('MASTER_KEY_UNAVAILABLE'); } }
    const keyId = key ? hash(key).slice(0, 32) : null;
    for (const credential of credentials) {
      if (!key) continue;
      try {
        if (keyId !== credential.key_id) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(credential.nonce, 'base64'));
        cipher.setAAD(Buffer.from(JSON.stringify(['agent-gand-account-v1', credential.account_id, credential.version, credential.key_id])));
        cipher.setAuthTag(Buffer.from(credential.tag, 'base64'));
        cipher.update(Buffer.from(credential.ciphertext, 'base64')); cipher.final();
      } catch { add('CREDENTIAL_LOCKED', { accountId: credential.account_id, version: credential.version }); }
    }
    for (const account of accounts) {
      if (!versions.some((v) => v.account_id === account.id && v.version === account.config_version)) add('ACCOUNT_CONFIG_MISSING', { accountId: account.id });
      if (account.credential_version !== null && !credentials.some((v) => v.account_id === account.id && v.version === account.credential_version)) add('ACCOUNT_CREDENTIAL_MISSING', { accountId: account.id });
      if (account.identity_generation != null && !identities.some((v) => v.account_id === account.id && v.generation === account.identity_generation)) add('ACCOUNT_IDENTITY_MISSING', { accountId: account.id });
    }
    for (const item of identities.filter((i) => i.status === 'authenticated')) {
      const info = await present(item.directory);
      if (!info?.isDirectory() || info.isSymbolicLink()) add('IDENTITY_DIRECTORY_MISSING', { accountId: item.account_id, generation: item.generation });
    }
    const definitions = [...snapshots, ...rows(db, tables, 'run_planner_snapshots').filter((r) => r.definition !== null).map((r) => ({ ...r, agent_id: 'system:coordination-planner' }))];
    for (const snapshot of definitions) {
      const agent = json(snapshot.definition);
      if (!agent) { add('SNAPSHOT_INVALID', { runId: snapshot.run_id, agentId: snapshot.agent_id }); continue; }
      if (agent.accountRef && !agent.accountRef.startsWith('legacy-') && !bindings.some((b) => b.run_id === snapshot.run_id && b.agent_id === snapshot.agent_id && b.account_id === agent.accountRef)) add('RUN_BINDING_MISSING', { runId: snapshot.run_id, agentId: snapshot.agent_id });
    }
    for (const binding of bindings) {
      const fields = { runId: binding.run_id, agentId: binding.agent_id, accountId: binding.account_id };
      const captured = json(definitions.find((s) => s.run_id === binding.run_id && s.agent_id === binding.agent_id)?.definition);
      const backend = captured?.execution?.kind === 'external' ? captured.execution.driver : captured?.model?.startsWith('anthropic:') ? 'builtin-anthropic' : captured?.model?.startsWith('openai:') ? 'builtin-openai' : null;
      if (!captured || captured.accountRef !== binding.account_id || backend !== binding.backend) add('RUN_BINDING_SNAPSHOT_MISMATCH', fields);
      if (!versions.some((v) => v.account_id === binding.account_id && v.version === binding.config_version)) add('RUN_CONFIG_MISSING', fields);
      const account = accounts.find((a) => a.id === binding.account_id);
      const terminal = runs.find((r) => r.id === binding.run_id);
      // Retired historical credentials are intentional; active recovery still needs its exact versions.
      if (terminal && !['completed', 'failed', 'cancelled'].includes(terminal.status)) {
        if (!account || account.archived || revocations.some((r) => r.account_id === binding.account_id)) add('ACTIVE_RUN_ACCOUNT_UNAVAILABLE', fields);
        if (binding.credential_version !== null && !credentials.some((v) => v.account_id === binding.account_id && v.version === binding.credential_version)) add('RUN_CREDENTIAL_MISSING', fields);
        if (binding.identity_generation !== null && !identities.some((v) => v.account_id === binding.account_id && v.generation === binding.identity_generation && v.status === 'authenticated')) add('RUN_IDENTITY_MISSING', fields);
      }
    }
    const roles = rows(db, tables, 'agents').map((r) => ({ row: r, def: json(r.definition) }));
    for (const role of roles) {
      if (!role.def) add('ROLE_INVALID', { agentId: role.row.id });
      else if (role.def.requiresAccount && !role.def.accountRef && role.row.enabled) add('ENABLED_ROLE_UNBOUND', { agentId: role.row.id });
      else if (role.def.accountRef && !role.def.accountRef.startsWith('legacy-') && !accounts.some((a) => a.id === role.def.accountRef)) add('ROLE_ACCOUNT_MISSING', { agentId: role.row.id });
    }
    for (const run of runs) {
      const ids = json(run.agent_ids);
      if (!Array.isArray(ids)) add('RUN_MEMBERS_INVALID', { runId: run.id });
      else for (const id of ids) if (!snapshots.some((s) => s.run_id === run.id && s.agent_id === id)) add('RUN_SNAPSHOT_MISSING', { runId: run.id, agentId: id });
    }
    return { readOnly: true, providerRequests: 0, ok: issues.length === 0, counts: { accounts: accounts.length, credentials: credentials.length, identities: identities.length, bindings: bindings.length, roles: roles.length, runs: runs.length, legacyRoles: roles.filter((r) => r.def && !r.def.requiresAccount && (!r.def.accountRef || r.def.accountRef.startsWith('legacy-')) && !r.def.model?.startsWith('mock:')).length, unboundDrafts: roles.filter((r) => r.def?.requiresAccount && !r.def.accountRef && !r.row.enabled).length }, issues };
  } finally { db.close(); }
}
export async function backupAccounts(output, options = config) {
  if (!output) throw new Error('请用 --output 指定一个新的备份目录');
  const target = path.resolve(output); const parent = await realpath(path.dirname(target));
  const canonicalTarget = path.join(parent, path.basename(target));
  const sources = [
    ['private', options.accounts.privateDir], ['roles', options.agentsDir], ['avatars', path.join(path.dirname(options.dbPath), 'avatars')],
    ['legacy-codex', options.externalAgents.codexHome], ['legacy-claude', options.externalAgents.claudeHome],
  ];
  for (const [, source] of sources) { if (await present(source)) { const canonical = await realpath(source); if (canonicalTarget === canonical || canonicalTarget.startsWith(canonical + path.sep)) throw new Error('备份目录不能位于被备份目录内'); } }
  const dbInfo = await lstat(options.dbPath); if (!dbInfo.isFile() || dbInfo.isSymbolicLink() || dbInfo.nlink !== 1) throw new Error('数据库必须是普通文件');
  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true }); let created = false;
  try {
    const tables = tableNames(db); assertOffline(db, tables);
    const audit = await auditAccounts(options);
    if (audit.issues.some((i) => ['MASTER_KEY_UNAVAILABLE', 'CREDENTIAL_LOCKED', 'IDENTITY_DIRECTORY_MISSING', 'DATABASE_INTEGRITY_FAILED'].includes(i.code))) throw new Error('私有认证材料缺失或无法校验，请先恢复后再备份');
    const dataVersion = db.pragma('data_version', { simple: true });
    await mkdir(target, { mode: 0o700 }); created = true; await chmod(target, 0o700);
    const files = []; const manifestSources = []; const digest = async (file, relative) => { await chmod(file, 0o600); const bytes = await readFile(file); files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); };
    async function copyTree(source, relative) {
      const info = await lstat(source);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error('备份源含符号链接、硬链接或特殊文件，已停止');
      const destination = path.join(target, relative);
      if (info.isDirectory()) { await mkdir(destination, { mode: 0o700 }); for (const name of (await readdir(source)).sort()) await copyTree(path.join(source, name), path.join(relative, name)); }
      else { await copyFile(source, destination); await digest(destination, relative); }
    }
    await db.backup(path.join(target, 'database.sqlite')); await digest(path.join(target, 'database.sqlite'), 'database.sqlite');
    manifestSources.push({ path: 'database.sqlite', restoreTo: path.resolve(options.dbPath) });
    for (const [name, source] of sources) if (await present(source)) { await copyTree(source, name); manifestSources.push({ path: name, restoreTo: path.resolve(source) }); }
    assertOffline(db, tables);
    if (db.pragma('data_version', { simple: true }) !== dataVersion) throw new Error('备份期间数据库发生变化，请确保服务停止后重试');
    await writeFile(path.join(target, '.gitignore'), '*\n', { mode: 0o600 });
    const schemaSha256 = hash(await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url)));
    let application = { schemaSha256, gitHead: null, workingTreeChanged: true };
    try { application = { schemaSha256, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeChanged: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() }; } catch {}
    const manifest = { format: 'agent-gand-accounts-backup-v1', createdAt: new Date().toISOString(), application, externalMasterKeyRequired: !!options.accounts.masterKey, sources: manifestSources, files };
    await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, output: target, fileCount: files.length, externalMasterKeyRequired: manifest.externalMasterKeyRequired };
  } catch (error) { if (created) await rm(target, { recursive: true, force: true }); throw error; }
  finally { db.close(); }
}
export async function verifyBackup(input) {
  if (!input) throw new Error('请用 --input 指定备份目录');
  const directory = path.resolve(input); const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077)) throw new Error('备份目录必须是私有普通目录');
  const files = new Map();
  async function walk(relative = '') {
    for (const name of await readdir(path.join(directory, relative))) {
      const child = path.join(relative, name); const info = await lstat(path.join(directory, child));
      if (info.isSymbolicLink() || (info.mode & 0o077) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error('备份含不安全文件或权限');
      if (info.isDirectory()) await walk(child); else files.set(child, info.size);
    }
  }
  await walk();
  const manifest = json(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest?.format !== 'agent-gand-accounts-backup-v1' || !Array.isArray(manifest.files) || !Array.isArray(manifest.sources)) throw new Error('备份清单无效');
  const checked = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..') || checked.has(entry.path) || files.get(entry.path) !== entry.bytes) throw new Error('备份文件清单不匹配');
    checked.add(entry.path);
    if (hash(await readFile(path.join(directory, entry.path))) !== entry.sha256) throw new Error('备份校验和不匹配');
  }
  if (!checked.has('database.sqlite') || [...files.keys()].some((file) => !checked.has(file) && !['manifest.json', '.gitignore'].includes(file))) throw new Error('备份文件清单不完整');
  return { ok: true, fileCount: checked.size, externalMasterKeyRequired: manifest.externalMasterKeyRequired === true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'audit' && args.length === 0) { const result = await auditAccounts(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 2; }
    else if (command === 'backup' && args.length === 2 && args[0] === '--output') console.log(JSON.stringify(await backupAccounts(args[1]), null, 2));
    else if (command === 'verify-backup' && args.length === 2 && args[0] === '--input') console.log(JSON.stringify(await verifyBackup(args[1]), null, 2));
    else throw new Error('用法：accounts:audit / accounts:backup --output <新的目录> / accounts:verify-backup --input <目录>');
  } catch (error) { console.error(error.code ? `维护操作失败（${error.code}），请检查路径和权限` : error.message); process.exitCode = 1; }
}
