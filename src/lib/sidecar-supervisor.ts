import { invoke } from '@tauri-apps/api/core';
import { isNativeRuntime } from './workspace-storage';

export interface ManagedSidecarStatus {
  kind: 'asr' | 'documents';
  configured: boolean;
  running: boolean;
  pid?: number;
  detail: string;
}

export async function getManagedSidecarStatus(): Promise<ManagedSidecarStatus[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ManagedSidecarStatus[]>('sidecar_status');
}

export async function startManagedSidecars(): Promise<ManagedSidecarStatus[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ManagedSidecarStatus[]>('start_sidecars');
}

export async function stopManagedSidecars(): Promise<ManagedSidecarStatus[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ManagedSidecarStatus[]>('stop_sidecars');
}
