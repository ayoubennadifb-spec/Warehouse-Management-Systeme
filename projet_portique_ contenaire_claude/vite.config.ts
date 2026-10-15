import { defineConfig } from 'vite';
import path from 'node:path';

const port = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/client'),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: false } },
  },
});
