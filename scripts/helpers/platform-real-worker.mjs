import { createRequire } from 'node:module';
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import {execFileSync}from'node:child_process';
import {authDigest}from'./platform-native-refresh.mjs';
import path from 'node:path';
import { AcceptanceError } from './orchestration-acceptance.mjs';

const root = process.env.R8_ROOT;
if (!root || process.env.AGENT_GAND_ISOLATED_WORKER !== '1' || process.env.DB_PATH !== path.join(root, 'acceptance.sqlite')) throw new Error('ISOLATED_ENVIRONMENT_REQUIRED');
const [mode, sourceDb, claudeAgent, codexAccount, apiAgent] = process.argv.slice(2);
const { config } = await import('../../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
if (mode === 'serve') {
  const registry=await import('../../apps/server/src/agents/registry.ts'),api=registry.getAgent('r8-api');
  if(api&&!registry.getAnyAgent('r8-reader'))registry.createAgent({...api,id:'r8-reader',name:'R8 scoped file reader',tools:['fs.read','search.files']});
  // This opt-in fault discards one actual upstream response; it never produces simulated inference.
  const {db}=await import('../../apps/server/src/db/database.ts');
  const {getTool}=await import('../../apps/server/src/tools/builtin/index.ts'),{installRealFaults}=await import('./platform-real-faults.mjs');installRealFaults({root,db,getTool});
  await import('../../apps/server/src/index.ts');
} else if (mode === 'prepare') {
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url)), Database = require('better-sqlite3');
  const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
  const { db, closeDatabase } = await import('../../apps/server/src/db/database.ts');
  try {
    if (db.prepare('SELECT COUNT(*) n FROM accounts').get().n) throw new AcceptanceError('OUTPUT_DIRECTORY_ALREADY_USED');
    await mkdir(config.accounts.privateDir, { recursive: true, mode: 0o700 }); await chmod(config.accounts.privateDir, 0o700);
    if (!config.accounts.masterKey) {
      const key = path.join(path.dirname(sourceDb), 'private/account-master-key.json'), stat = await lstat(key);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new AcceptanceError('SOURCE_MASTER_KEY_UNSAFE');
      await copyFile(key, path.join(config.accounts.privateDir, 'account-master-key.json')); await chmod(path.join(config.accounts.privateDir, 'account-master-key.json'), 0o600);
    } else {
      // Keep the environment key private and make the standalone acceptance server able to restart.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(config.accounts.privateDir, 'account-master-key.json'), JSON.stringify({ version: 1, key: config.accounts.masterKey }), { mode: 0o600 });
    }
    const copyRow = (table, row) => { const columns = Object.keys(row); db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row)); };
    const selected = [],nativeRefresh=[];
    async function copyAccount(id) {
      if (selected.some(a => a.accountId === id)) return id;
      const account = source.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if (!account || !account.enabled || account.archived || source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(id)) throw new AcceptanceError('SOURCE_ACCOUNT_UNAVAILABLE');
      copyRow('accounts', account);
      copyRow('account_versions', source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(id, account.config_version));
      if (account.auth_type === 'api_key') {
        const row = source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(id, account.credential_version);
        if (!row) throw new AcceptanceError('SOURCE_CREDENTIAL_MISSING'); copyRow('account_credentials', row);
      } else {
        const row = source.prepare('SELECT * FROM account_native_identities WHERE account_id=? AND generation=?').get(id, account.identity_generation);
        if (!row || row.client !== 'codex' || row.status !== 'authenticated') throw new AcceptanceError('SOURCE_NATIVE_IDENTITY_UNAVAILABLE');
        const original = path.resolve(row.directory), sourcePrivate = path.resolve(path.dirname(sourceDb), 'private');
        if (!original.startsWith(sourcePrivate + path.sep)) throw new AcceptanceError('SOURCE_NATIVE_DIRECTORY_OUTSIDE_ACCOUNT_ROOT');
        const directory = path.join(config.accounts.privateDir, 'native', id, String(row.generation));
        await mkdir(path.join(directory, 'config'), { recursive: true, mode: 0o700 }); await mkdir(path.join(directory, 'login'), { recursive: true, mode: 0o700 });
        const auth = path.join(original, 'config/auth.json'), stat = await lstat(auth);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new AcceptanceError('SOURCE_NATIVE_CREDENTIAL_UNSAFE');
        const {readFile,writeFile}=await import('node:fs/promises'),authBytes=await readFile(auth);await writeFile(path.join(directory,'config/auth.json'),authBytes,{flag:'wx',mode:0o600});
        nativeRefresh.push({sourceDb,accountId:id,generation:row.generation,sourcePath:auth,copyPath:path.join(directory,'config/auth.json'),initialDigest:authDigest(authBytes)});
        copyRow('account_native_identities', { ...row, directory });
      }
      const connection = JSON.parse(source.prepare('SELECT connection FROM account_versions WHERE account_id=? AND version=?').get(id, account.config_version).connection);
      selected.push({ accountId: id, configVersion: account.config_version, credentialVersion: account.credential_version, identityGeneration: account.identity_generation, displayName: account.display_name, authType: account.auth_type, baseUrl: connection.baseUrl });
      return id;
    }
    const sdkSource = source.prepare('SELECT definition FROM agents WHERE id=? AND enabled=1').get(claudeAgent);
    const sdk = sdkSource && JSON.parse(sdkSource.definition);
    if (!sdk?.accountRef || sdk.execution?.driver !== 'claude-sdk') throw new AcceptanceError('SELECTED_CLAUDE_ROLE_REQUIRED');
    const sdkAccount = await copyAccount(sdk.accountRef), codexAccountId = await copyAccount(codexAccount);
    const apiSource = source.prepare('SELECT definition FROM agents WHERE id=? AND enabled=1').get(apiAgent), api = apiSource && JSON.parse(apiSource.definition);
    if (!api || api.execution?.kind === 'external' || /^(mock|fail):/.test(api.model)) throw new AcceptanceError('SELECTED_REAL_API_ROLE_REQUIRED');
    let apiAccount;
    if (api.accountRef) apiAccount = await copyAccount(api.accountRef);
    else {
      const anthropic = api.model.startsWith('anthropic:'), prefix = anthropic ? 'LLM_ANTHROPIC_' : 'LLM_OPENAI_', key = process.env[prefix + 'API_KEY'];
      if (!key) throw new AcceptanceError('SELECTED_LEGACY_API_CREDENTIAL_MISSING');
      const { createAccount } = await import('../../apps/server/src/accounts/store.ts');
      const account = createAccount({ displayName: 'R8 selected legacy model API', provider: anthropic ? 'anthropic' : 'openai', apiKey: key,
        baseUrl: process.env[prefix + 'BASE_URL'] || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'), protocols: [anthropic ? 'anthropic-messages' : 'openai-chat'], models: [api.model.split(':').slice(1).join(':')], defaultModel: api.model.split(':').slice(1).join(':'), timeoutMs: config.externalAgents.timeoutMs });
      apiAccount = account.id; selected.push({ accountId: apiAccount, sourceRole: apiAgent, source: 'selected_legacy_environment', configVersion: 1, credentialVersion: 1, baseUrl: account.connection.baseUrl });
    }
    const registry = await import('../../apps/server/src/agents/registry.ts');
    const role = (id, model, accountRef, driver, writing = false) => ({ id, name: id, description: 'R8 isolated real supplier acceptance',
      systemPrompt: 'Complete only the frozen assignment. Give concise substantive results, at most 100 words. Do not delegate or use ordinary tools unless the assignment requires a scoped file. If agent.complete is available, finish once with the actual answer as summary.',
      model, accountRef, requiresAccount: true, capabilities: ['execute'], permissionMode: writing ? driver==='codex-app-server'?'confirm':'auto' : 'readonly',
      tools: writing ? ['fs.read', 'fs.write', 'search.files'] : [], disallowedTools: [], color: '#4477aa', avatar: '',
      execution: driver ? { kind: 'external', driver, nativeTools: [], platformTools: writing ? ['fs.read', 'fs.write', 'search.files'] : [], sessionPolicy: 'conversation' } : { kind: 'builtin-llm' } });
    registry.createAgent(role('r8-sdk', sdk.model, sdkAccount, 'claude-sdk'));
    // Enabling a role does not refresh native tokens or initiate a model turn.
    registry.createAgent({ ...role('r8-codex', 'default', codexAccountId, 'codex-app-server'), enabled: false });
    db.prepare('UPDATE agents SET enabled=1 WHERE id=?').run('r8-codex');
    registry.createAgent(role('r8-api', api.model, apiAccount));
    registry.createAgent(role('r8-writer', sdk.model, sdkAccount, 'claude-sdk', true));
    if(process.env.R8_CAMPAIGN==='codex-write'){registry.createAgent({...role('r8-codex-writer','default',codexAccountId,'codex-app-server',true),enabled:false});db.prepare('UPDATE agents SET enabled=1 WHERE id=?').run('r8-codex-writer');}
    // An isolated DB trigger stops admission before startModelCall returns and before provider/native I/O.
    const limit = Number(process.env.R8_MAX_STARTS), deadline = Number(process.env.R8_DEADLINE);
    if (!Number.isSafeInteger(limit) || limit < 3 || limit > 30 || !Number.isSafeInteger(deadline)) throw new AcceptanceError('INVALID_EXECUTION_LIMIT');
    db.exec(`CREATE TRIGGER r8_acceptance_start_limit BEFORE UPDATE OF started_at ON orchestration_model_calls
      WHEN NEW.started_at IS NOT NULL AND OLD.started_at IS NULL AND
      ((SELECT COUNT(*) FROM orchestration_model_calls WHERE started_at IS NOT NULL)>=${limit} OR
        CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)>${deadline})
      BEGIN SELECT RAISE(ABORT,'R8_ACCEPTANCE_EXECUTION_LIMIT'); END;`);
    await mkdir(config.agentsDir, { recursive: true });
    let workspace;
    if(['recovery','codex-write'].includes(process.env.R8_CAMPAIGN)){
      const {writeFile}=await import('node:fs/promises');const sourceRoot=path.join(root,'workspace-source');await mkdir(sourceRoot);await writeFile(path.join(sourceRoot,'README.md'),'R8 disposable recovery baseline\n');
      for(const args of [['init','-q',sourceRoot],['-C',sourceRoot,'add','.'],['-C',sourceRoot,'-c','core.hooksPath=/dev/null','-c','user.name=R8 Acceptance','-c','user.email=r8@example.invalid','commit','-qm','R8 baseline']])execFileSync('git',args,{stdio:'ignore'});
      const {registerExternal}=await import('../../apps/server/src/workspaces/external.ts');workspace='ext:'+registerExternal({path:sourceRoot,trusted:true}).id;
    }
    process.send?.({ type: 'prepared', accounts: selected,workspace,nativeRefresh });
  } catch (error) { process.send?.({ type: 'error', code: error instanceof AcceptanceError ? error.code : 'PREPARATION_CHECK_FAILED',details:error.fieldErrors??null }); process.exitCode = 1; }
  finally { source.close(); closeDatabase(); }
} else throw new Error('INVALID_WORKER_MODE');
