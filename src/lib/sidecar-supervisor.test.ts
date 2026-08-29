import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getManagedSidecarStatus, startManagedSidecars, stopManagedSidecars } from './sidecar-supervisor';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('sidecar supervisor bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does not call native commands in the browser runtime', async () => {
    expect(await getManagedSidecarStatus()).toEqual([]);
    expect(await startManagedSidecars()).toEqual([]);
    expect(await stopManagedSidecars()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('maps native lifecycle commands to the Tauri bridge', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    const statuses = [{ kind: 'asr', configured: true, running: true, pid: 42, detail: 'Managed process is running.' }];
    invoke.mockResolvedValue(statuses);

    expect(await getManagedSidecarStatus()).toEqual(statuses);
    expect(await startManagedSidecars()).toEqual(statuses);
    expect(await stopManagedSidecars()).toEqual(statuses);
    expect(invoke).toHaveBeenNthCalledWith(1, 'sidecar_status');
    expect(invoke).toHaveBeenNthCalledWith(2, 'start_sidecars');
    expect(invoke).toHaveBeenNthCalledWith(3, 'stop_sidecars');
  });
});
