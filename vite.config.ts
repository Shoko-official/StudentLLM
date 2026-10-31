import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { nvidiaNimProxy } from './server/nvidia-nim-proxy.ts';

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
    base: './',
    plugins: [react(), nvidiaNimProxy()],
    server: {
      proxy: {
        '/lm-studio': {
          target: proxyTarget,
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/lm-studio/, ''),
        },
      },
    },
    // The CSP browser tests serve the production build with the packaged app's policy (see playwright.config.ts).
    preview: env.STUDENTLLM_PREVIEW_CSP ? { headers: { 'Content-Security-Policy': env.STUDENTLLM_PREVIEW_CSP } } : {},
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      globals: true,
      css: true,
      // scripts/ holds node:test files (run by npm run licenses:test) that vitest must not collect.
      exclude: ['tests/e2e/**', 'tests/desktop-ui/**', 'node_modules/**', 'dist/**', 'cloud/**', 'scripts/**'],
    },
  };
});
