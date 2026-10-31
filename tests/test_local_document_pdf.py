"""PDF extraction through the real pdfminer.six and pypdfium2 engines on generated fixtures.

These tests need `pip install -r requirements-local-documents.txt`; they skip when the PDF
libraries are missing so the plain benchmark checks keep running without them.
"""

import json
import multiprocessing
import os
import random
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path
from io import BytesIO
from unittest import mock

from scripts import local_document_server
from tests import pdf_fixtures

try:
    import pdfminer  # noqa: F401
    import pypdfium2  # noqa: F401
    PDF_ENGINES = True
except ImportError:
    PDF_ENGINES = False

try:
    import PIL  # noqa: F401
    import rapidocr  # noqa: F401
    OCR_ENGINE = True
except ImportError:
    OCR_ENGINE = False

REPOSITORY_ROOT = str(Path(__file__).resolve().parent.parent)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def blank_scan(pages: int = 1) -> bytes:
    return pdf_fixtures.image_only_pdf(bytes([255]) * (60 * 80), 60, 80, pages=pages)


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class PdfExtractionTests(unittest.TestCase):
    def test_extracts_text_pages_with_positions(self):
        model, pages = local_document_server.extract_pdf(pdf_fixtures.article_pdf())

        self.assertEqual(model, "pdfminer")
        self.assertEqual([page["pageNumber"] for page in pages], [1, 2])
        self.assertIn("Quarterly Energy Report", pages[0]["text"])
        self.assertIn("Meters were read monthly", pages[1]["text"])
        title = pages[0]["blocks"][0]
        self.assertEqual(title["text"], "Quarterly Energy Report")
        self.assertEqual(title["kind"], "paragraph")
        # Top-left origin in PDF points: the title sits near the top and left margin of a 792 pt page.
        self.assertAlmostEqual(title["x"], 72, delta=1)
        self.assertLess(title["y"], 100)
        self.assertGreater(title["width"], 100)
        self.assertGreater(title["height"], 10)
        ys = [block["y"] for block in pages[0]["blocks"]]
        self.assertEqual(ys, sorted(ys))

    def test_keeps_bullet_lines_together_and_separate_from_headings(self):
        _, pages = local_document_server.extract_pdf(pdf_fixtures.article_pdf())

        texts = [block["text"] for block in pages[0]["blocks"]]
        self.assertIn("Highlights", texts)
        bullets = [text for text in texts if "Consumption fell" in text]
        self.assertEqual(len(bullets), 1)
        self.assertIn("Solar output doubled", bullets[0])

    def test_reports_font_names_without_the_subset_prefix(self):
        layout = list(self._layout(pdf_fixtures.article_pdf()))[0]
        blocks, width, height = local_document_server.pdf_layout_blocks(layout)

        self.assertEqual((width, height), (612, 792))
        fonts = {span["font"] for block in blocks for line in block["lines"] for span in line["spans"]}
        self.assertTrue(any("Helvetica" in font for font in fonts))
        self.assertTrue(all("+" not in font for font in fonts))
        self.assertEqual(local_document_server._span_font("ABCDEF+CMMI10"), "CMMI10")
        self.assertEqual(local_document_server._span_font("CMMI10"), "CMMI10")

    def test_rejects_documents_with_too_many_pages(self):
        pdf = pdf_fixtures.text_pdf([[("F1", 10, 72, 700, "x")]] * (local_document_server.MAX_PDF_PAGES + 1))

        with self.assertRaisesRegex(ValueError, "more than 500 pages"):
            local_document_server.extract_pdf(pdf)

    def test_rejects_data_that_is_not_a_pdf(self):
        with self.assertRaises(Exception):
            local_document_server.extract_pdf(b"not a pdf at all")

    def test_renders_pages_without_a_text_layer_and_hands_them_to_ocr(self):
        calls = []

        def fake_ocr(image):
            calls.append(image)
            return "rapidocr", [{"x": 1, "y": 2, "width": 3, "height": 4, "text": "Scanned words", "kind": "text"}]

        with mock.patch.object(local_document_server, "ocr_image", side_effect=fake_ocr):
            model, pages = local_document_server.extract_pdf(blank_scan(pages=2))

        self.assertEqual(model, "pdfminer+rapidocr")
        self.assertEqual([page["text"] for page in pages], ["Scanned words", "Scanned words"])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call.startswith(PNG_MAGIC) for call in calls))

    def test_renders_scanned_pages_at_twice_the_point_size(self):
        calls = []
        with mock.patch.object(local_document_server, "ocr_image", side_effect=lambda image: calls.append(image) or ("rapidocr", [])):
            local_document_server.extract_pdf(blank_scan())

        from PIL import Image

        width, height = Image.open(BytesIO(calls[0])).size
        self.assertEqual((width, height), (612 * local_document_server.PDF_OCR_SCALE, 792 * local_document_server.PDF_OCR_SCALE))

    def test_ocrs_only_pages_whose_text_layer_has_unmapped_glyphs(self):
        pdf = pdf_fixtures.text_pdf([[("F1", 11, 72, 700, "Garbled first page")], [("F1", 11, 72, 700, "Clean printed text.")]])
        real_layout_blocks = local_document_server.pdf_layout_blocks
        seen = []

        def layout_with_a_broken_first_page(layout_page):
            blocks, width, height = real_layout_blocks(layout_page)
            seen.append(layout_page.pageid)
            if len(seen) == 1:
                blocks = [{"type": 0, "bbox": (72, 80, 200, 92), "lines": [{"spans": [{"text": "Montr\ue027r qu\ue027 \ue025\ue02a\ue023", "font": "F1"}]}]}]
            return blocks, width, height

        ocr_blocks = [{"x": 1, "y": 2, "width": 3, "height": 4, "text": "Montrer que chacun", "kind": "text"}]
        with mock.patch.object(local_document_server, "pdf_layout_blocks", side_effect=layout_with_a_broken_first_page), \
                mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=True), \
                mock.patch.object(local_document_server, "ocr_image", return_value=("rapidocr", ocr_blocks)) as ocr:
            model, pages = local_document_server.extract_pdf(pdf)

        self.assertEqual(model, "pdfminer+rapidocr")
        self.assertEqual(pages[0]["text"], "Montrer que chacun")
        self.assertEqual(pages[1]["text"], "Clean printed text.")
        ocr.assert_called_once()

    def test_keeps_an_unmapped_text_layer_when_ocr_is_not_installed(self):
        pdf = pdf_fixtures.text_pdf([[("F1", 11, 72, 700, "Garbled first page")]])
        broken = [{"type": 0, "bbox": (72, 80, 200, 92), "lines": [{"spans": [{"text": "(cid:1)(cid:2)(cid:3)(cid:4)", "font": "F1"}]}]}]
        with mock.patch.object(local_document_server, "pdf_layout_blocks", return_value=(broken, 612, 792)), \
                mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=False), \
                mock.patch.object(local_document_server, "ocr_image") as ocr:
            model, pages = local_document_server.extract_pdf(pdf)

        self.assertEqual(model, "pdfminer")
        self.assertIn("(cid:1)", pages[0]["text"])
        ocr.assert_not_called()

    @staticmethod
    def _layout(pdf: bytes):
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LAParams

        return extract_pages(BytesIO(pdf), laparams=LAParams(all_texts=True))


@unittest.skipUnless(PDF_ENGINES and OCR_ENGINE, "pdfminer.six, pypdfium2 and RapidOCR are not all installed")
class ScannedPdfOcrTests(unittest.TestCase):
    def test_reads_a_scanned_page_with_the_real_ocr_engine(self):
        pixels = pdf_fixtures.gray_text_bitmap("Energy report\nSolar output doubled")
        pdf = pdf_fixtures.image_only_pdf(pixels, pdf_fixtures.PAGE_WIDTH * 2, pdf_fixtures.PAGE_HEIGHT * 2)

        model, pages = local_document_server.extract_pdf(pdf)

        self.assertEqual(model, "pdfminer+rapidocr")
        text = pages[0]["text"].lower()
        self.assertIn("energy", text)
        self.assertIn("solar", text)
        self.assertTrue(all(block["kind"] == "text" for block in pages[0]["blocks"]))


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class DocumentServerHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), local_document_server.DocumentHandler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, content_type, body):
        request = urllib.request.Request(f"{self.base}/extract", data=body, headers={"Content-Type": content_type}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_health_names_the_permissive_pdf_stack_and_no_pymupdf(self):
        with mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=False):
            with urllib.request.urlopen(f"{self.base}/health", timeout=10) as response:
                health = json.loads(response.read())

        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["model"], "pdfminer")
        self.assertIn("pdf-text", health["capabilities"])
        self.assertNotIn("scanned-pdf-ocr", health["capabilities"])
        self.assertFalse(health["ocrAvailable"])
        self.assertNotIn("pymupdf", json.dumps(health).lower())
        self.assertEqual(health["limits"]["pdfPages"], 500)
        self.assertEqual(health["limits"]["pdfTimeBudgetSeconds"], local_document_server.DocumentHandler.pdf_time_budget)
        self.assertEqual(health["limits"]["pdfWorkerMemoryMb"], local_document_server.DocumentHandler.pdf_memory_limit_mb)
        self.assertEqual(health["limits"]["pdfStreamMegabytes"], 64)

    def test_health_advertises_ocr_when_it_is_installed(self):
        with mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=True):
            with urllib.request.urlopen(f"{self.base}/health", timeout=10) as response:
                health = json.loads(response.read())

        self.assertEqual(health["model"], "pdfminer+rapidocr")
        self.assertIn("scanned-pdf-ocr", health["capabilities"])
        self.assertTrue(health["ocrAvailable"])

    def test_extracts_a_pdf_over_http(self):
        status, body = self.post("application/pdf", pdf_fixtures.article_pdf())

        self.assertEqual(status, 200)
        self.assertEqual(body["model"], "pdfminer")
        self.assertEqual(len(body["pages"]), 2)
        self.assertIn("Quarterly Energy Report", body["pages"][0]["text"])

    def test_reports_a_broken_pdf_as_a_recoverable_error(self):
        status, body = self.post("application/pdf", b"%PDF-1.4 broken")

        self.assertEqual(status, 422)
        self.assertEqual(body["error"], "Document extraction failed.")

    def test_extracts_pptx_slide_text_over_http(self):
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "ppt/slides/slide1.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>'
                "<a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
            )
        status, body = self.post("application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer.getvalue())

        self.assertEqual(status, 200)
        self.assertEqual(body["pages"][0]["text"], "Slide one")


def _sleepy_worker(pdf_bytes, connection, *_settings):
    """A worker that never answers, to exercise the time budget and the cleanup."""
    time.sleep(120)


def _limit_worker(pdf_bytes, connection, *_settings):
    connection.send(("limit", "This document has too much of something."))
    connection.close()


def _crashing_worker(pdf_bytes, connection, *_settings):
    os._exit(3)


def _no_children(timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not multiprocessing.active_children():
            return True
        time.sleep(0.1)
    return False


def scattered_words_pdf(words: int, seed: int = 7) -> bytes:
    generator = random.Random(seed)
    runs = [("F1", 8, generator.uniform(20, 560), generator.uniform(20, 770), f"word{index}") for index in range(words)]
    return pdf_fixtures.text_pdf([runs])


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class PdfComplexityLimitTests(unittest.TestCase):
    def analyses(self, pdf: bytes):
        """Run extract_pdf and return the boxes_flow value each page was analysed with."""
        from pdfminer.layout import LTPage

        original = LTPage.analyze
        flows = []

        def recording(page, laparams):
            flows.append(laparams.boxes_flow)
            return original(page, laparams)

        with mock.patch.object(LTPage, "analyze", recording):
            result = local_document_server.extract_pdf(pdf)
        return result, flows

    def test_a_normal_page_gets_the_full_layout_analysis(self):
        (_, pages), flows = self.analyses(pdf_fixtures.article_pdf())

        self.assertEqual(len(pages), 2)
        self.assertEqual(flows, [0.5, 0.5])

    def test_a_page_with_many_scattered_lines_skips_the_quadratic_box_ordering(self):
        with mock.patch.object(local_document_server, "PDF_FULL_LAYOUT_MAX_BASELINES", 2):
            (_, pages), flows = self.analyses(pdf_fixtures.article_pdf())

        self.assertEqual(flows, [None, None])
        self.assertIn("Quarterly Energy Report", pages[0]["text"])

    def test_a_page_with_thousands_of_scattered_words_stays_fast(self):
        started = time.monotonic()
        model, pages = local_document_server.extract_pdf(scattered_words_pdf(3000))

        self.assertEqual(model, "pdfminer")
        self.assertIn("word0", pages[0]["text"])
        self.assertLess(time.monotonic() - started, 20, "full box ordering of this page takes 40 s or more")

    def test_a_page_above_the_character_cap_is_rejected_with_a_clear_message_without_ocr(self):
        with mock.patch.object(local_document_server, "PDF_MAX_PAGE_CHARACTERS", 10), \
                mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=False):
            with self.assertRaisesRegex(local_document_server.DocumentLimitError, "Page 1 has more than 10 text characters"):
                local_document_server.extract_pdf(pdf_fixtures.article_pdf())

    def test_a_page_above_the_character_cap_is_read_by_ocr_when_it_is_installed(self):
        calls = []

        def fake_ocr(image):
            calls.append(image)
            return "rapidocr", [{"x": 0, "y": 0, "width": 1, "height": 1, "text": "From OCR", "kind": "text"}]

        with mock.patch.object(local_document_server, "PDF_MAX_PAGE_CHARACTERS", 150), \
                mock.patch.object(local_document_server, "has_ocr_dependencies", return_value=True), \
                mock.patch.object(local_document_server, "ocr_image", side_effect=fake_ocr):
            model, pages = local_document_server.extract_pdf(pdf_fixtures.article_pdf())

        self.assertEqual(model, "pdfminer+rapidocr")
        self.assertEqual(len(calls), 1)  # Only page 1 (about 250 characters) is above the cap.
        self.assertEqual(pages[0]["text"], "From OCR")
        self.assertIn("Meters were read monthly", pages[1]["text"])


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class IsolatedExtractionTests(unittest.TestCase):
    def tearDown(self):
        self.assertTrue(_no_children(), "a worker process is still running")
        self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS)

    def test_returns_the_extraction_result_from_the_worker_process(self):
        model, pages = local_document_server.run_pdf_extraction(pdf_fixtures.article_pdf(), budget_seconds=120)

        self.assertEqual(model, "pdfminer")
        self.assertEqual(len(pages), 2)

    def test_stops_the_worker_when_the_time_budget_runs_out(self):
        started = time.monotonic()
        with self.assertRaisesRegex(local_document_server.ExtractionTimeout, "stopped after 1 seconds"):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=1, worker=_sleepy_worker)

        self.assertLess(time.monotonic() - started, 15)

    def test_stops_the_worker_when_the_client_disconnects(self):
        checks = []

        def abort_after_a_moment():
            checks.append(time.monotonic())
            return len(checks) > 3

        with self.assertRaises(local_document_server.ExtractionAborted):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=60, should_abort=abort_after_a_moment, worker=_sleepy_worker)

    def test_reports_a_document_limit_from_the_worker(self):
        with self.assertRaisesRegex(local_document_server.DocumentLimitError, "too much of something"):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=60, worker=_limit_worker)

    def test_reports_a_worker_that_dies_without_a_result(self):
        with self.assertRaisesRegex(local_document_server.ExtractionCrashed, "stopped unexpectedly"):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=60, worker=_crashing_worker)

    def test_refuses_new_work_when_the_slots_are_taken_and_does_not_leak_a_slot(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        with mock.patch.object(local_document_server, "_PDF_JOBS", slots), \
                mock.patch.object(local_document_server, "PDF_QUEUE_WAIT_SECONDS", 0.2):
            with self.assertRaises(local_document_server.ExtractionBusy):
                local_document_server.run_pdf_extraction(pdf_fixtures.article_pdf(), budget_seconds=60)
        slots.release()

    def test_a_garbage_pdf_reports_an_error_not_a_hang(self):
        with self.assertRaises(RuntimeError):
            local_document_server.run_pdf_extraction(b"not a pdf", budget_seconds=60)


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class DocumentServerLimitHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), local_document_server.DocumentHandler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body=b"%PDF-1.4"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/extract", data=body, headers={"Content-Type": "application/pdf"}, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_answers_504_with_a_plain_message_when_the_budget_is_used_up(self):
        with mock.patch.object(local_document_server, "_pdf_worker", _sleepy_worker), \
                mock.patch.object(local_document_server.DocumentHandler, "pdf_time_budget", 1.0):
            status, body = self.post()

        self.assertEqual(status, 504)
        self.assertIn("stopped after 1 seconds", body["error"])
        self.assertTrue(_no_children())

    def test_answers_422_for_a_decompression_bomb_with_a_plain_message(self):
        status, body = self.post(pdf_fixtures.decompression_bomb_pdf(local_document_server.PDF_MAX_STREAM_BYTES + 2 * 1024 * 1024))

        self.assertEqual(status, 422)
        self.assertIn("expands to more than 64 MB when decompressed", body["error"])
        self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS)

    def test_answers_422_with_the_limit_message(self):
        with mock.patch.object(local_document_server, "_pdf_worker", _limit_worker):
            status, body = self.post()

        self.assertEqual(status, 422)
        self.assertEqual(body["error"], "This document has too much of something.")

    def test_kills_the_worker_when_the_client_hangs_up(self):
        payload = b"%PDF-1.4"
        with mock.patch.object(local_document_server, "_pdf_worker", _sleepy_worker), \
                mock.patch.object(local_document_server.DocumentHandler, "pdf_time_budget", 100.0):
            connection = socket.create_connection(("127.0.0.1", self.port))
            connection.sendall(
                b"POST /extract HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/pdf\r\n"
                + f"Content-Length: {len(payload)}\r\n\r\n".encode() + payload
            )
            deadline = time.monotonic() + 15
            while not multiprocessing.active_children() and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertTrue(multiprocessing.active_children(), "the worker never started")
            connection.close()
            self.assertTrue(_no_children(15), "the worker kept running after the client left")
        self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS)


class _FailingContext:
    """A multiprocessing context whose Pipe(), Process() or Process.start() fails, to prove the job slot is returned."""

    def __init__(self, fail):
        self.fail = fail
        self.real = multiprocessing.get_context("spawn")

    def Pipe(self, *arguments, **keywords):
        if self.fail == "pipe":
            raise OSError("no pipe for you")
        return self.real.Pipe(*arguments, **keywords)

    def Process(self, *arguments, **keywords):
        if self.fail == "process":
            raise OSError("no process for you")
        process = self.real.Process(*arguments, **keywords)
        if self.fail == "start":
            def refuse():
                raise OSError("cannot start")
            process.start = refuse
        return process


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _force_kill(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _guarded_sleepy_worker(pdf_bytes, connection, budget_seconds=60, *_settings):
    """Starts the real guard, reports its pid, then sleeps for a long time."""
    local_document_server.prepare_worker(budget_seconds, 0)
    with open(os.environ["STUDENTLLM_TEST_PID_FILE"], "w", encoding="ascii") as handle:
        handle.write(str(os.getpid()))
    time.sleep(300)


def _short_deadline_worker(pdf_bytes, connection, *_settings):
    local_document_server.start_worker_guard(0.5)
    time.sleep(300)


def _hungry_worker(pdf_bytes, connection, budget_seconds, memory_limit_mb, *_settings):
    status = local_document_server.prepare_worker(budget_seconds, memory_limit_mb)
    try:
        hoard = bytearray(memory_limit_mb * 4 * 1024 * 1024)
        connection.send(("ok", (f"allocated {len(hoard)} bytes with the limit {status}", [])))
    except MemoryError:
        connection.send(("limit", local_document_server.memory_limit_message(memory_limit_mb)))


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class SlotAccountingTests(unittest.TestCase):
    def tearDown(self):
        self.assertTrue(_no_children())
        self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS)

    def test_an_early_failure_never_leaks_the_job_slot(self):
        for failure in ("pipe", "process", "start"):
            for _ in range(local_document_server.PDF_MAX_CONCURRENT_JOBS + 1):  # more attempts than there are slots
                with mock.patch.object(multiprocessing, "get_context", return_value=_FailingContext(failure)):
                    with self.assertRaises(OSError):
                        local_document_server.run_pdf_extraction(pdf_fixtures.article_pdf(), budget_seconds=30)
            self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS, failure)

        model, pages = local_document_server.run_pdf_extraction(pdf_fixtures.article_pdf(), budget_seconds=120)
        self.assertEqual(model, "pdfminer")
        self.assertEqual(len(pages), 2)


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class WorkerSelfDefenceTests(unittest.TestCase):
    def test_a_worker_exits_by_itself_when_the_sidecar_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = os.path.join(directory, "worker.pid")
            script = (
                "from scripts import local_document_server as s\n"
                "from tests.test_local_document_pdf import _guarded_sleepy_worker\n"
                "s.run_pdf_extraction(b'%PDF', budget_seconds=600, worker=_guarded_sleepy_worker)\n"
            )
            sidecar = subprocess.Popen(
                [sys.executable, "-c", script], cwd=REPOSITORY_ROOT, env={**os.environ, "STUDENTLLM_TEST_PID_FILE": pid_file},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            worker_pid = None
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline and worker_pid is None:
                    if os.path.exists(pid_file) and os.path.getsize(pid_file):
                        with open(pid_file, encoding="ascii") as handle:
                            worker_pid = int(handle.read())
                    time.sleep(0.2)
                self.assertIsNotNone(worker_pid, "the worker never reported its pid")
                self.assertTrue(_pid_alive(worker_pid))

                sidecar.kill()  # A hard kill, like Child::kill in the desktop supervisor: no cleanup code runs.
                sidecar.wait(30)

                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and _pid_alive(worker_pid):
                    time.sleep(0.2)
                self.assertFalse(_pid_alive(worker_pid), "the worker outlived its parent")
            finally:
                if sidecar.poll() is None:
                    sidecar.kill()
                if worker_pid is not None and _pid_alive(worker_pid):
                    _force_kill(worker_pid)

    def test_a_worker_ends_itself_at_its_own_deadline(self):
        context = multiprocessing.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(target=_short_deadline_worker, args=(b"", sender), daemon=True)
        process.start()
        sender.close()
        try:
            process.join(60)
            self.assertFalse(process.is_alive(), "the worker ignored its deadline")
            self.assertEqual(process.exitcode, local_document_server.WORKER_EXIT_DEADLINE)
        finally:
            if process.is_alive():
                process.kill()
            receiver.close()


@unittest.skipUnless(PDF_ENGINES, "pdfminer.six and pypdfium2 are not installed")
class MemoryAndStreamLimitTests(unittest.TestCase):
    def tearDown(self):
        self.assertTrue(_no_children())
        self.assertEqual(local_document_server._PDF_JOBS._value, local_document_server.PDF_MAX_CONCURRENT_JOBS)

    def test_a_decompression_bomb_is_refused_with_a_plain_message_and_frees_the_slot(self):
        bomb = pdf_fixtures.decompression_bomb_pdf(8 * 1024 * 1024)
        self.assertLess(len(bomb), 64 * 1024)  # a few kilobytes expand to eight megabytes

        with self.assertRaisesRegex(local_document_server.DocumentLimitError, "expands to more than 1 MB when decompressed"):
            local_document_server.run_pdf_extraction(bomb, budget_seconds=120, max_stream_bytes=1024 * 1024)

    def test_the_default_stream_cap_stops_a_bomb_before_it_is_decoded(self):
        bomb = pdf_fixtures.decompression_bomb_pdf(local_document_server.PDF_MAX_STREAM_BYTES + 4 * 1024 * 1024)

        with self.assertRaisesRegex(local_document_server.DocumentLimitError, "expands to more than 64 MB"):
            local_document_server.run_pdf_extraction(bomb, budget_seconds=120)

    def test_a_normal_pdf_is_not_affected_by_the_stream_cap(self):
        model, pages = local_document_server.run_pdf_extraction(pdf_fixtures.article_pdf(), budget_seconds=120, max_stream_bytes=1024 * 1024)

        self.assertEqual(model, "pdfminer")
        self.assertIn("Quarterly Energy Report", pages[0]["text"])

    @unittest.skipIf(sys.platform == "darwin", "macOS ignores the data-size limit, so the cap is only best effort there")
    def test_the_worker_memory_limit_turns_an_allocation_failure_into_a_plain_message(self):
        with self.assertRaisesRegex(local_document_server.DocumentLimitError, "needs more than the 200 MB of memory"):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=120, worker=_hungry_worker, memory_limit_mb=200)

    @unittest.skipIf(sys.platform == "darwin", "macOS ignores the data-size limit, so the cap is only best effort there")
    def test_a_real_bomb_that_passes_the_stream_cap_still_hits_the_memory_limit(self):
        bomb = pdf_fixtures.decompression_bomb_pdf(600 * 1024 * 1024)
        self.assertLess(len(bomb), 2 * 1024 * 1024)

        with self.assertRaises(local_document_server.DocumentLimitError) as caught:
            local_document_server.run_pdf_extraction(bomb, budget_seconds=120, memory_limit_mb=300, max_stream_bytes=2 * 1024**3)
        self.assertRegex(str(caught.exception), "memory")

    def test_a_memory_limit_of_zero_disables_the_cap(self):
        self.assertEqual(local_document_server.apply_worker_memory_limit(0), "disabled")

    def test_a_worker_that_dies_without_an_answer_is_reported_with_the_memory_hint(self):
        with self.assertRaisesRegex(local_document_server.ExtractionCrashed, "needs more memory than the local extractor allows \\(512 MB\\)"):
            local_document_server.run_pdf_extraction(b"%PDF", budget_seconds=60, worker=_crashing_worker, memory_limit_mb=512)


if __name__ == "__main__":
    unittest.main()
