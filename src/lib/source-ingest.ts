import { Resource, ResourceKind } from '../types';

export interface SourceFileLike {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export type DigestFunction = (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;

function sourceKind(file: SourceFileLike): ResourceKind {
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'text/plain' || file.type === 'text/markdown' || /\.(txt|md)$/i.test(file.name)) return 'transcript';
  return 'document';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(file: SourceFileLike, digest: DigestFunction = crypto.subtle.digest.bind(crypto.subtle)) {
  return toHex(await digest('SHA-256', await file.arrayBuffer()));
}

export async function createSourceResource(file: SourceFileLike, digest?: DigestFunction): Promise<Resource> {
  const kind = sourceKind(file);
  const hash = await sha256(file, digest);
  const typeLabel = kind === 'audio' ? 'Audio' : kind === 'image' ? 'Image' : kind === 'transcript' ? 'Text' : 'Document';
  return {
    id: `source-${hash.slice(0, 16)}`,
    name: file.name,
    meta: `${typeLabel} · ${formatBytes(file.size)}`,
    kind,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    sha256: hash,
    lastModified: file.lastModified,
  };
}
