import { defineConfig } from 'vite';

const apiPort = Number(process.env.TC_GIGAHACK_API_PORT || 3001);

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
