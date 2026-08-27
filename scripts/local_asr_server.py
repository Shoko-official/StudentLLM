"""Serve a local faster-whisper transcription endpoint for the desktop app."""

from __future__ import annotations

import argparse
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class TranscriptionHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-ASR/1.0"

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
        self._write_json(200, {"status": "ok", "model": self.server.model_name})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._write_json(404, {"error": "Not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._write_json(400, {"error": "The request body is empty."})
            return

        audio = self.rfile.read(length)
        language = parse_qs(parsed.query).get("language", [self.server.default_language])[0] or None
        try:
            with self.server.model_lock:
                segments, info = self.server.model.transcribe(
                    io.BytesIO(audio),
                    language=language,
                    beam_size=5,
                    vad_filter=True,
                )
                result_segments = [
                    {
                        "id": f"local-asr-{index}",
                        "start": segment.start,
                        "end": segment.end,
                        "speaker": "Speaker",
                        "text": segment.text.strip(),
                    }
                    for index, segment in enumerate(segments)
                    if segment.text.strip()
                ]
            self._write_json(200, {
                "model": self.server.model_name,
                "language": getattr(info, "language", language),
                "duration": getattr(info, "duration", None),
                "segments": result_segments,
            })
        except Exception as error:
            self._write_json(422, {"error": f"Transcription failed: {error}"})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="small", help="faster-whisper model name or local path")
    parser.add_argument("--language", default="fr", help="default language code")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    from faster_whisper import WhisperModel

    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)
    server = ThreadingHTTPServer((arguments.host, arguments.port), TranscriptionHandler)
    server.model = model
    server.model_lock = threading.Lock()
    server.model_name = arguments.model
    server.default_language = arguments.language
    print(f"StudentLLM local ASR listening on http://{arguments.host}:{arguments.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
