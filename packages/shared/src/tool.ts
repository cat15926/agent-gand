/** MCP 外部工具连接状态，供服务端健康检查与角色管理界面共用。 */
export interface McpStatus {
  configured: boolean;
  connected: boolean;
  tools: string[];
  serverPid: number | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSeenAt: string | null;
}
