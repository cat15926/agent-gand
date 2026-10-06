/** Public account contracts. Secrets and native authentication paths are server-only. */
export type AccountProvider = 'anthropic' | 'openai' | 'custom';
export type AccountAuthType = 'api_key' | 'native_login';
export type AccountProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
export type AccountSource = 'managed' | 'legacy_env' | 'legacy_native';
export type AccountBackend = 'builtin-anthropic' | 'builtin-openai' | 'claude-sdk' | 'claude-cli' | 'codex-app-server' | 'codex-exec';

export interface AccountConnection {
  baseUrl: string;
  /** Anthropic Messages authentication; omitted preserves existing x-api-key behavior. */
  authHeader?: 'x-api-key' | 'bearer';
  protocols: AccountProtocol[];
  models: string[];
  defaultModel: string | null;
  timeoutMs: number;
}
export interface AccountView {
  id: string;
  displayName: string;
  provider: AccountProvider;
  authType: AccountAuthType;
  source: AccountSource;
  enabled: boolean;
  archived: boolean;
  version: number;
  configVersion: number;
  credentialVersion: number | null;
  connection: AccountConnection;
  hasCredential: boolean;
  keySuffix: string | null;
  authentication: 'configured' | 'missing' | 'locked' | 'unchecked' | 'pending' | 'authenticated' | 'expired';
  testStatus: 'untested' | 'passed' | 'failed' | 'stale';
  lastTest?: AccountTestResult | null;
  compatibleBackends: AccountBackend[];
  nativeClient: 'claude' | 'codex' | null;
  identityGeneration?: number | null;
  identitySummary?: string | null;
  revoked?: boolean;
  roleCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface AccountInput extends AccountConnection {
  displayName: string;
  provider: AccountProvider;
  apiKey: string;
}
export interface AccountReferences {
  roles: Array<{ id: string; name: string; enabled: boolean; implicit: boolean }>;
  activeRuns: Array<{ id: string; status: string }>;
  historicalRunCount: number;
  historicalRoleVersionCount: number;
}
export interface AccountListResponse {
  accounts: AccountView[];
  /** Runtime capabilities used to filter the role creation selector. */
  features: { roleBinding: boolean; nativeLogin: boolean; liveTest: boolean };
}
export interface AccountCheck {
  ok: boolean;
  configuration: 'valid';
  authentication: AccountView['authentication'];
  testedModel: false;
  checkedAt: string;
}

export interface RunAccountBinding {
  runId: string; agentId: string; accountId: string; configVersion: number;
  credentialVersion: number | null; identityGeneration: number | null;
  backend: AccountBackend; model: string;
}
export interface NativeAccountInput {
  displayName: string; authType: 'native_login'; nativeClient: 'claude' | 'codex';
}
export interface AccountLoginOperation {
  id: string; accountId: string; client: 'claude' | 'codex';
  status: 'starting' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'interrupted';
  generation: number; verificationUrl: string | null; userCode: string | null;
  error: string | null; expiresAt: string;
  terminalCommand?: string;
}
export interface AccountTestResult {
  backend: AccountBackend; model: string; status: 'passed' | 'failed' | 'stale';
  configVersion: number; credentialVersion: number | null; identityGeneration: number | null;
  testedAt: string; error: string | null;
}
