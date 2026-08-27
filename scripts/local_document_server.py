"""Serve local PDF and image text extraction through a small HTTP sidecar."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class DocumentHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-Documents/1.1"

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
        self._write_json(200, {"status": "ok", "model": "pymupdf+rapidocr"})

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


def extract_pdf(pdf_bytes: bytes) -> tuple[str, list[dict[str, object]]]:
    import fitz

    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    used_ocr = False
    try:
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text").strip()
            blocks = []
            for block in page.get_text("blocks"):
                value = block[4].strip() if len(block) > 4 else ""
                if not value:
                    continue
                blocks.append({"x": block[0], "y": block[1], "width": block[2] - block[0], "height": block[3] - block[1], "text": value})
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
