import { describe, expect, it } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import webdriverConfig from '../../src-tauri/tauri.webdriver.conf.json';
import windowsConfig from '../../src-tauri/tauri.windows.conf.json';

// Tauri creates a window declared in the configuration itself, without the `on_new_window` hook that only a window builder can set.
// `create_windows` in src-tauri/src/lib.rs builds every declared window in code, so each must say `"create": false`; a window that
// does not would be created twice (and the first one would allow `window.open` and `target="_blank"`). The WebDriver configuration
// replaces the whole `windows` array when it is merged, so it needs the setting too.
describe('Tauri window configuration', () => {
  const declared: Array<[string, Array<{ label?: string; create?: boolean }>]> = [
    ['tauri.conf.json', tauriConfig.app.windows],
    ['tauri.webdriver.conf.json', webdriverConfig.app.windows],
  ];

  it.each(declared)('%s creates its windows in code, not from the configuration', (_name, windows) => {
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) expect(window.create).toBe(false);
  });

  it.each(declared)('%s labels its window "main", the label the capability file and the single-instance handler use', (_name, windows) => {
    expect(windows.map((window) => window.label ?? 'main')).toEqual(['main']);
  });

  it('keeps the Windows overrides from declaring a window of their own', () => {
    expect(windowsConfig).not.toHaveProperty('app');
  });
});
