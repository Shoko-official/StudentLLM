"""Serve a local faster-whisper transcription endpoint for the desktop app."""

from __future__ import annotations

import argparse
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from scripts.local_server_security import MAX_ASR_UPLOAD_BYTES, allowed_origin, validate_content_length, validate_local_host
except ModuleNotFoundError:  # Running this file directly from the scripts directory.
    from local_server_security import MAX_ASR_UPLOAD_BYTES, allowed_origin, validate_content_length, validate_local_host


MAX_PREVIEW_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_PREVIEW_SECONDS = 30
MAX_PROMPT_CHARACTERS = 500
MAX_QUERY_CHARACTERS = 8192


def preview_wav(audio: bytes) -> bytes:
    """Validate a bounded PCM window before any model work or media decoding."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            channels = source.getnchannels()
            rate = source.getframerate()
            frames = source.getnframes()
            if source.getsampwidth() != 2 or channels not in (1, 2) or not 8000 <= rate <= 48000:
                raise ValueError("Preview requires 16-bit PCM WAV, mono or stereo, at 8-48 kHz.")
            if frames <= 0 or frames > MAX_PREVIEW_SECONDS * rate:
                raise ValueError(f"Preview audio must contain more than 0 and at most {MAX_PREVIEW_SECONDS} seconds.")
            pcm = source.readframes(frames)
            if len(pcm) != frames * channels * 2:
                raise ValueError("Preview WAV data is incomplete.")
    except (wave.Error, EOFError, RuntimeError) as error:
        # wave also raises RuntimeError when a malformed chunk seeks past its RIFF boundary.
        raise ValueError("Preview requires a complete PCM WAV file.") from error

    # Forward only the checked frames, never unchecked trailing data or streams.
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(pcm)
    return buffer.getvalue()


class TranscriptionHandler(BaseHTTPRequestHandler):
    server_version = "StudentLLM-ASR/1.0"

    def _write_json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload, allow_nan=False).encode("utf-8")
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
        self._write_json(200, {
            "status": "ok",
            "model": self.server.model_name,
            "device": self.server.device,
            "compute_type": self.server.compute_type,
            "diarization": False,
        })

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._write_json(404, {"error": "Not found."})
            return
        try:
            if len(parsed.query) > MAX_QUERY_CHARACTERS:
                raise ValueError("The transcription query is too long.")
            query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=8, errors="strict")
            if any(len(query.get(name, [])) > 1 for name in ("mode", "language", "prompt")):
                raise ValueError("Transcription options must not be repeated.")
            mode = query.get("mode", ["full"])[0]
            if mode not in ("full", "preview"):
                raise ValueError("Mode must be full or preview.")
            language = query.get("language", [self.server.default_language])[0] or None
            prompt = query.get("prompt", [""])[0]
            if len(prompt) > MAX_PROMPT_CHARACTERS:
                raise ValueError(f"Vocabulary context must not exceed {MAX_PROMPT_CHARACTERS} characters.")
            if any(not character.isprintable() for character in prompt) or "<|" in prompt or "|>" in prompt:
                raise ValueError("Vocabulary context must be plain text without control characters or model tokens.")
            prompt = prompt.strip() or None
        except ValueError:
            self._write_json(400, {"error": "Invalid transcription options."})
            return

        if self.headers.get("Transfer-Encoding") is not None or len(self.headers.get_all("Content-Length", [])) != 1:
            self._write_json(400, {"error": "A single Content-Length header is required; chunked uploads are unsupported."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        maximum = MAX_PREVIEW_UPLOAD_BYTES if mode == "preview" else MAX_ASR_UPLOAD_BYTES
        try:
            validate_content_length(length, maximum)
        except ValueError as error:
            self._write_json(413 if length > maximum else 400, {"error": str(error)})
            return

        audio = self.rfile.read(length)
        if len(audio) != length:
            self._write_json(400, {"error": "The request body is incomplete."})
            return
        if mode == "preview":
            try:
                audio = preview_wav(audio)
            except ValueError as error:
                self._write_json(400, {"error": str(error)})
                return
        try:
            with self.server.model_lock:
                segments, info = self.server.model.transcribe(
                    io.BytesIO(audio),
                    language=language,
                    task="transcribe",
                    beam_size=1 if mode == "preview" else 5,
                    temperature=0.0,
                    condition_on_previous_text=False,
                    initial_prompt=prompt,
                    vad_filter=True,
                    # The default 0.5 gate drops quiet lecture phrases before decoding.
                    vad_parameters={"threshold": 0.25, "min_silence_duration_ms": 1000, "speech_pad_ms": 400},
                    no_speech_threshold=0.6,
                    log_prob_threshold=-1.0,
                    compression_ratio_threshold=2.4,
                    word_timestamps=True,
                    hallucination_silence_threshold=2.0,
                )
                # faster-whisper performs inference while this generator is consumed.
                transcribed_segments = list(segments)
            result_segments = []
            for index, segment in enumerate(transcribed_segments):
                if not segment.text.strip():
                    continue
                result = {
                    "id": f"local-asr-{index}",
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "speaker": "",
                    "text": segment.text.strip(),
                }
                if mode == "preview":
                    result["words"] = [
                        {"start": float(word.start), "end": float(word.end), "word": word.word}
                        for word in (getattr(segment, "words", None) or [])
                    ]
                result_segments.append(result)
            self._write_json(200, {
                "model": self.server.model_name,
                "mode": mode,
                "diarization": False,
                "language": getattr(info, "language", language),
                "duration": getattr(info, "duration", None),
                "segments": result_segments,
            })
        except (BrokenPipeError, ConnectionResetError):
            # A client may abort a superseded preview while inference finishes.
            return
        except Exception:
            self._write_json(422, {"error": "Transcription failed."})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="large-v3-turbo", help="faster-whisper model name or local path (default: large-v3-turbo; small is a lighter option)")
    parser.add_argument("--language", default="fr", help="default language code")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def main() -> None:
    arguments = parse_args()
    host = validate_local_host(arguments.host)
    from faster_whisper import WhisperModel

    model = WhisperModel(arguments.model, device=arguments.device, compute_type=arguments.compute_type)
    server = ThreadingHTTPServer((host, arguments.port), TranscriptionHandler)
    server.daemon_threads = True
    server.model = model
    server.model_lock = threading.Lock()
    server.model_name = arguments.model
    server.default_language = arguments.language
    server.device = arguments.device
    server.compute_type = arguments.compute_type
    print(f"StudentLLM local ASR listening on http://{host}:{arguments.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
