# Local document extraction

StudentLLM can send imported PDFs and images to a local PyMuPDF and RapidOCR sidecar. Each page with extracted text becomes a reviewable transcript segment, with the source filename and page number preserved for retrieval and citations.

Digital PDFs use PyMuPDF text extraction. Scanned PDF pages and images use RapidOCR when the local OCR dependencies are installed. OCR output is text with bounding boxes; handwriting, formulas, table structure, diagram understanding, and document-level layout semantics still require specialized engines.

## Start the sidecar

Install the local document dependencies in an isolated Python environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install -r requirements-local-documents.txt
.\.venv-bench-sys\Scripts\python.exe scripts/local_document_server.py --port 8766
```

The service listens on `http://127.0.0.1:8766` and exposes:

- `GET /health` for readiness;
- `POST /extract` with an `application/pdf` or `image/*` body.

The server is local-only by default and does not overwrite the original source blob. Its readiness response identifies the combined `pymupdf+rapidocr` service.

## Connect the web app

Before starting Vite, configure the optional endpoint:

```powershell
$env:VITE_LOCAL_DOCUMENT_BASE_URL = 'http://127.0.0.1:8766'
npm run dev
```

Importing a PDF or image saves the original file first. If extraction succeeds, the UI adds one reviewable segment per non-empty page. If the sidecar is unavailable, the source remains saved and the transcript is unchanged.

Open Settings and choose `Refresh local services` to check the configured document sidecar `/health` endpoint without interrupting the service. The UI reports readiness, the advertised engine, or the failure detail.

## Observed live check

On 2026-08-27, the browser path was exercised with the public [Attention Is All You Need PDF](https://arxiv.org/abs/1706.03762). The sidecar returned HTTP 200 with model `pymupdf` and 15 pages; the UI stored `attention-public.pdf`, indexed all 15 pages, rendered the `Page 1` review segment, and reported no page errors. The original PDF remains a local ignored test artifact.

## Contract

The browser adapter is implemented in `src/lib/document-engine.ts` and expects a response shaped like:

```json
{
  "model": "pymupdf",
  "pages": [
    {
      "pageNumber": 1,
      "text": "Extracted page text",
      "blocks": [
        { "x": 72, "y": 72, "width": 240, "height": 14, "text": "Extracted page text" }
      ]
    }
  ]
}
```

For an image, the response model is `rapidocr`. For a scanned PDF with no text layer, it is `pymupdf+rapidocr`.

Run the contract and UI tests with:

```powershell
npm run test:run -- src/lib/document-engine.test.ts src/App.test.tsx
```
