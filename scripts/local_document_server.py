"""Serve local PDF and image text extraction through a small HTTP sidecar."""

from __future__ import annotations

import argparse
import contextlib
import json
import multiprocessing
import multiprocessing.connection
import os
import re
import select
import socket
import sys
import threading
import time
import zipfile
import zlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import urlparse
from xml.etree import ElementTree

try:
    from scripts.local_server_security import (
        MAX_DOCUMENT_UPLOAD_BYTES,
        allowed_origin,
        validate_content_length,
        validate_local_host,
        validate_zip_members,
    )
except ModuleNotFoundError:  # Running this file directly from the scripts directory.
    from local_server_security import (
        MAX_DOCUMENT_UPLOAD_BYTES,
        allowed_origin,
        validate_content_length,
        validate_local_host,
        validate_zip_members,
    )


class DocumentHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-Documents/1.3"
    pdf_time_budget = 240.0
    pdf_memory_limit_mb = 2048

    def _write_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        origin = allowed_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS, POST")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self) -> None:
        self._write_json(204, {})

    def do_GET(self) -> None:
        if urlparse(self.path).path != "/health":
            self._write_json(404, {"error": "Not found."})
            return
        ocr_available = has_ocr_dependencies()
        self._write_json(200, {
            "status": "ok",
            "model": "pdfminer+rapidocr" if ocr_available else "pdfminer",
            "capabilities": [
                "pdf-text",
                "image-ocr",
                "scanned-pdf-ocr",
                "markdown-text",
                "html-text",
                "rtf-text",
                "docx-xml",
                "pptx-xml",
            ] if ocr_available else [
                "pdf-text",
                "markdown-text",
                "html-text",
                "rtf-text",
                "docx-xml",
                "pptx-xml",
            ],
            "ocrAvailable": ocr_available,
            "limits": {
                "pdfPages": MAX_PDF_PAGES,
                "pdfTimeBudgetSeconds": self.pdf_time_budget,
                "pdfWorkerMemoryMb": self.pdf_memory_limit_mb,
                "pdfStreamMegabytes": PDF_MAX_STREAM_BYTES // (1024 * 1024),
            },
        })

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/extract":
            self._write_json(404, {"error": "Not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        try:
            validate_content_length(length, MAX_DOCUMENT_UPLOAD_BYTES)
        except ValueError as error:
            self._write_json(413 if length > MAX_DOCUMENT_UPLOAD_BYTES else 400, {"error": str(error)})
            return

        try:
            payload = self.rfile.read(length)
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type == "application/pdf":
                model, pages = run_pdf_extraction(
                    payload,
                    budget_seconds=self.pdf_time_budget,
                    memory_limit_mb=self.pdf_memory_limit_mb,
                    should_abort=lambda: client_disconnected(self.connection),
                )
            elif content_type.startswith("image/"):
                model, pages = extract_image(payload)
            elif content_type in {
                "text/plain",
                "text/markdown",
                "text/html",
                "application/rtf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            }:
                model, pages = extract_document(payload, content_type)
            else:
                self._write_json(415, {"error": "This document type is not supported by the local extractor."})
                return
            self._write_json(200, {"model": model, "pages": pages})
        except ExtractionAborted:
            return  # The client went away; there is nobody to answer.
        except ExtractionTimeout as error:
            self._write_json(504, {"error": str(error)})
        except ExtractionBusy as error:
            self._write_json(503, {"error": str(error)})
        except ExtractionCrashed as error:
            self._write_json(422, {"error": str(error)})
        except DocumentLimitError as error:
            self._write_json(422, {"error": str(error)})
        except Exception:
            self._write_json(422, {"error": "Document extraction failed."})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--pdf-time-budget", type=float, default=PDF_TIME_BUDGET_SECONDS,
        help="Seconds one PDF request may run before it is stopped (default: %(default)s).",
    )
    parser.add_argument(
        "--pdf-memory-limit-mb", type=int, default=PDF_WORKER_MEMORY_LIMIT_MB,
        help="Memory one PDF worker process may use, in MB; 0 disables the limit (default: %(default)s).",
    )
    return parser.parse_args()


def has_ocr_dependencies() -> bool:
    try:
        from rapidocr import RapidOCR  # noqa: F401
        from rapidocr.utils.typings import ModelType, OCRVersion
        return hasattr(OCRVersion, "PPOCRV6") and hasattr(ModelType, "SMALL")
    except Exception:
        return False


_OCR_ENGINE = None
_OCR_LOCK = threading.Lock()


def _create_ocr_engine():
    from rapidocr import RapidOCR
    from rapidocr.utils.typings import ModelType, OCRVersion

    try:
        version, model_type = OCRVersion.PPOCRV6, ModelType.SMALL
    except AttributeError as error:
        raise RuntimeError("Install rapidocr>=3.10 to use the multilingual PP-OCRv6 small models.") from error
    return RapidOCR(params={
        "Det.ocr_version": version,
        "Rec.ocr_version": version,
        "Det.model_type": model_type,
        "Rec.model_type": model_type,
        "EngineConfig.onnxruntime.intra_op_num_threads": 4,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": False,
        "EngineConfig.onnxruntime.use_dml": False,
        "Global.log_level": "warning",
    })


def ocr_image(image: bytes) -> tuple[str, list[dict[str, object]]]:
    global _OCR_ENGINE
    # Requests share one mutable engine. Spawned PDF workers each keep their own engine for that document.
    with _OCR_LOCK:
        if _OCR_ENGINE is None:
            _OCR_ENGINE = _create_ocr_engine()
        result = _OCR_ENGINE(image)
    boxes = getattr(result, "boxes", None)
    texts = getattr(result, "txts", None)
    if boxes is None:
        boxes = ()
    if texts is None:
        texts = ()
    blocks = []
    for box, text in zip(boxes, texts):
        value = str(text).strip()
        if not value:
            continue
        points = [(float(point[0]), float(point[1])) for point in box]
        left = min(point[0] for point in points)
        top = min(point[1] for point in points)
        right = max(point[0] for point in points)
        bottom = max(point[1] for point in points)
        blocks.append({"x": left, "y": top, "width": right - left, "height": bottom - top, "text": value, "kind": "text"})
    return "rapidocr", blocks


def extract_image(image: bytes) -> tuple[str, list[dict[str, object]]]:
    model, blocks = ocr_image(image)
    return model, [{"pageNumber": 1, "text": "\n".join(block["text"] for block in blocks), "blocks": blocks}]


def _text_from_xml(element: ElementTree.Element) -> str:
    return "".join(value for value in element.itertext() if value).strip()


def _document_page(blocks: list[dict[str, object]], page_number: int = 1) -> dict[str, object]:
    text = "\n".join(str(block["text"]) for block in blocks if str(block.get("text", "")).strip())
    return {"pageNumber": page_number, "text": text, "blocks": blocks}


class _HtmlTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict[str, object]] = []
        self._parts: list[str] = []
        self._tag_stack: list[str] = []
        self._table_rows: list[list[str]] | None = None
        self._current_row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._flush()
            self._table_rows = []
            self._current_row = None
            return
        if tag == "tr" and self._table_rows is not None:
            self._finish_row()
            self._current_row = []
            return
        if tag in {"th", "td"} and self._table_rows is not None:
            self._cell_parts = []
            return
        if tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "pre", "table", "tr"}:
            self._flush()
            self._tag_stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"th", "td"} and self._table_rows is not None:
            value = " ".join(self._cell_parts or []).strip()
            if self._current_row is None:
                self._current_row = []
            self._current_row.append(value)
            self._cell_parts = None
            return
        if tag == "tr" and self._table_rows is not None:
            self._finish_row()
            return
        if tag == "table" and self._table_rows is not None:
            self._finish_row()
            rows = [row for row in self._table_rows if any(row)]
            if rows:
                width = len(rows[0])
                if width and all(len(row) == width for row in rows):
                    self.blocks.append({
                        "x": 0, "y": len(self.blocks) * 20, "width": 0, "height": 0,
                        "text": "\n".join(" | ".join(row) for row in rows), "kind": "table", "rows": rows,
                    })
            self._table_rows = None
            self._current_row = None
            return
        if tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "pre", "table", "tr"}:
            self._flush()
            if self._tag_stack and self._tag_stack[-1] == tag:
                self._tag_stack.pop()

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if value:
            if self._cell_parts is not None:
                self._cell_parts.append(value)
            else:
                self._parts.append(value)

    def _finish_row(self) -> None:
        if self._table_rows is not None and self._current_row:
            self._table_rows.append(self._current_row)
        self._current_row = None

    def _flush(self) -> None:
        value = " ".join(self._parts).strip()
        self._parts = []
        if not value:
            return
        current_tag = self._tag_stack[-1] if self._tag_stack else "p"
        kind = "heading" if current_tag.startswith("h") else "code" if current_tag == "pre" else "list" if current_tag == "li" else "paragraph"
        self.blocks.append({"x": 0, "y": len(self.blocks) * 20, "width": 0, "height": 0, "text": value, "kind": kind})


def extract_plain_document(payload: bytes, content_type: str) -> tuple[str, list[dict[str, object]]]:
    text = payload.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    if content_type == "text/html":
        parser = _HtmlTextParser()
        parser.feed(text)
        blocks = parser.blocks
        return "html-text", [_document_page(blocks)]

    if content_type == "application/rtf":
        text = re.sub(r"\\'[0-9a-fA-F]{2}", lambda match: bytes.fromhex(match.group(0)[2:]).decode("cp1252", errors="replace"), text)
        text = text.replace(r"\par", "\n").replace(r"\line", "\n")
        text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", text)
        text = text.replace("{", "").replace("}", "")
    lines = [line.strip() for line in text.split("\n")]
    blocks: list[dict[str, object]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line:
            index += 1
            continue
        if content_type == "text/markdown" and line.startswith("#"):
            blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": line.lstrip("# ").strip(), "kind": "heading"})
            index += 1
            continue
        if content_type == "text/markdown" and re.match(r"^[-*+]\s+", line):
            items = []
            while index < len(lines) and re.match(r"^[-*+]\s+", lines[index]):
                items.append(re.sub(r"^[-*+]\s+", "", lines[index]).strip())
                index += 1
            blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": "\n".join(items), "kind": "list"})
            continue
        paragraph = [line]
        index += 1
        while index < len(lines) and lines[index]:
            paragraph.append(lines[index].strip())
            index += 1
        blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": " ".join(paragraph), "kind": "paragraph"})
    model = "text-markdown" if content_type == "text/markdown" else "rtf-text" if content_type == "application/rtf" else "text"
    return model, [_document_page(blocks)]


def extract_docx(payload: bytes) -> tuple[str, list[dict[str, object]]]:
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        validate_zip_members(archive.infolist())
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    blocks: list[dict[str, object]] = []
    for child in root.iter(f"{namespace}body"):
        for item in list(child):
            if item.tag == f"{namespace}p":
                text = _text_from_xml(item)
                if not text:
                    continue
                style = item.find(f"{namespace}pPr/{namespace}pStyle")
                style_name = style.get(f"{namespace}val", "") if style is not None else ""
                kind = "heading" if style_name.lower().startswith("heading") else "paragraph"
                blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": text, "kind": kind})
            elif item.tag == f"{namespace}tbl":
                rows: list[list[str]] = []
                for row in item.findall(f"{namespace}tr"):
                    cells = [_text_from_xml(cell) for cell in row.findall(f"{namespace}tc")]
                    if any(cells):
                        rows.append(cells)
                if rows:
                    blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": "\n".join(" | ".join(row) for row in rows), "kind": "table", "rows": rows})
    return "docx-xml", [_document_page(blocks)]


def _pptx_shape_text(shape: ElementTree.Element, namespace: str) -> str:
    """Text of a shape with one line per `a:p` paragraph and `a:br` as a line break."""
    paragraphs = []
    for paragraph in shape.findall(f"{namespace}p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{namespace}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{namespace}br":
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_pptx(payload: bytes) -> tuple[str, list[dict[str, object]]]:
    namespace = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    presentation = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        validate_zip_members(archive.infolist())
        slide_names = sorted(
            (name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)),
            key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)),
        )
        pages = []
        for page_number, name in enumerate(slide_names, start=1):
            root = ElementTree.fromstring(archive.read(name))
            blocks = []
            # Shape text lives in `p:txBody` (PresentationML); table cells use `a:txBody` (DrawingML).
            for shape in (element for element in root.iter() if element.tag in {f"{presentation}txBody", f"{namespace}txBody"}):
                text = _pptx_shape_text(shape, namespace)
                if text:
                    blocks.append({"x": 0, "y": len(blocks) * 20, "width": 0, "height": 0, "text": text, "kind": "paragraph"})
            pages.append(_document_page(blocks, page_number))
    return "pptx-xml", pages


def extract_document(payload: bytes, content_type: str) -> tuple[str, list[dict[str, object]]]:
    if content_type in {"text/plain", "text/markdown", "text/html", "application/rtf"}:
        return extract_plain_document(payload, content_type)
    if content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return extract_docx(payload)
    if content_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        return extract_pptx(payload)
    raise ValueError(f"Unsupported document content type: {content_type}")


def block_text(block: dict[str, object]) -> str:
    lines = block.get("lines")
    if not isinstance(lines, list):
        return ""
    values = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        spans = line.get("spans")
        if not isinstance(spans, list):
            continue
        values.append("".join(str(span.get("text", "")) for span in spans if isinstance(span, dict)).strip())
    return "\n".join(value for value in values if value).strip()


def math_character_counts(block: dict[str, object]) -> tuple[int, int]:
    lines = block.get("lines")
    if not isinstance(lines, list):
        return (0, 0)
    text_characters = 0
    math_characters = 0
    for line in lines:
        if not isinstance(line, dict):
            continue
        spans = line.get("spans")
        if not isinstance(spans, list):
            continue
        for span in spans:
            if not isinstance(span, dict):
                continue
            value = str(span.get("text", ""))
            characters = sum(not character.isspace() for character in value)
            text_characters += characters
            if str(span.get("font", "")).startswith(("CMMI", "CMSY", "CMEX", "MSAM", "MSBM")):
                math_characters += characters
    return math_characters, text_characters


def is_formula_block(block: dict[str, object]) -> bool:
    math_characters, text_characters = math_character_counts(block)
    return math_characters >= 8 and math_characters / max(text_characters, 1) >= 0.35


def is_formula_group(blocks: list[dict[str, object]]) -> bool:
    counts = [math_character_counts(block) for block in blocks]
    math_characters = sum(count[0] for count in counts)
    text_characters = sum(count[1] for count in counts)
    math_density = math_characters / max(text_characters, 1)
    return (
        (math_characters >= 8 and math_density >= 0.35)
        or (len(blocks) >= 3 and math_characters >= 20 and math_density >= 0.25)
    )


def blocks_touch(left: dict[str, object], right: dict[str, object]) -> bool:
    left_box = left["bbox"]
    right_box = right["bbox"]
    if not isinstance(left_box, tuple) or not isinstance(right_box, tuple):
        return False
    horizontal_gap = max(left_box[0], right_box[0]) - min(left_box[2], right_box[2])
    vertical_gap = max(left_box[1], right_box[1]) - min(left_box[3], right_box[3])
    return horizontal_gap <= 16 and vertical_gap <= 6


def group_formula_blocks(blocks: list[dict[str, object]]) -> list[list[int]]:
    math_indexes = [index for index, block in enumerate(blocks) if block.get("math")]
    groups: list[list[int]] = []
    pending = set(math_indexes)
    while pending:
        group = [pending.pop()]
        changed = True
        while changed:
            changed = False
            for index in list(pending):
                if any(blocks_touch(blocks[index], blocks[current]) for current in group):
                    pending.remove(index)
                    group.append(index)
                    changed = True
        groups.append(sorted(group))
    return sorted(groups, key=lambda group: group[0])


def formula_crop_bounds(
    blocks: list[dict[str, object]], group: list[int], page_width: float, page_height: float
) -> tuple[float, float, float, float]:
    members = [blocks[index] for index in group]
    return (
        max(0, min(member["bbox"][0] for member in members) - 4),
        max(0, min(member["bbox"][1] for member in members) - 4),
        min(page_width, max(member["bbox"][2] for member in members) + 4),
        min(page_height, max(member["bbox"][3] for member in members) + 4),
    )


def is_block_covered_by_formula_crop(block: dict[str, object], crop: tuple[float, float, float, float]) -> bool:
    bbox = block["bbox"]
    return bbox[0] >= crop[0] and bbox[1] >= crop[1] and bbox[2] <= crop[2] and bbox[3] <= crop[3]


def formula_aware_pdf_blocks(
    layout_blocks: list[dict[str, object]], page_width: float, page_height: float
) -> list[dict[str, object]]:
    """Turn a page's text blocks (see `pdf_layout_blocks`) into provenance blocks, keeping math regions together."""
    raw_blocks = [block for block in layout_blocks if block.get("type") == 0 and block_text(block)]
    blocks = [{"bbox": tuple(block["bbox"]), "text": block_text(block), "math": math_character_counts(block)[0] > 0, "raw": block} for block in raw_blocks]
    formula_groups = [group for group in group_formula_blocks(blocks) if is_formula_group([blocks[index]["raw"] for index in group])]
    grouped_indexes = {index for group in formula_groups for index in group}
    formula_crops = [formula_crop_bounds(blocks, group, page_width, page_height) for group in formula_groups]
    covered_indexes = {
        index
        for index, block in enumerate(blocks)
        if index not in grouped_indexes and any(is_block_covered_by_formula_crop(block, crop) for crop in formula_crops)
    }
    rendered: list[dict[str, object]] = [
        {"x": block["bbox"][0], "y": block["bbox"][1], "width": block["bbox"][2] - block["bbox"][0], "height": block["bbox"][3] - block["bbox"][1], "text": block["text"], "kind": "formula" if block["math"] else "paragraph"}
        for index, block in enumerate(blocks)
        if index not in grouped_indexes and index not in covered_indexes
    ]
    for group, (x0, y0, x1, y1) in zip(formula_groups, formula_crops):
        covered_group = [
            index for index, block in enumerate(blocks)
            if index in group or is_block_covered_by_formula_crop(block, (x0, y0, x1, y1))
        ]
        rendered.append({
            "x": x0,
            "y": y0,
            "width": x1 - x0,
            "height": y1 - y0,
            "text": "\n".join(blocks[index]["text"] for index in sorted(covered_group)),
            "kind": "formula",
        })
    return sorted(rendered, key=lambda block: (block["y"], block["x"]))


_UNMAPPED_CID = re.compile(r"\(cid:\d+\)")
_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")


def has_unmapped_glyphs(text: str, threshold: float = 0.1) -> bool:
    """True when a text layer is mostly unusable: fonts embedded without a Unicode map
    come out as Private Use Area code points, or as `(cid:N)` placeholders in pdfminer,
    instead of letters."""
    placeholders = len(_UNMAPPED_CID.findall(text))
    text = _UNMAPPED_CID.sub("", text)
    unmapped = placeholders + sum(1 for character in text if 0xE000 <= ord(character) <= 0xF8FF)
    letters = sum(1 for character in text if character.isalpha())
    return unmapped > 0 and unmapped / (letters + unmapped) >= threshold


MAX_PDF_PAGES = 500
PDF_OCR_SCALE = 2
# Read substantial image regions that a native text layer barely covers, without OCRing small decorations.
PDF_OCR_IMAGE_MIN_PAGE_FRACTION = 0.1
PDF_OCR_IMAGE_MAX_NATIVE_COVERAGE = 0.1

# Time and size limits for one PDF request. pdfminer.six is pure Python and its box-ordering step is quadratic in
# the number of text boxes, so pathological pages (thousands of scattered words) can take a minute or more.
PDF_TIME_BUDGET_SECONDS = 240.0  # Below the five-minute client timeout so the client gets an answer, not an abort.
PDF_FULL_LAYOUT_MAX_BASELINES = 200  # Distinct text baselines on a page above which box ordering is skipped.
PDF_FULL_LAYOUT_MAX_CHARACTERS = 20_000
PDF_MAX_PAGE_CHARACTERS = 30_000  # Above this a page is not parsed as text (time grows steeply): it is read by OCR, or rejected.
PDF_MAX_CONCURRENT_JOBS = 2
PDF_QUEUE_WAIT_SECONDS = 30.0
PDF_MAX_STREAM_BYTES = 64 * 1024 * 1024  # Largest size one PDF stream may decode to; a decompression bomb is refused.
PDF_WORKER_MEMORY_LIMIT_MB = 2048  # Memory one worker may use (0 disables the limit).
PDF_WORKER_DEADLINE_GRACE_SECONDS = 10.0  # A worker ends itself this long after the request budget.
WORKER_EXIT_DEADLINE = 70
WORKER_EXIT_ORPHANED = 71

# PDFium is not thread-safe and the sidecar serves requests on several threads.
_PDFIUM_LOCK = threading.Lock()
_PDF_JOBS = threading.BoundedSemaphore(PDF_MAX_CONCURRENT_JOBS)


class DocumentLimitError(ValueError):
    """The document exceeds a size or complexity limit; the message is safe to show to the user."""


class ExtractionTimeout(Exception):
    """The request used up its time budget and its worker was stopped."""


class ExtractionAborted(Exception):
    """The client disconnected and the worker was stopped."""


class ExtractionBusy(Exception):
    """Too many PDF requests are already running."""


class ExtractionCrashed(Exception):
    """The worker died without an answer, most often because it ran out of memory."""

    def __init__(self, memory_limit_mb: int) -> None:
        super().__init__(
            "PDF extraction stopped unexpectedly. This usually means the document needs more memory than the local "
            f"extractor allows ({memory_limit_mb} MB) or is damaged. Split it into smaller files or export it again."
        )


def _span_font(name: str) -> str:
    return _SUBSET_PREFIX.sub("", name)


def _layout_text_lines(element: object) -> list[object]:
    """Every text line below a pdfminer layout element, in reading order."""
    from pdfminer.layout import LTContainer, LTTextLine

    if isinstance(element, LTTextLine):
        return [element]
    if isinstance(element, LTContainer):
        lines: list[object] = []
        for child in element:
            lines.extend(_layout_text_lines(child))
        return lines
    return []


def _line_spans(line: object) -> list[dict[str, object]]:
    """Group a text line's characters into spans that share a font."""
    from pdfminer.layout import LTChar

    spans: list[dict[str, object]] = []
    for item in line:
        if isinstance(item, LTChar):
            font = _span_font(item.fontname)
            if not spans or spans[-1]["font"] != font:
                spans.append({"text": "", "font": font})
            spans[-1]["text"] += item.get_text()
        elif spans:  # An LTAnno: the virtual space or line break the layout analysis inserted.
            spans[-1]["text"] += item.get_text()
    return spans


def pdf_layout_blocks(layout_page: object) -> tuple[list[dict[str, object]], float, float]:
    """Text blocks of one pdfminer page in the shape the formula logic expects.

    Each block has a top-left origin `bbox` in PDF points and `lines` of `spans` carrying the
    text and the font name (subset prefix removed), so math fonts such as CMMI10 stay visible.
    """
    from pdfminer.layout import LTContainer, LTTextBox

    left, bottom, right, top = layout_page.bbox
    blocks: list[dict[str, object]] = []

    def visit(container: object) -> None:
        for child in container:
            if isinstance(child, LTTextBox):
                lines = [{"spans": spans} for spans in (_line_spans(line) for line in _layout_text_lines(child)) if spans]
                if lines:
                    x0, y0, x1, y1 = child.bbox
                    blocks.append({"type": 0, "bbox": (x0 - left, top - y1, x1 - left, top - y0), "lines": lines})
            elif isinstance(child, LTContainer):
                visit(child)

    visit(layout_page)
    return blocks, right - left, top - bottom


def render_pdf_page_png(document: object, page_index: int) -> bytes:
    """Rasterise one page at `PDF_OCR_SCALE` for OCR."""
    return rasterize_pdf_page(document, page_index)[0]


def rasterize_pdf_page(document: object, page_index: int) -> tuple[bytes, tuple[float, ...]]:
    """Return the raster and its pixel-to-PDF transform, including CropBox and page rotation."""
    page = document[page_index]
    try:
        bitmap = page.render(scale=PDF_OCR_SCALE)
        try:
            converter = bitmap.get_posconv(page)
            origin, x_step, y_step = [converter.to_page(x, y) for x, y in ((0, 0), (1, 0), (0, 1))]
            transform = (x_step[0] - origin[0], x_step[1] - origin[1],
                         y_step[0] - origin[0], y_step[1] - origin[1], *origin)
            buffer = BytesIO()
            bitmap.to_pil().convert("RGB").save(buffer, format="PNG")
            return buffer.getvalue(), transform
        finally:
            bitmap.close()
    finally:
        page.close()


def pdf_uncovered_image_regions(layout_page: object, native_blocks: list[dict[str, object]]) -> list[tuple[float, float, float, float]]:
    """Large raster boxes with little native text coverage; coordinates are top-left PDF points."""
    from pdfminer.layout import LTContainer, LTImage

    left, bottom, right, top = layout_page.bbox
    page_area = (right - left) * (top - bottom)
    regions = []

    def visit(element: object) -> None:
        if isinstance(element, LTImage):
            x0, y0, x1, y1 = element.bbox
            box = (max(0, x0 - left), max(0, top - y1), min(right - left, x1 - left), min(top - bottom, top - y0))
            area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
            if area <= 0 or area < page_area * PDF_OCR_IMAGE_MIN_PAGE_FRACTION:
                return
            covered = 0.0
            for block in native_blocks:
                bx0, by0, bx1, by1 = block["bbox"]
                covered += max(0, min(box[2], bx1) - max(box[0], bx0)) * max(0, min(box[3], by1) - max(box[1], by0))
            if covered / area < PDF_OCR_IMAGE_MAX_NATIVE_COVERAGE:
                regions.append(box)
        elif isinstance(element, LTContainer):
            for child in element:
                visit(child)

    visit(layout_page)
    return regions


def image_region_ocr_blocks(blocks: list[dict[str, object]], regions: list[tuple[float, float, float, float]],
                            native: list[dict[str, object]], raster_to_layout: tuple[float, ...]) -> list[dict[str, object]]:
    """Keep OCR additions inside the raster regions, retaining native text instead of its OCR approximation."""
    from pdfminer.utils import apply_matrix_pt

    additions = []
    for block in blocks:
        bx, by, bw, bh = [float(block[key]) for key in ("x", "y", "width", "height")]
        points = [apply_matrix_pt(raster_to_layout, (x, y)) for x in (bx, bx + bw) for y in (by, by + bh)]
        xs, ys = zip(*points)
        normalized = {**block, "x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}
        x, y = normalized["x"] + normalized["width"] / 2, normalized["y"] + normalized["height"] / 2
        if not any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in regions):
            continue
        if any(float(item["x"]) <= x <= float(item["x"]) + float(item["width"])
               and float(item["y"]) <= y <= float(item["y"]) + float(item["height"]) for item in native):
            continue
        additions.append(normalized)
    return additions


def _iter_characters(element: object):
    from pdfminer.layout import LTChar, LTContainer

    if isinstance(element, LTChar):
        yield element
    elif isinstance(element, LTContainer):
        for child in element:
            yield from _iter_characters(child)


def analyze_pdf_page(layout_page: object) -> bool:
    """Run pdfminer's layout analysis on a raw page and return False when the page is too dense to parse.

    A normal page gets the full analysis, which also orders the text boxes (columns). A page with many scattered
    text lines skips the quadratic box ordering and keeps top-to-bottom order, which is 100 times faster.
    """
    from pdfminer.layout import LAParams

    characters = list(_iter_characters(layout_page))
    if len(characters) > PDF_MAX_PAGE_CHARACTERS:
        return False
    baselines = len({round(character.y0) for character in characters})
    simple = len(characters) > PDF_FULL_LAYOUT_MAX_CHARACTERS or baselines > PDF_FULL_LAYOUT_MAX_BASELINES
    layout_page.analyze(LAParams(all_texts=True, boxes_flow=None) if simple else LAParams(all_texts=True))
    return True


def _extract_pdf(pdf_bytes: bytes) -> tuple[str, list[dict[str, object]]]:
    from pdfminer.converter import PDFPageAggregator
    from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
    from pdfminer.pdfpage import PDFPage
    from pdfminer.utils import mult_matrix

    page_count = 0
    for _ in PDFPage.get_pages(BytesIO(pdf_bytes)):
        page_count += 1
        if page_count > MAX_PDF_PAGES:
            raise DocumentLimitError(f"The PDF has more than {MAX_PDF_PAGES} pages.")

    pages: list[dict[str, object]] = []
    too_dense: list[int] = []
    image_regions: dict[int, list[tuple[float, float, float, float]]] = {}
    page_transforms: dict[int, tuple[float, ...]] = {}
    resources = PDFResourceManager()
    device = PDFPageAggregator(resources, laparams=None)  # Raw characters first; the analysis is chosen per page.
    interpreter = PDFPageInterpreter(resources, device)
    for page_number, page in enumerate(PDFPage.get_pages(BytesIO(pdf_bytes)), start=1):
        interpreter.process_page(page)
        layout_page = device.get_result()
        if not analyze_pdf_page(layout_page):
            too_dense.append(page_number)
            pages.append({"pageNumber": page_number, "text": "", "blocks": []})
            continue
        layout_blocks, width, height = pdf_layout_blocks(layout_page)
        image_regions[page_number] = pdf_uncovered_image_regions(layout_page, layout_blocks)
        # Match pdfminer's rotated MediaBox layout, rather than assuming PDFium's cropped raster origin.
        a, b, c, d, e, f = interpreter.ctm
        left, _, _, top = layout_page.bbox
        page_transforms[page_number] = (a, -b, c, -d, e - left, top - f)
        text = "\n".join(block_text(block) for block in layout_blocks).strip()
        pages.append({
            "pageNumber": page_number,
            "text": text,
            "blocks": formula_aware_pdf_blocks(layout_blocks, width, height),
        })

    ocr_ready = has_ocr_dependencies()
    if too_dense and not ocr_ready:
        raise DocumentLimitError(
            f"Page {too_dense[0]} has more than {PDF_MAX_PAGE_CHARACTERS:,} text characters, which is too many to read "
            "as text in a reasonable time. Install the OCR dependencies so such pages can be read as images."
        )
    # OCR missing/unmapped text, and supplement uncovered raster regions on otherwise readable mixed pages.
    ocr_pages = [
        page for page in pages
        if page["pageNumber"] in too_dense or not page["text"]
        or (ocr_ready and (has_unmapped_glyphs(str(page["text"])) or image_regions.get(page["pageNumber"])))
    ]
    if ocr_pages:
        import pypdfium2

        with _PDFIUM_LOCK:
            document = pypdfium2.PdfDocument(pdf_bytes)
            try:
                for page in ocr_pages:
                    image, raster_to_pdf = rasterize_pdf_page(document, int(page["pageNumber"]) - 1)
                    _, blocks = ocr_image(image)
                    if page["text"] and not has_unmapped_glyphs(str(page["text"])):
                        # Native reading order is kept; recovered image text follows it, without invented structure.
                        raster_to_layout = mult_matrix(raster_to_pdf, page_transforms[page["pageNumber"]])
                        additions = image_region_ocr_blocks(blocks, image_regions[page["pageNumber"]],
                                                            page["blocks"], raster_to_layout)
                        blocks = [*page["blocks"], *additions]
                    page["blocks"] = blocks
                    page["text"] = "\n".join(str(block["text"]) for block in blocks)
            finally:
                document.close()
    return ("pdfminer+rapidocr" if ocr_pages else "pdfminer"), pages


class _BoundedZlib:
    """Stands in for `zlib` inside pdfminer.pdftypes so one Flate stream cannot expand past a limit."""

    error = zlib.error

    def __init__(self, limit: int) -> None:
        self._limit = limit

    def decompressobj(self, *arguments: object, **keywords: object) -> object:
        return zlib.decompressobj(*arguments, **keywords)

    def decompress(self, data: bytes, *_arguments: object) -> bytes:
        decompressor = zlib.decompressobj()
        output = decompressor.decompress(data, self._limit + 1)
        if len(output) > self._limit:
            raise _stream_too_large(self._limit)
        output += decompressor.flush()
        if not decompressor.eof:
            raise zlib.error("incomplete or truncated stream")  # Same as zlib.decompress, so pdfminer falls back as before.
        return output


def _stream_too_large(limit: int) -> DocumentLimitError:
    return DocumentLimitError(
        f"A stream in this PDF expands to more than {limit // (1024 * 1024)} MB when decompressed, which the local "
        "extractor does not accept. The file may be damaged or malicious."
    )


@contextlib.contextmanager
def bounded_stream_decoding(limit: int | None = None):
    """Make pdfminer.six refuse any PDF stream that decodes to more than `limit` bytes (default PDF_MAX_STREAM_BYTES)."""
    from pdfminer import pdftypes

    limit = PDF_MAX_STREAM_BYTES if limit is None else limit
    original_zlib, original_decode = pdftypes.zlib, pdftypes.PDFStream.decode

    def decode(stream: object) -> None:
        original_decode(stream)  # type: ignore[arg-type]
        data = getattr(stream, "data", None)
        if data is not None and len(data) > limit:  # LZW, ASCII85, run-length and predictor output
            raise _stream_too_large(limit)

    pdftypes.zlib = _BoundedZlib(limit)
    pdftypes.PDFStream.decode = decode
    try:
        yield
    finally:
        pdftypes.zlib = original_zlib
        pdftypes.PDFStream.decode = original_decode


def extract_pdf(pdf_bytes: bytes, max_stream_bytes: int | None = None) -> tuple[str, list[dict[str, object]]]:
    with bounded_stream_decoding(max_stream_bytes):
        return _extract_pdf(pdf_bytes)


def memory_limit_message(megabytes: int) -> str:
    return (
        f"This PDF needs more than the {megabytes} MB of memory that the local extractor allows for one document. "
        "Split it into smaller files or export it again with fewer or smaller images."
    )


def apply_worker_memory_limit(megabytes: int) -> str:
    """Cap this process's memory; returns "enforced" or a plain reason why it could not be applied.

    POSIX: RLIMIT_DATA (RLIMIT_AS where that is missing). Linux enforces it; macOS may ignore it, so there it is best
    effort. Windows: a job object with a per-process memory limit, set through ctypes.
    """
    if megabytes <= 0:
        return "disabled"
    limit = megabytes * 1024 * 1024
    try:
        if os.name == "nt":
            return _limit_windows_process_memory(limit)
        import resource

        kind = getattr(resource, "RLIMIT_DATA", None) or resource.RLIMIT_AS
        _soft, hard = resource.getrlimit(kind)
        resource.setrlimit(kind, (limit if hard == resource.RLIM_INFINITY else min(limit, hard), hard))
        return "enforced" if sys.platform.startswith("linux") else "best effort (this platform may ignore it)"
    except Exception as error:  # noqa: BLE001 - a missing limit must not stop extraction
        return f"not applied ({type(error).__name__}: {error})"


def _limit_windows_process_memory(limit: int) -> str:
    import ctypes
    from ctypes import wintypes

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
        ]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return f"not applied (CreateJobObject failed: {ctypes.get_last_error()})"
    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = 0x00000100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
    info.ProcessMemoryLimit = limit
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # JobObjectExtendedLimitInformation
        return f"not applied (SetInformationJobObject failed: {ctypes.get_last_error()})"
    if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
        return f"not applied (AssignProcessToJobObject failed: {ctypes.get_last_error()})"
    return "enforced"


def start_worker_guard(deadline_seconds: float) -> None:
    """In a worker process: exit when the parent dies and when the worker's own deadline passes.

    The parent normally kills the worker. This covers a parent that was itself killed (the desktop shell stops
    sidecars with a hard kill) and a parent that is stuck, so no worker is left running without a limit.
    """
    parent = multiprocessing.parent_process()
    if parent is None:
        return

    def watch() -> None:
        parent_gone = multiprocessing.connection.wait([parent.sentinel], timeout=deadline_seconds)
        os._exit(WORKER_EXIT_ORPHANED if parent_gone else WORKER_EXIT_DEADLINE)

    threading.Thread(target=watch, name="pdf-worker-guard", daemon=True).start()


def prepare_worker(budget_seconds: float, memory_limit_mb: int) -> str:
    start_worker_guard(budget_seconds + PDF_WORKER_DEADLINE_GRACE_SECONDS)
    status = apply_worker_memory_limit(memory_limit_mb)
    if status not in {"enforced", "disabled"}:
        print(f"PDF worker memory limit: {status}", file=sys.stderr, flush=True)
    return status


def _pdf_worker(
    pdf_bytes: bytes,
    connection: object,
    budget_seconds: float = PDF_TIME_BUDGET_SECONDS,
    memory_limit_mb: int = PDF_WORKER_MEMORY_LIMIT_MB,
    max_stream_bytes: int = PDF_MAX_STREAM_BYTES,
) -> None:
    """Entry point of the extraction process: sends ("ok", result), ("limit", message) or ("error", "")."""
    try:
        prepare_worker(budget_seconds, memory_limit_mb)
        connection.send(("ok", extract_pdf(pdf_bytes, max_stream_bytes)))
    except DocumentLimitError as error:
        connection.send(("limit", str(error)))
    except MemoryError:
        connection.send(("limit", memory_limit_message(memory_limit_mb)))
    except BaseException:
        connection.send(("error", ""))
    finally:
        connection.close()


def client_disconnected(connection: socket.socket) -> bool:
    """True when the peer has closed the connection (the request body has already been read)."""
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and connection.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


def run_pdf_extraction(
    pdf_bytes: bytes,
    budget_seconds: float = PDF_TIME_BUDGET_SECONDS,
    should_abort: object = None,
    worker: object = None,
    memory_limit_mb: int = PDF_WORKER_MEMORY_LIMIT_MB,
    max_stream_bytes: int = PDF_MAX_STREAM_BYTES,
) -> tuple[str, list[dict[str, object]]]:
    """Extract a PDF in a separate process that is killed when the time budget runs out or the client leaves.

    pdfminer.six cannot be interrupted from inside, and a thread that keeps running after the client gave up
    keeps using a CPU, so the work lives in a process that can be stopped for good. The worker also limits its own
    memory and time and exits when this process dies, so a hard-killed sidecar leaves nothing running.
    """
    if not _PDF_JOBS.acquire(timeout=PDF_QUEUE_WAIT_SECONDS):
        raise ExtractionBusy("The document service is busy with other PDFs. Try again in a moment.")
    receiver = sender = process = None
    started = False
    try:  # Everything after the slot was taken is inside the try, so an early failure cannot leak the slot.
        context = multiprocessing.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(
            target=worker or _pdf_worker,
            args=(pdf_bytes, sender, budget_seconds, memory_limit_mb, max_stream_bytes),
            daemon=True,
        )
        process.start()
        started = True
        sender.close()
        sender = None
        deadline = time.monotonic() + budget_seconds
        while True:
            if receiver.poll(0.1):
                try:
                    kind, value = receiver.recv()
                except EOFError as error:
                    raise ExtractionCrashed(memory_limit_mb) from error
                break
            if not process.is_alive() and not receiver.poll(0):
                raise ExtractionCrashed(memory_limit_mb)
            if should_abort is not None and should_abort():
                raise ExtractionAborted()
            if time.monotonic() >= deadline:
                raise ExtractionTimeout(
                    f"PDF extraction was stopped after {budget_seconds:g} seconds. The document is too large or too "
                    "complex for the local extractor; split it or export it again."
                )
    finally:
        try:
            if process is not None and started:
                if process.is_alive():
                    process.kill()
                process.join(10)
        finally:
            for end in (receiver, sender):
                if end is not None:
                    end.close()
            _PDF_JOBS.release()
    if kind == "ok":
        return value
    if kind == "limit":
        raise DocumentLimitError(value)
    raise RuntimeError("PDF extraction failed.")


def main() -> None:
    arguments = parse_args()
    host = validate_local_host(arguments.host)
    DocumentHandler.pdf_time_budget = arguments.pdf_time_budget
    DocumentHandler.pdf_memory_limit_mb = arguments.pdf_memory_limit_mb
    server = ThreadingHTTPServer((host, arguments.port), DocumentHandler)
    server.daemon_threads = True
    print(f"StudentLLM local document extraction listening on http://{host}:{arguments.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
