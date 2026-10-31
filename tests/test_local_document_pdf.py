"""PDF extraction through the real pdfminer.six and pypdfium2 engines on generated fixtures.

These tests need `pip install -r requirements-local-documents.txt`; they skip when the PDF
libraries are missing so the plain benchmark checks keep running without them.
"""

import json
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
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

        with self.assertRaisesRegex(ValueError, "too many pages"):
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
                blocks = [{"type": 0, "bbox": (72, 80, 200, 92), "lines": [{"spans": [{"text": "Montrr qu ", "font": "F1"}]}]}]
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


if __name__ == "__main__":
    unittest.main()
