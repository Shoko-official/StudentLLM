"""Serve local digital-PDF extraction through a small HTTP sidecar."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class DocumentHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-Documents/1.0"

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
        self._write_json(200, {"status": "ok", "model": "pymupdf"})

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
            import fitz

            document = fitz.open(stream=self.rfile.read(length), filetype="pdf")
            pages = []
            for page_number, page in enumerate(document, start=1):
                blocks = []
                for block in page.get_text("blocks"):
                    text = block[4].strip() if len(block) > 4 else ""
                    if not text:
                        continue
                    blocks.append({"x": block[0], "y": block[1], "width": block[2] - block[0], "height": block[3] - block[1], "text": text})
                pages.append({"pageNumber": page_number, "text": page.get_text("text").strip(), "blocks": blocks})
            document.close()
            self._write_json(200, {"model": "pymupdf", "pages": pages})
        except Exception as error:
            self._write_json(422, {"error": f"PDF extraction failed: {error}"})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    return parser.parse_args()


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
