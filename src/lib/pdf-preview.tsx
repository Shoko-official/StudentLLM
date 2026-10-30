import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPreviewProps {
  blob: Blob;
  initialPage?: number;
}

export function PdfPreview({ blob, initialPage = 1 }: PdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    setLoading(true);
    setError('');
    setDocumentProxy(null);
    setPageNumber(Math.max(1, initialPage));

    void blob.arrayBuffer().then((data) => {
      loadingTask = getDocument({ data });
      return loadingTask.promise;
    }).then((loadedDocument) => {
      if (cancelled) {
        void loadingTask?.destroy();
        return;
      }
      setDocumentProxy(loadedDocument);
      setPageNumber(Math.min(Math.max(1, initialPage), loadedDocument.numPages));
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setError('This PDF could not be rendered in the workspace. Download the original file to open it externally.');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      setDocumentProxy(null);
    };
  }, [blob, initialPage]);

  useEffect(() => {
    if (!documentProxy || !canvasRef.current) return;
    let cancelled = false;
    setLoading(true);
    void documentProxy.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const devicePixelRatio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: 1.35 });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * devicePixelRatio);
      canvas.height = Math.floor(viewport.height * devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      return page.render({ canvas, canvasContext: context, viewport }).promise;
    }).then(() => {
      if (!cancelled) setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setError('This PDF page could not be rendered. Download the original file to open it externally.');
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [documentProxy, pageNumber]);

  if (error) return <p className="source-preview-error">{error}</p>;
  if (!documentProxy) return <p className="source-preview-loading">{loading ? 'Rendering PDF…' : 'Preparing PDF preview…'}</p>;

  return (
    <div className="pdf-preview" aria-label="PDF preview">
      <div className="pdf-preview-toolbar">
        <button type="button" className="secondary-action" onClick={() => setPageNumber((current) => Math.max(1, current - 1))} disabled={pageNumber <= 1}>Previous</button>
        <span>Page {pageNumber} of {documentProxy.numPages}</span>
        <button type="button" className="secondary-action" onClick={() => setPageNumber((current) => Math.min(documentProxy.numPages, current + 1))} disabled={pageNumber >= documentProxy.numPages}>Next</button>
      </div>
      <div className="pdf-preview-page">
        {loading && <span className="pdf-preview-status">Rendering page…</span>}
        <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
      </div>
    </div>
  );
}
