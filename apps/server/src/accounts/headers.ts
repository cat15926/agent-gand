import type { AccountConnection } from '@agent-gand/shared';

export function anthropicAuthHeaders(apiKey: string, connection: Pick<AccountConnection, 'authHeader'>): Record<string, string> {
  return connection.authHeader === 'bearer' ? { authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey };
}
