# Local document extraction

StudentLLM sends imported sources to a local extraction sidecar. The original file is retained, while each extracted page or logical document section becomes a reviewable transcript segment with source and page provenance.

The sidecar currently supports digital and scanned PDFs, images, plain text, Markdown, HTML, RTF, DOCX, and PPTX. PDFs use PyMuPDF, scanned pages and images use RapidOCR when installed, and Office formats are read from their native XML packages. Headings, lists, tables, slide boundaries, and formula-like PDF regions are preserved as typed blocks instead of being flattened immediately into one text string. Formula reconstruction remains source-faithful: ambiguous glyphs stay as extracted text rather than being guessed.

The service accepts documents up to 100 MB and rejects oversized or malformed Office archives before parsing. It binds to localhost by default and only grants browser access to the local application origins. A document that cannot be extracted is still retained as the original source, with a recoverable error shown in the workspace.

## Start the sidecar

Install the local document dependencies in an isolated Python environment:

```powershell
.\.venv-bench-sys\Scripts\python.exe -m pip install -r requirements-local-documents.txt
.\.venv-bench-sys\Scripts\python.exe scripts/local_document_server.py --port 8766
```

The service listens on `http://127.0.0.1:8766`. In development, the web app uses this address by default, so importing a PDF works as soon as the sidecar is running. It exposes:

- `GET /health` for readiness and the capabilities actually installed;
- `POST /extract` with PDF, image, text, Markdown, HTML, RTF, DOCX, or PPTX bytes.

The server is local-only by default and does not overwrite the original source blob. Its readiness response identifies the active extractor and its capabilities.

## Connect the web app

Before starting Vite, configure the optional endpoint:

```powershell
$env:VITE_LOCAL_DOCUMENT_BASE_URL = 'http://127.0.0.1:8766'
npm run dev
```

For a Tauri desktop build, configure the optional document service command before launch:

```powershell
$env:STUDENTLLM_DOCUMENT_COMMAND = 'python scripts/local_document_server.py --port 8766'
```

The desktop service tray can start or stop only the process launched by StudentLLM. The service command is not enabled unless this variable is set.

Importing a supported document saves the original file first. If extraction succeeds, the UI adds one reviewable segment per non-empty page or logical section. Structured blocks feed the note renderer and the retrieval index; source-linked visuals are rendered only when their values and relationships are present in the extracted evidence. If the sidecar is unavailable, the source remains saved and the transcript is unchanged. The app opens Settings and identifies the document sidecar as offline so it can be started or refreshed without losing the imported file.

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

For an image, the response model is `rapidocr`. For a scanned PDF with no text layer, it is `pymupdf+rapidocr`. Text and Office sources use `text`, `text-markdown`, `html-text`, `rtf-text`, `docx-xml`, or `pptx-xml`.

Typed blocks may include `heading`, `paragraph`, `list`, `code`, `formula`, or `table`. A table carries a `rows` matrix so the UI can render a real table and the RAG index can retain cell-level terms.

Run the contract and UI tests with:

```powershell
npm run test:run -- src/lib/document-engine.test.ts src/App.test.tsx
```
