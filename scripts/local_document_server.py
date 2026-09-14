"""Serve local PDF and image text extraction through a small HTTP sidecar."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class DocumentHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-Documents/1.2"

    def _write_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS, POST")
        self.send_header("Access-Control-Allow-Origin", "*")
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
            "model": "pymupdf+rapidocr" if ocr_available else "pymupdf",
            "capabilities": ["pdf-text", "image-ocr", "scanned-pdf-ocr"] if ocr_available else ["pdf-text"],
            "ocrAvailable": ocr_available,
        })

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/extract":
            self._write_json(404, {"error": "Not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._write_json(400, {"error": "The request body is empty."})
            return

        try:
            payload = self.rfile.read(length)
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type == "application/pdf":
                model, pages = extract_pdf(payload)
            elif content_type.startswith("image/"):
                model, pages = extract_image(payload)
            else:
                self._write_json(415, {"error": "Only application/pdf and image/* inputs are supported."})
                return
            self._write_json(200, {"model": model, "pages": pages})
        except Exception as error:
            self._write_json(422, {"error": f"Document extraction failed: {error}"})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    return parser.parse_args()


def has_ocr_dependencies() -> bool:
    try:
        from rapidocr import RapidOCR  # noqa: F401
        return True
    except Exception:
        return False


def ocr_image(image: bytes) -> tuple[str, list[dict[str, object]]]:
    from rapidocr import RapidOCR

    result = RapidOCR()(image)
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
        blocks.append({"x": left, "y": top, "width": right - left, "height": bottom - top, "text": value})
    return "rapidocr", blocks


def extract_image(image: bytes) -> tuple[str, list[dict[str, object]]]:
    model, blocks = ocr_image(image)
    return model, [{"pageNumber": 1, "text": "\n".join(block["text"] for block in blocks), "blocks": blocks}]


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


def formula_crop_bounds(blocks: list[dict[str, object]], group: list[int], page: object) -> tuple[float, float, float, float]:
    members = [blocks[index] for index in group]
    return (
        max(0, min(member["bbox"][0] for member in members) - 4),
        max(0, min(member["bbox"][1] for member in members) - 4),
        min(page.rect.width, max(member["bbox"][2] for member in members) + 4),
        min(page.rect.height, max(member["bbox"][3] for member in members) + 4),
    )


def is_block_covered_by_formula_crop(block: dict[str, object], crop: tuple[float, float, float, float]) -> bool:
    bbox = block["bbox"]
    return bbox[0] >= crop[0] and bbox[1] >= crop[1] and bbox[2] <= crop[2] and bbox[3] <= crop[3]


def formula_aware_pdf_blocks(page: object) -> list[dict[str, object]]:
    raw_blocks = [block for block in page.get_text("dict").get("blocks", []) if block.get("type") == 0 and block_text(block)]
    blocks = [{"bbox": tuple(block["bbox"]), "text": block_text(block), "math": math_character_counts(block)[0] > 0, "raw": block} for block in raw_blocks]
    formula_groups = [group for group in group_formula_blocks(blocks) if is_formula_group([blocks[index]["raw"] for index in group])]
    grouped_indexes = {index for group in formula_groups for index in group}
    formula_crops = [formula_crop_bounds(blocks, group, page) for group in formula_groups]
    covered_indexes = {
        index
        for index, block in enumerate(blocks)
        if index not in grouped_indexes and any(is_block_covered_by_formula_crop(block, crop) for crop in formula_crops)
    }
    rendered: list[dict[str, object]] = [
        {"x": block["bbox"][0], "y": block["bbox"][1], "width": block["bbox"][2] - block["bbox"][0], "height": block["bbox"][3] - block["bbox"][1], "text": block["text"]}
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
        })
    return sorted(rendered, key=lambda block: (block["y"], block["x"]))


def extract_pdf(pdf_bytes: bytes) -> tuple[str, list[dict[str, object]]]:
    import fitz

    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    used_ocr = False
    try:
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text").strip()
            blocks = formula_aware_pdf_blocks(page)
            if not text:
                used_ocr = True
                image = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
                _, blocks = ocr_image(image)
                text = "\n".join(block["text"] for block in blocks)
            pages.append({"pageNumber": page_number, "text": text, "blocks": blocks})
    finally:
        document.close()
    return ("pymupdf+rapidocr" if used_ocr else "pymupdf"), pages


def main() -> None:
    arguments = parse_args()
    server = ThreadingHTTPServer((arguments.host, arguments.port), DocumentHandler)
    print(f"StudentLLM local document extraction listening on http://{arguments.host}:{arguments.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
