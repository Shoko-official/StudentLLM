"""ASR protocol tests using only the standard library and a lazy fake model."""

import http.client
import io
import json
import socket
import sys
import threading
import unittest
import wave
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from scripts import local_asr_server as asr


def pcm_wav(seconds=1, sample_rate=16000, channels=1, sample_width=2):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(sample_width)
        audio.setframerate(sample_rate)
        audio.writeframes(b"\x00" * int(seconds * sample_rate) * channels * sample_width)
    return buffer.getvalue()


def segment(text=" La dérivée est nulle.", start=1.125, end=2.75):
    return SimpleNamespace(
        id=7, seek=0, start=start, end=end, text=text, tokens=[1, 2],
        avg_logprob=-0.2, no_speech_prob=0.01, temperature=0.0,
        compression_ratio=1.1,
        words=[SimpleNamespace(start=start, end=end, word=text, probability=0.95)],
    )


class FakeWhisperModel:
    def __init__(self, lock):
        self.lock = lock
        self.calls = []
        self.segments = [segment()]
        self.info = SimpleNamespace(language="fr", duration=3.0)
        self.lock_states = []
        self.exhausted = False
        self.start_error = None
        self.iteration_error = None

    def transcribe(self, audio, **options):
        self.calls.append((audio.read(), options))
        self.lock_states.append(self.lock.locked())
        if self.start_error:
            raise self.start_error

        def generate():
            for item in self.segments:
                self.lock_states.append(self.lock.locked())
                yield item
            self.lock_states.append(self.lock.locked())
            if self.iteration_error:
                raise self.iteration_error
            self.exhausted = True

        return generate(), self.info


class QuietHandler(asr.TranscriptionHandler):
    def log_message(self, format, *args):
        pass


class LocalAsrServerTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.server.daemon_threads = True
        self.server.model_lock = threading.Lock()
        self.model = FakeWhisperModel(self.server.model_lock)
        self.server.model = self.model
        self.server.model_name = "large-v3-turbo"
        self.server.default_language = "fr"
        self.server.device = "cpu"
        self.server.compute_type = "int8"
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True,
        )
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path="/transcribe", body=b"encoded audio", method="POST", headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), json.loads(raw) if raw else None
        finally:
            connection.close()

    def raw_request(self, request):
        with socket.create_connection(self.server.server_address, timeout=3) as connection:
            connection.sendall(request)
            connection.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, json.loads(response.read())

    def test_health_reports_configured_runtime_without_diarization(self):
        self.server.device = "cuda"
        self.server.compute_type = "float16"
        status, headers, body = self.request("/health", method="GET", body=None)
        self.assertEqual(status, 200)
        self.assertEqual(body, {
            "status": "ok", "model": "large-v3-turbo", "device": "cuda",
            "compute_type": "float16", "diarization": False,
        })
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.model.calls, [])

    def test_full_transcription_returns_numeric_times_without_word_payload_or_speaker_identity(self):
        self.model.segments += [segment("   "), segment(" On intègre.", 32.5, 33.75)]
        self.model.info.duration = 45.0
        status, _, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body.get("mode"), "full")
        self.assertIs(body.get("diarization"), False)
        self.assertEqual(body["duration"], 45.0)
        self.assertEqual(body["language"], "fr")
        self.assertEqual(body["segments"], [
            {
                "id": "local-asr-0", "start": 1.125, "end": 2.75,
                "speaker": "", "text": "La dérivée est nulle.",
            },
            {
                "id": "local-asr-2", "start": 32.5, "end": 33.75,
                "speaker": "", "text": "On intègre.",
            },
        ])
        self.assertEqual(self.model.calls[0][0], b"encoded audio")
        options = self.model.calls[0][1]
        self.assertEqual(options["language"], "fr")
        self.assertEqual(options["beam_size"], 5)
        self.assertNotIn("clip_timestamps", options)
        self.assertNotIn("max_new_tokens", options)

    def test_decoding_options_protect_silence_without_banning_math_repetition(self):
        status, _, _ = self.request()
        self.assertEqual(status, 200)
        options = self.model.calls[0][1]
        self.assertEqual(options.get("task"), "transcribe")
        self.assertEqual(options.get("temperature"), 0.0)
        self.assertIs(options.get("condition_on_previous_text"), False)
        self.assertIs(options.get("word_timestamps"), True)
        self.assertIs(options.get("vad_filter"), True)
        self.assertEqual(options.get("vad_parameters"), {
            "min_silence_duration_ms": 1000, "speech_pad_ms": 400,
        })
        self.assertEqual(options.get("no_speech_threshold"), 0.6)
        self.assertEqual(options.get("log_prob_threshold"), -1.0)
        self.assertEqual(options.get("compression_ratio_threshold"), 2.4)
        self.assertEqual(options.get("hallucination_silence_threshold"), 2.0)
        self.assertNotIn("no_repeat_ngram_size", options)
        self.assertNotIn("repetition_penalty", options)
        self.assertIsNone(options.get("initial_prompt"))

    def test_lock_is_held_until_lazy_segments_are_exhausted(self):
        self.model.segments += [segment(" Suite.")]
        status, _, _ = self.request()
        self.assertEqual(status, 200)
        self.assertTrue(self.model.exhausted)
        self.assertEqual(self.model.lock_states, [True, True, True, True])
        self.assertFalse(self.server.model_lock.locked())

    def test_preview_accepts_complete_bounded_pcm_wav(self):
        self.model.segments[0].words = [
            SimpleNamespace(start=1.125, end=1.3, word=" La", probability=0.99),
            SimpleNamespace(start=1.3, end=2.1, word=" dérivée", probability=0.95),
            SimpleNamespace(start=2.1, end=2.35, word=" est", probability=0.97),
            SimpleNamespace(start=2.35, end=2.75, word=" nulle.", probability=0.94),
        ]
        audio = pcm_wav(seconds=30, sample_rate=48000, channels=2)
        status, _, body = self.request("/transcribe?mode=preview", audio)
        self.assertEqual(status, 200)
        self.assertEqual(body.get("mode"), "preview")
        self.assertIs(body.get("diarization"), False)
        self.assertEqual(body["segments"][0]["speaker"], "")
        self.assertEqual((body["segments"][0]["start"], body["segments"][0]["end"]), (1.125, 2.75))
        self.assertEqual(body["segments"][0].get("words"), [
            {"start": 1.125, "end": 1.3, "word": " La"},
            {"start": 1.3, "end": 2.1, "word": " dérivée"},
            {"start": 2.1, "end": 2.35, "word": " est"},
            {"start": 2.35, "end": 2.75, "word": " nulle."},
        ])
        self.assertEqual(self.model.calls[0][0], audio)
        self.assertEqual(self.model.calls[0][1]["beam_size"], 1)
        self.assertIs(self.model.calls[0][1].get("word_timestamps"), True)
        self.assertTrue(self.model.exhausted)
        self.assertTrue(all(self.model.lock_states))

    def test_silence_is_successful_empty_transcription_in_both_modes(self):
        self.model.segments = []
        for mode in ("full", "preview"):
            with self.subTest(mode=mode):
                status, _, body = self.request(f"/transcribe?mode={mode}", pcm_wav())
                self.assertEqual(status, 200)
                self.assertEqual(body["segments"], [])
                self.assertIs(body.get("diarization"), False)
                self.assertIs(self.model.calls[-1][1].get("vad_filter"), True)
                self.assertEqual(self.model.calls[-1][1].get("no_speech_threshold"), 0.6)

    def test_preview_only_forwards_validated_pcm_frames(self):
        audio = pcm_wav()
        status, _, _ = self.request("/transcribe?mode=preview", audio + pcm_wav(seconds=31))
        self.assertEqual(status, 200)
        self.assertEqual(self.model.calls[0][0], audio)

    def test_query_cannot_override_decoding_options(self):
        status, _, _ = self.request("/transcribe?beam_size=100&task=translate&device=cuda")
        self.assertEqual(status, 200)
        options = self.model.calls[-1][1]
        self.assertEqual(options.get("beam_size"), 5)
        self.assertEqual(options.get("task"), "transcribe")
        self.assertNotIn("device", options)

    def test_preview_rejects_long_invalid_or_truncated_audio_before_model(self):
        samples = [
            b"not a WAV", pcm_wav(seconds=30.001), pcm_wav(seconds=0),
            pcm_wav()[:-2], pcm_wav(sample_width=1), pcm_wav(channels=3),
            pcm_wav(sample_rate=96000), pcm_wav(sample_rate=4000),
        ]
        for audio in samples:
            with self.subTest(length=len(audio)):
                status, _, body = self.request("/transcribe?mode=preview", audio)
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        self.assertEqual(self.model.calls, [])

    def test_full_recording_is_not_subject_to_preview_duration_or_format_limit(self):
        for audio in (pcm_wav(seconds=31), b"encoded webm recording"):
            with self.subTest(length=len(audio)):
                status, _, body = self.request("/transcribe?mode=full", audio)
                self.assertEqual(status, 200)
                self.assertEqual(body.get("mode"), "full")
        self.assertEqual(len(self.model.calls), 2)

    def test_preview_rejects_malformed_riff_and_format_chunk_sizes(self):
        for offset, size in ((4, 12), (16, 0x7fffffff)):
            with self.subTest(offset=offset):
                audio = bytearray(pcm_wav())
                audio[offset:offset + 4] = size.to_bytes(4, "little")
                status, _, body = self.request("/transcribe?mode=preview", bytes(audio))
                self.assertEqual(status, 400)
                self.assertIn("error", body)
        self.assertEqual(self.model.calls, [])

    def test_upload_limits_reject_before_reading_the_body_or_calling_model(self):
        for query, size in (("", 250 * 1024 * 1024 + 1), ("?mode=preview", 8 * 1024 * 1024 + 1)):
            with self.subTest(query=query):
                status, body = self.raw_request(
                    f"POST /transcribe{query} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {size}\r\n\r\n".encode(),
                )
                self.assertEqual(status, 413)
                self.assertIn("error", body)
        self.assertEqual(self.model.calls, [])

    def test_bad_lengths_chunked_and_incomplete_bodies_are_rejected(self):
        cases = [
            (b"", b""),
            (b"Content-Length: 0\r\n", b""),
            (b"Content-Length: -1\r\n", b""),
            (b"Content-Length: invalid\r\n", b""),
            (b"Content-Length: 4\r\n", b"ab"),
            (b"Content-Length: 2\r\nContent-Length: 4\r\n", b"abcd"),
            (b"Content-Length: 4\r\nTransfer-Encoding: chunked\r\n", b"abcd"),
        ]
        for headers, body in cases:
            with self.subTest(headers=headers):
                status, response = self.raw_request(
                    b"POST /transcribe HTTP/1.1\r\nHost: localhost\r\n" + headers + b"\r\n" + body,
                )
                self.assertEqual(status, 400)
                self.assertIn("error", response)
        self.assertEqual(self.model.calls, [])

    def test_vocabulary_hint_is_decoded_and_scoped_to_one_request(self):
        prompt = "  intégrale, dérivée, théorème de Bayes  "
        status, _, _ = self.request("/transcribe?" + urlencode({"language": "en", "prompt": prompt}))
        self.assertEqual(status, 200)
        options = self.model.calls[-1][1]
        self.assertEqual(options["language"], "en")
        self.assertEqual(options.get("initial_prompt"), prompt.strip())
        self.request()
        self.assertIsNone(self.model.calls[-1][1].get("initial_prompt"))
        self.assertEqual(self.model.calls[-1][1]["language"], "fr")

    def test_vocabulary_boundary_and_blank_hint(self):
        for prompt in ("é" * 500, "  "):
            with self.subTest(length=len(prompt)):
                status, _, _ = self.request("/transcribe?" + urlencode({"prompt": prompt}))
                self.assertEqual(status, 200)
                self.assertEqual(self.model.calls[-1][1].get("initial_prompt"), prompt.strip() or None)

    def test_rejects_oversized_control_or_special_token_hints(self):
        for prompt in ("x" * 501, "terme\ncommande", "terme\x00", "<|startoftranscript|>", "x\u202ey"):
            with self.subTest(prompt=repr(prompt[:30])):
                status, _, _ = self.request("/transcribe?" + urlencode({"prompt": prompt}))
                self.assertEqual(status, 400)
        self.assertEqual(self.model.calls, [])

    def test_rejects_invalid_modes_duplicate_options_and_unbounded_queries(self):
        for query in (
            "mode=other", "mode=", "mode=preview&mode=full", "prompt=a&prompt=b",
            "language=fr&language=en", "prompt=%FF", "x=" + "a" * 8192,
            "&".join(f"q{i}=a" for i in range(9)),
        ):
            with self.subTest(query=query[:50]):
                status, _, _ = self.request("/transcribe?" + query)
                self.assertEqual(status, 400)
        self.assertEqual(self.model.calls, [])

    def test_model_errors_are_generic_and_release_lock_without_partial_results(self):
        for error_type in ("start_error", "iteration_error"):
            with self.subTest(error_type=error_type):
                setattr(self.model, error_type, RuntimeError("private model path and details"))
                status, _, body = self.request()
                self.assertEqual(status, 422)
                self.assertEqual(body, {"error": "Transcription failed."})
                self.assertFalse(self.server.model_lock.locked())
                setattr(self.model, error_type, None)
        self.assertEqual(self.request()[0], 200)

    def test_nonfinite_model_timestamps_do_not_escape_as_invalid_json(self):
        self.model.segments = [segment(start=float("nan"))]
        status, _, body = self.request()
        self.assertEqual(status, 422)
        self.assertEqual(body, {"error": "Transcription failed."})

    def test_cors_headers_remain_restricted_and_preflight_is_available(self):
        for origin, allowed in (("http://localhost:5173", True), ("https://attacker.example", False)):
            with self.subTest(origin=origin):
                status, headers, _ = self.request("/health", method="GET", body=None, headers={"Origin": origin})
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin if allowed else None)
        status, headers, _ = self.request(
            "/transcribe", method="OPTIONS", body=None, headers={"Origin": "http://localhost:5173"},
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Headers"], "content-type")
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, OPTIONS, POST")

    def test_unknown_paths_are_not_transcribed(self):
        for method in ("GET", "POST"):
            self.assertEqual(self.request("/unknown", method=method)[0], 404)
        self.assertEqual(self.model.calls, [])


class LocalAsrStartupTests(unittest.TestCase):
    def test_default_and_small_cpu_profiles_are_wired_into_model_and_health(self):
        for command, expected in (([], "large-v3-turbo"), (["--model", "small"], "small")):
            with self.subTest(command=command):
                factory = Mock(return_value=object())
                server = SimpleNamespace(serve_forever=Mock(), server_close=Mock())
                with (
                    patch.object(sys, "argv", ["local_asr_server.py", *command]),
                    patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=factory)}),
                    patch.object(asr, "ThreadingHTTPServer", return_value=server),
                    patch("builtins.print"),
                ):
                    asr.main()
                factory.assert_called_once_with(expected, device="cpu", compute_type="int8")
                self.assertEqual(server.model_name, expected)
                self.assertEqual(getattr(server, "device", None), "cpu")
                self.assertEqual(getattr(server, "compute_type", None), "int8")
                self.assertEqual(server.default_language, "fr")
                self.assertIs(server.model, factory.return_value)
                server.server_close.assert_called_once()

    def test_nonloopback_bind_is_rejected_before_model_import(self):
        with (
            patch.object(sys, "argv", ["local_asr_server.py", "--host", "0.0.0.0"]),
            patch.dict(sys.modules, {"faster_whisper": None}),
        ):
            with self.assertRaisesRegex(ValueError, "loopback"):
                asr.main()


if __name__ == "__main__":
    unittest.main()
