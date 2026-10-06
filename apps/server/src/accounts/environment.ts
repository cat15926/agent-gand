/** Start from a purpose-specific allowlist; no provider route or secret is inherited. */
export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (process.env.NODE_ENV === 'test' && /^(?:FAKE_|TEST_D_)/.test(name)) { env[name] = value; continue; }
    if (/^(?:NODE_ENV|PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TERM|TMPDIR|TMP|TEMP|TZ|SystemRoot|ComSpec|PATHEXT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}
export const protectedEnvironmentNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'GAND_INFERENCE_TOKEN', 'AGENT_GAND_BRIDGE_TOKEN', 'ACCOUNT_MASTER_KEY', 'ACCOUNT_ADMIN_TOKEN'];
