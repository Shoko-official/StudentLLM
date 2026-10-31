import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { productionCspHeader } from './src/test/tauri-csp';

// The CSP project needs a production build and a second server, so it only exists when it is asked for:
// `npm run test:e2e:csp`, `--project=csp`, or STUDENTLLM_E2E_CSP=true. The default run stays on the dev server.
const args = process.argv.slice(2);
const cspRequested = process.env.STUDENTLLM_E2E_CSP === 'true'
  || args.some((arg, index) => arg === '--project=csp' || ((arg === '--project' || arg === '-p') && args[index + 1] === 'csp'));
// Test workers re-read this file; the environment variable keeps them on the same project list.
if (cspRequested) process.env.STUDENTLLM_E2E_CSP = 'true';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: process.env.CI ? undefined : 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: /csp\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    // Runs against the production build with the packaged app's Content Security Policy as a response header.
    ...(cspRequested ? [{ name: 'csp', testMatch: /csp\.spec\.ts$/, use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4174' } }] : []),
  ],
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173',
      env: {
        ...process.env,
        VITE_LM_STUDIO_AUTO_CONNECT: 'false',
      },
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    ...(cspRequested ? [{
      // A separate output directory keeps this build from replacing a developer's dist/ folder.
      command: 'npx vite build --outDir dist-csp --emptyOutDir && npx vite preview --outDir dist-csp --host 127.0.0.1 --port 4174 --strictPort',
      env: {
        ...process.env,
        STUDENTLLM_PREVIEW_CSP: productionCspHeader(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))),
      },
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 180_000,
    }] : []),
  ],
});
