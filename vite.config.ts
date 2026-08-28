import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const configuredBaseUrl = env.LM_STUDIO_BASE_URL?.trim() || 'http://127.0.0.1:1234/v1';
  let proxyTarget = 'http://127.0.0.1:1234';

  const origin = configuredBaseUrl.match(/^https?:\/\/[^/]+/i)?.[0];
  if (origin) {
    proxyTarget = origin;
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/lm-studio': {
          target: proxyTarget,
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
  };
});
