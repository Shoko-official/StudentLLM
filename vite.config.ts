import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/lm-studio': {
        target: 'http://127.0.0.1:1234',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/lm-studio/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    css: true,
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
