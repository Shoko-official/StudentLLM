import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const repositoryRoot = process.cwd();
const binaryName = process.platform === 'win32' ? 'studentllm.exe' : 'studentllm';
const binaryPath = path.join(repositoryRoot, 'src-tauri', 'target', 'debug', binaryName);
const dataRoot = path.join(os.tmpdir(), `studentllm-wdio-${process.pid}`);

rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
mkdirSync(path.join(dataRoot, 'webview2'), { recursive: true });

const applicationEnvironment = {
  ...process.env,
  APPDATA: dataRoot,
  LOCALAPPDATA: dataRoot,
  XDG_CACHE_HOME: path.join(dataRoot, 'cache'),
  XDG_CONFIG_HOME: path.join(dataRoot, 'config'),
  XDG_DATA_HOME: dataRoot,
  GDK_BACKEND: 'x11',
  LIBGL_ALWAYS_SOFTWARE: '1',
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'webview2'),
};

if (process.platform !== 'win32') applicationEnvironment.HOME = dataRoot;
Object.assign(process.env, applicationEnvironment);

export const config = {
  runner: 'local',
  specs: [path.join(repositoryRoot, 'tests', 'desktop-ui', '*.spec.mjs')],
  maxInstances: 1,
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': {
      application: binaryPath,
    },
  }],
  services: [[
    '@wdio/tauri-service',
    {
      appBinaryPath: binaryPath,
      driverProvider: process.platform === 'win32' ? 'external' : 'embedded',
      embeddedPort: 4445,
      autoInstallTauriDriver: false,
      autoDownloadEdgeDriver: true,
      startTimeout: 60_000,
    },
  ]],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  waitforTimeout: 60_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  mochaOpts: {
    timeout: 120_000,
  },
};
