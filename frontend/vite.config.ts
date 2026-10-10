import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.APPANROM_API ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // runtime/, examples/ and spec/ live outside frontend/ and are imported as source.
    fs: { allow: ['..'] },
    proxy: { '/api': api, '/health': api },
  },
  build: { chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
