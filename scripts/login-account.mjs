import { runTerminalLogin } from '../apps/server/src/accounts/login.ts';
import { closeDatabase } from '../apps/server/src/db/database.ts';
try {
  await runTerminalLogin(process.argv[2] ?? '');
  console.log('独立 Claude 登录已完成，请回到账户页面刷新。');
} catch (error) { console.error(error instanceof Error ? error.message : '登录失败'); process.exitCode = 1; }
finally { closeDatabase(); }
