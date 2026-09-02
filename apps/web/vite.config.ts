import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// dev 5173，/api 与 /ws 代理到 server 3010（见 docs/scaffold-plan.md §1）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3010',
      '/ws': { target: 'ws://localhost:3010', ws: true },
    },
  },
});
