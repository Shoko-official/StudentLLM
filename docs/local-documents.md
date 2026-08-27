# Local PDF extraction

StudentLLM can send imported digital PDFs to a local PyMuPDF sidecar. Each page with extracted text becomes a reviewable transcript segment, with the source filename and page number preserved for retrieval and citations.

This adapter handles PDFs with a text layer. It does not perform OCR on scanned pages, handwriting, formulas, tables, or images. Those paths require a dedicated document-vision engine and remain explicit follow-up work.

## Start the sidecar

Install PyMuPDF in an isolated Python environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install PyMuPDF
.\.venv-bench-sys\Scripts\python.exe scripts/local_document_server.py --port 8766
```

The service listens on `http://127.0.0.1:8766` and exposes:

- `GET /health` for readiness;
- `POST /extract` with an `application/pdf` body.

The server is local-only by default and does not overwrite the original source blob.

## Connect the web app

Before starting Vite, configure the optional endpoint:

```powershell
$env:VITE_LOCAL_DOCUMENT_BASE_URL = 'http://127.0.0.1:8766'
npm run dev
```

Importing a PDF saves the original file first. If extraction succeeds, the UI adds one reviewable segment per non-empty page. If the sidecar is unavailable, the PDF remains saved and the transcript is unchanged.

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

Run the contract and UI tests with:

```powershell
npm run test:run -- src/lib/document-engine.test.ts src/App.test.tsx
```
