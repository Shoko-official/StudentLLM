import type { DocumentPageImage } from './nim-document-engine';

const MAX_SIDE = 1800;
const MAX_PAGES = 100;

function imageCanvas(width: number, height: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Document image rendering is unavailable in this browser.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context, scale };
}

/** Decode locally; only the resulting bounded page images are sent after per-file consent. */
export async function* renderDocumentImages(blob: Blob, signal: AbortSignal): AsyncGenerator<DocumentPageImage> {
  signal.throwIfAborted();
  if (blob.type.startsWith('image/')) {
    if (blob.size > 20 * 1024 * 1024) throw new Error('NVIDIA analysis accepts images up to 20 MB. Resize this image or use local OCR.');
    const image = await createImageBitmap(blob);
    try {
      signal.throwIfAborted();
      const { canvas, context } = imageCanvas(image.width, image.height);
      try {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        yield { pageNumber: 1, totalPages: 1, imageData: canvas.toDataURL('image/jpeg', 0.92) };
      } finally { canvas.width = 0; canvas.height = 0; }
    } finally { image.close(); }
    return;
  }
  if (blob.type !== 'application/pdf') throw new Error('NVIDIA document analysis supports PDF and image sources. Other files use local extraction.');
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  signal.throwIfAborted();
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: await blob.arrayBuffer(), stopAtErrors: true });
  const cancel = () => { void task.destroy().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) throw new Error('NVIDIA analysis supports up to 100 PDF pages. Split this file or use local extraction.');
    for (let number = 1; number <= pdf.numPages; number += 1) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_SIDE / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale });
      const { canvas, context } = imageCanvas(viewport.width, viewport.height);
      try {
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        signal.throwIfAborted();
        yield { pageNumber: number, totalPages: pdf.numPages, imageData: canvas.toDataURL('image/jpeg', 0.92) };
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await task.destroy();
  }
}
