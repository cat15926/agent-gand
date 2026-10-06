import { createServer } from '../apps/web/node_modules/vite/dist/node/index.js';
import { createDemoEnvironment } from './helpers/orchestration-demo-environment.mjs';

let environment, web;
try {
  environment = await createDemoEnvironment();
  await environment.app.listen({ host: '127.0.0.1', port: 3011 });
  web = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, configFile: false,
    plugins: [(await import('../apps/web/node_modules/@vitejs/plugin-react/dist/index.js')).default(), (await import('../apps/web/node_modules/@tailwindcss/vite/dist/index.mjs')).default()],
    server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3011', '/ws': { target: 'ws://127.0.0.1:3011', ws: true } } } });
  await web.listen();
  console.log('O7 隔离演示：http://127.0.0.1:5174（模拟模型和原生驱动，真实供应商请求为零）');
  console.log('原业务数据保持独立；退出后删除本次演示数据库、工作区和模拟账户。');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await web.close(); await environment.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch (error) {
  console.error(error.code ? `演示启动失败：${error.code}` : error.message);
  await web?.close(); await environment?.close(); process.exitCode = 1;
}
