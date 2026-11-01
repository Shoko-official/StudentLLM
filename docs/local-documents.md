# Local document extraction

StudentLLM sends imported sources to a local extraction sidecar. The original file is retained, while each extracted page or logical document section becomes a reviewable transcript segment with source and page provenance.

The sidecar currently supports digital and scanned PDFs, images, plain text, Markdown, HTML, RTF, DOCX, and PPTX. PDF text and layout come from [pdfminer.six](https://github.com/pdfminer/pdfminer.six) (MIT), scanned pages are rendered with [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) (PDFium; Apache-2.0 or BSD-3-Clause) and read by RapidOCR when installed, images use RapidOCR, and Office formats are read from their native XML packages. Headings, lists, tables, slide boundaries, and formula-like PDF regions are preserved as typed blocks instead of being flattened immediately into one text string. Formula reconstruction remains source-faithful: ambiguous glyphs stay as extracted text rather than being guessed. A page whose text layer is missing, or whose glyphs cannot be mapped to letters (Private Use Area code points or `(cid:N)` placeholders), is rasterised at 2x and read by OCR instead. A readable caption no longer prevents extraction of a large scan elsewhere on the page: OCR can supplement the native text with content from substantial raster regions.

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

## Analyze a source with NVIDIA

Local extraction remains the default. In the development web app, open **Sources** and choose **Read with NVIDIA** on a PDF or image. The confirmation names the file and explains that its page images will be sent to NVIDIA. Cancelling the confirmation sends nothing. Choosing NIM for course chat does not opt a file into image analysis.

The action uses [Nemotron 3.5 Super VL](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b) through the existing fixed-host credential proxy. The credential stays on the server. Images are prepared locally and sent one page at a time, with thinking disabled. The result preserves Markdown, tables, LaTeX and described diagram relations, and each page is marked for review beside the original source. It stays in the same course and does not replace other sources' notes. A later local rewrite cannot replace an explicit vision transcription.

This path accepts images up to 20 MB and PDFs up to 100 MB / 100 pages. Page images have at most 1800 pixels on their longest side; very small symbols can lose detail, so compare them with the original. Page requests are sequential and spaced by at least two seconds within one analysis. Each request has a 60-second timeout and the whole action a five-minute budget. **Cancel analysis** stops further requests. A quota, unavailable model, pending response or incomplete transcription leaves the original and previous notes intact; no key rotation, model switching or hidden cloud retry is performed. The packaged desktop app does not offer this development proxy.

Synthetic live checks on 2026-11-01 verified a diagram's arrow order, a two-column transcription, and actual browser rendering/transcription of a two-page PDF. A public handwritten line still contained mistakes. This is evidence for the tested workflow, not complete document understanding or a general accuracy guarantee. See [NVIDIA's multimodal request example](https://github.com/NVIDIA-NeMo/Nemotron/blob/main/usage-cookbook/Nemotron-3.5-Super-VL/visual-investigation-agent/investigator/endpoint.py) for the image contract. Hosted use remains subject to the existing NIM trial terms described in [Provider configuration](providers.md).

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

## Local OCR configuration and scope

The document requirements now need `rapidocr>=3.10`. The sidecar explicitly selects **PP-OCRv6 small** detection and recognition, using ONNX Runtime on CPU with four intra-operation threads and one inter-operation thread. CUDA and DirectML are disabled for this path. These multilingual models cover French as part of their documented 50-language support ([upstream model documentation](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)). The wheel carries the small ONNX weights; the [model attribution notice](https://github.com/RapidAI/RapidOCR/blob/main/python/MODEL_LICENSES.md) records their separate Apache-2.0 provenance. An older RapidOCR installation without v6 support is not advertised as OCR-capable by `/health`.

One engine is reused per process. A lock serializes initialization and inference across image HTTP requests; each isolated PDF worker reuses its own engine across that document's pages. Models are loaded lazily in RapidOCR 3.10, so a constructor timing alone does not measure startup. The existing worker time, memory, page and decoded-stream limits still apply.

Mixed PDF pages retain their native text and block ordering. Additional OCR is limited to raster images covering at least 10% of the page and whose bounding boxes are less than 10% covered by native text boxes. Small decorations and images with an adequate native text overlay are skipped. One rasterized page serves all selected regions; only OCR blocks centered inside these regions and outside native text blocks are appended. Their coordinates are converted from rendered pixels to the same rotated MediaBox layout as the native blocks, using the actual PDFium render transform so asymmetric CropBox offsets and page rotations do not shift the filtering regions. This heuristic does not establish the correct reading order for complex layouts or detect every small diagram. If OCR is unavailable, the existing native text remains readable, while image content requires installing the OCR dependencies.

On 2026-11-01, a four-thread CPU diagnostic compared the installed v4 baseline, v5 Latin recognition with the same v4 detector, and v6 small. Seven synthetic French printed/rotated pages had mean normalized text edit similarities of **0.884 / 0.918 / 0.917**; six preselected genuine French handwritten lines from two [CC-BY-4.0 CREMMA-Wikipedia forms](https://github.com/HTR-United/cremma-wikipedia/tree/5cd61fb74a976e23fa23df5811fc05c4424199ce) scored **0.226 / 0.303 / 0.739**. V6 still made substantial handwritten errors. The handwriting crops use annotated line polygons, so they do not test full-page segmentation. These small diagnostics support the upgrade, not a universal accuracy ranking. All three engines interleaved the two-column fixture. Literal text scores do not measure mathematical structure, table cells or diagram relationships. The original file remains the reference for review; arbitrary scanned pages, handwriting and schemas are not guaranteed to become faithful Markdown.

## Differences from the PyMuPDF engine

PyMuPDF was replaced because it is licensed AGPL-3.0 or commercial, which does not fit an MIT product that is distributed commercially (details in [Licensing](licensing.md)). The replacement was compared with the PyMuPDF output on synthetic fixtures (generated by `tests/pdf_fixtures.py`) and reviewed independently.

**What matches.** Page text matched on the digital fixtures, and OCR output for scanned pages and images was identical (same RapidOCR, same 2x raster scale). The `/health` capabilities and the `/extract` response shape are unchanged, and the health model is now `pdfminer` or `pdfminer+rapidocr`.

**What does not match.**

- **Block grouping differs.** pdfminer.six does not group lines into blocks the way MuPDF does. On other documents the review saw it merge a heading with the paragraph below it, merge numbered items, split table cells into separate blocks, drop bullet glyphs where PyMuPDF emitted U+FFFD, and break math into one-character blocks. The TypeScript side (`src/lib/document-text.ts` and the note builder) works line by line on the page text, so the effect on notes and retrieval is small, but block-level provenance for PDFs is less tidy than before.
- Block `y` and `height` differ slightly even where the grouping agrees: PyMuPDF reports line boxes using font ascent and descent, pdfminer.six reports glyph boxes, so blocks are a few points shorter and sit a few points lower. `x` and `width` matched on the fixtures.
- PDFs still produce `paragraph` and `formula` blocks only. Headings, lists and tables are typed for Markdown, HTML, DOCX and PPTX, as before.
- **Glyphs without a Unicode map.** pdfminer.six reports them as `(cid:N)`, where PyMuPDF produced Private Use Area code points or shifted glyph ids. Both forms trigger the OCR fallback. **Without OCR installed the text is lost:** the web app drops `(cid:N)` when it normalises extracted text, so those glyphs vanish instead of showing as garbage (and PyMuPDF's repair of some ligatures through control characters has no equivalent for them). That is a known quality limit; install the OCR dependencies for such documents. On one fixture (an embedded font without a `ToUnicode` map) pdfminer.six recovered the correct text where PyMuPDF returned shifted characters.
- pdfminer.six keeps text that a PDF positions outside the page box; MuPDF clipped it.
- Ligatures: the web app now expands the presentation-form ligatures (U+FB00 to U+FB06) that pdfminer.six reports, next to the control-character ligatures PyMuPDF produced.
- PyMuPDF could also read formats that the sidecar never exposed (XPS, EPUB). Nothing the sidecar advertised was dropped.
- Related fixes found by the end-to-end checks: PPTX extraction returned no text for real files because it searched DrawingML `txBody` instead of the PresentationML `txBody` that holds shape text, and paragraphs of one shape were fused (`Slide body textSecond bullet`); each `a:p` is now a line and `a:br` a line break.

## Speed, limits and cleanup

pdfminer.six is pure Python and slower than MuPDF, and its box-ordering step is quadratic in the number of text boxes, so a single page of scattered words could take a minute. The sidecar therefore bounds the work:

- **Per-page layout choice.** A normal page gets the full layout analysis (including column ordering). A page with more than 200 distinct text baselines or 20,000 characters skips the box ordering and keeps top-to-bottom order, which is about 100 times faster.
- **Per-page cap.** A page with more than 30,000 text characters is not parsed as text (the cost grows steeply above that: 7,000 scattered words took 1.8 s and 8,500 took 28 s in a test). It is read by OCR when RapidOCR is installed. Otherwise the request fails with HTTP 422: "Page N has more than 30,000 text characters, which is too many to read as text in a reasonable time. Install the OCR dependencies so such pages can be read as images."
- **Page limit.** More than 500 pages is refused with HTTP 422, as before.
- **Stream size.** No single PDF stream may decode to more than 64 MB. A decompression bomb (a few kilobytes of Flate data that expands to gigabytes) is refused before it is decoded, with HTTP 422: "A stream in this PDF expands to more than 64 MB when decompressed, which the local extractor does not accept. The file may be damaged or malicious." The check wraps the Flate decoder and the output of every other filter, so it needs no extra dependency.
- **Worker memory.** Each worker is limited to 2048 MB (`--pdf-memory-limit-mb`, 0 disables it; the limit is reported in `/health` under `limits`). On Linux it is `RLIMIT_DATA`; on Windows a job object with a per-process memory limit set through `ctypes` (checked on Windows by a test that makes the worker allocate past the limit); on macOS the kernel may ignore the data-size limit, so there it is best effort. If the limit cannot be applied the worker still runs and writes the reason to the sidecar's error output. A worker that hits the limit answers HTTP 422: "This PDF needs more than the 2048 MB of memory that the local extractor allows for one document. Split it into smaller files or export it again with fewer or smaller images."; one that is killed by the operating system instead is reported as "PDF extraction stopped unexpectedly. This usually means the document needs more memory than the local extractor allows (2048 MB) or is damaged." Either way its slot is freed.
- **Time budget.** Every PDF request runs in a separate worker process with a 240-second budget (`--pdf-time-budget`, below the web app's five-minute abort). When it runs out the worker is killed and the sidecar answers HTTP 504: "PDF extraction was stopped after 240 seconds. The document is too large or too complex for the local extractor; split it or export it again."
- **Cleanup.** The sidecar kills the worker when the budget expires and when the client disconnects, so an abandoned request stops using CPU. The worker also looks after itself, because the desktop shell stops sidecars with a hard kill that runs no cleanup code: it exits within about a second when the sidecar that started it dies (it waits on the parent process handle), and it ends itself 10 seconds after the request budget even if nobody kills it. A test force-kills a parent sidecar and checks that its worker is gone (run on Windows and in CI on Linux). The orphan test runs on Windows and on the Linux CI runner; macOS uses the same mechanism but is not exercised by a test. At most two PDFs are processed at once; a third waits up to 30 seconds, then gets HTTP 503, and a slot is always returned, even when starting the worker fails. PDFium is not thread-safe, so rendering happens in the worker, one document at a time.

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

The worst case for a request is therefore the 240-second budget. When it runs out the request fails as a whole with HTTP 504 and **no partial text is returned**; the worker is killed and the original file stays saved in the app. Each PDF also pays about 0.8 to 1 s to start its worker process, which is included in the table above and is why a two-page file takes about a second. Scanned documents are bounded by the same budget: OCR on CPU takes seconds per page, so a very long scan can be stopped before it finishes; raise `--pdf-time-budget` (and the client timeout) for such files.

Run the contract and UI tests with:

```powershell
npm run test:run -- src/lib/document-engine.test.ts src/App.test.tsx
```
