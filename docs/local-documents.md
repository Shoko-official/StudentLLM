# Local document extraction

StudentLLM sends imported sources to a local extraction sidecar. The original file is retained, while each extracted page or logical document section becomes a reviewable transcript segment with source and page provenance.

The sidecar currently supports digital and scanned PDFs, images, plain text, Markdown, HTML, RTF, DOCX, and PPTX. PDF text and layout come from [pdfminer.six](https://github.com/pdfminer/pdfminer.six) (MIT), scanned pages are rendered with [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) (PDFium; Apache-2.0 or BSD-3-Clause) and read by RapidOCR when installed, images use RapidOCR, and Office formats are read from their native XML packages. Headings, lists, tables, slide boundaries, and formula-like PDF regions are preserved as typed blocks instead of being flattened immediately into one text string. Formula reconstruction remains source-faithful: ambiguous glyphs stay as extracted text rather than being guessed. A page whose text layer is missing, or whose glyphs cannot be mapped to letters (Private Use Area code points or `(cid:N)` placeholders), is rasterised at 2x and read by OCR instead.

None of the sidecar's dependencies is GPL or AGPL (some wheels carry LGPL or MPL parts, listed in [Licensing](licensing.md)), which is what a commercial distribution needs. The sidecar used PyMuPDF (AGPL-3.0 or a commercial licence) until it was replaced for that reason; see [Differences from the PyMuPDF engine](#differences-from-the-pymupdf-engine).

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

On 2026-08-27, the browser path was exercised with the public [Attention Is All You Need PDF](https://arxiv.org/abs/1706.03762). The sidecar, then PyMuPDF-based, returned HTTP 200 with model `pymupdf` and 15 pages; the UI stored `attention-public.pdf`, indexed all 15 pages, rendered the `Page 1` review segment, and reported no page errors. The original PDF remains a local ignored test artifact.

## Contract

The browser adapter is implemented in `src/lib/document-engine.ts` and expects a response shaped like:

```json
{
  "model": "pdfminer",
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

For an image, the response model is `rapidocr`. For a digital PDF it is `pdfminer`; for a PDF where at least one page went through OCR it is `pdfminer+rapidocr`. Text and Office sources use `text`, `text-markdown`, `html-text`, `rtf-text`, `docx-xml`, or `pptx-xml`.

Typed blocks may include `heading`, `paragraph`, `list`, `code`, `formula`, or `table`. A table carries a `rows` matrix so the UI can render a real table and the RAG index can retain cell-level terms.

## Differences from the PyMuPDF engine

PyMuPDF was replaced because it is licensed AGPL-3.0 or commercial, which does not fit an MIT product that is distributed commercially (details in [Licensing](licensing.md)). The replacement was compared with the PyMuPDF output on synthetic fixtures (generated by `tests/pdf_fixtures.py`) and reviewed independently.

**What matches.** Page text matched on the digital fixtures, and OCR output for scanned pages and images was identical (same RapidOCR, same 2x raster scale). The `/health` capabilities and the `/extract` response shape are unchanged, and the health model is now `pdfminer` or `pdfminer+rapidocr`.

**What does not match.**

- **Block grouping differs.** pdfminer.six does not group lines into blocks the way MuPDF does. On other documents the review saw it merge a heading with the paragraph below it, merge numbered items, split table cells into separate blocks, drop bullet glyphs where PyMuPDF emitted U+FFFD, and break math into one-character blocks. The TypeScript side (`src/lib/document-text.ts` and the note builder) works line by line on the page text, so the effect on notes and retrieval is small, but block-level provenance for PDFs is less tidy than before.
- Block `y` and `height` differ slightly even where the grouping agrees: PyMuPDF reports line boxes using font ascent and descent, pdfminer.six reports glyph boxes, so blocks are a few points shorter and sit a few points lower. `x` and `width` matched on the fixtures.
- PDFs still produce `paragraph` and `formula` blocks only. Headings, lists and tables are typed for Markdown, HTML, DOCX and PPTX, as before.
- pdfminer.six reports glyphs without a Unicode map as `(cid:N)`, where PyMuPDF produced Private Use Area code points or shifted glyph ids. Both forms trigger the OCR fallback. When OCR is not installed the placeholder stays in the page text; the web app drops `(cid:N)` when it normalises extracted text. On one fixture (an embedded font without a `ToUnicode` map) pdfminer.six recovered the correct text where PyMuPDF returned shifted characters.
- pdfminer.six keeps text that a PDF positions outside the page box; MuPDF clipped it.
- Ligatures: the web app now expands the presentation-form ligatures (U+FB00 to U+FB06) that pdfminer.six reports, next to the control-character ligatures PyMuPDF produced.
- PyMuPDF could also read formats that the sidecar never exposed (XPS, EPUB). Nothing the sidecar advertised was dropped.
- Related fixes found by the end-to-end checks: PPTX extraction returned no text for real files because it searched DrawingML `txBody` instead of the PresentationML `txBody` that holds shape text, and paragraphs of one shape were fused (`Slide body textSecond bullet`); each `a:p` is now a line and `a:br` a line break.

## Speed, limits and cleanup

pdfminer.six is pure Python and slower than MuPDF, and its box-ordering step is quadratic in the number of text boxes, so a single page of scattered words could take a minute. The sidecar therefore bounds the work:

- **Per-page layout choice.** A normal page gets the full layout analysis (including column ordering). A page with more than 200 distinct text baselines or 20,000 characters skips the box ordering and keeps top-to-bottom order, which is about 100 times faster.
- **Per-page cap.** A page with more than 30,000 text characters is not parsed as text (the cost grows steeply above that: 7,000 scattered words took 1.8 s and 8,500 took 28 s in a test). It is read by OCR when RapidOCR is installed. Otherwise the request fails with HTTP 422: "Page N has more than 30,000 text characters, which is too many to read as text in a reasonable time. Install the OCR dependencies so such pages can be read as images."
- **Page limit.** More than 500 pages is refused with HTTP 422, as before.
- **Time budget.** Every PDF request runs in a separate worker process with a 240-second budget (`--pdf-time-budget`, below the web app's five-minute abort). When it runs out the worker is killed and the sidecar answers HTTP 504: "PDF extraction was stopped after 240 seconds. The document is too large or too complex for the local extractor; split it or export it again."
- **Cleanup.** The worker is also killed when the client disconnects, so an abandoned request stops using CPU, and when the budget expires. At most two PDFs are processed at once; a third waits up to 30 seconds, then gets HTTP 503. PDFium is not thread-safe, so rendering happens in the worker, one document at a time.

Measured on the development machine (Windows laptop, CPU only, generated PDFs; wall time including starting the worker process, which costs about 1 s):

| Input | PyMuPDF sidecar | pdfminer.six sidecar |
| --- | --- | --- |
| 2 small pages | 0.3 s | 1.1 s |
| 15 dense pages (62 lines each) | 0.05 s | 1.3 s |
| 100 dense pages | 0.3 s | 4.5 s |
| 500 dense pages (the page limit) | 1.8 s | 22 s |
| 1 page, 2,000 scattered words | 0.02 s | 1.2 to 2.7 s (44 s before the layout choice) |
| 1 page, 10,000 scattered words | 0.15 s | 8.5 s (over the cap, so read by OCR; about 60 s when parsed as text) |
| 100 pages of 2,000 scattered words | 4.2 s | 33 s |
| Anything that runs out the budget | not bounded | stopped at 240 s with HTTP 504 |

The worst case for a request is therefore the 240-second budget, after which the user gets a plain message and no process keeps running. Scanned documents are bounded by the same budget: OCR on CPU takes seconds per page, so a very long scan can be stopped before it finishes; raise `--pdf-time-budget` (and the client timeout) for such files.

Run the contract and UI tests with:

```powershell
npm run test:run -- src/lib/document-engine.test.ts src/App.test.tsx
```
