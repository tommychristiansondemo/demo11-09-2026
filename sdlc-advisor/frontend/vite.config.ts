import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, assetsInlineLimit: 0, target: 'es2020' },
  test: { environment: 'jsdom' },
} as never);
