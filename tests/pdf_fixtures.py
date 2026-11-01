"""Build tiny synthetic PDFs for the document sidecar tests without any PDF library.

Everything here is generated from code, so the fixtures contain no private or third-party
content and no font programs. Pages use the standard Helvetica and Courier base fonts, which
PDF viewers supply themselves, and image-only pages use a generated raster.
"""

from __future__ import annotations

import zlib

PAGE_WIDTH = 612
PAGE_HEIGHT = 792

# (font resource, size, x, y from the bottom of the page, text)
TextRun = tuple[str, float, float, float, str]


def _escape(text: str) -> bytes:
    data = text.encode("cp1252")
    return data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


class _PdfWriter:
    def __init__(self) -> None:
        self.objects: list[bytes] = []

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects)

    def reserve(self) -> int:
        self.objects.append(b"")
        return len(self.objects)

    def set(self, object_id: int, body: bytes) -> None:
        self.objects[object_id - 1] = body

    def stream(self, dictionary: bytes, data: bytes) -> int:
        return self.add(b"<< " + dictionary + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream")

    def render(self, root: int) -> bytes:
        output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for index, body in enumerate(self.objects, start=1):
            offsets.append(len(output))
            output += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(output)
        output += f"xref\n0 {len(self.objects) + 1}\n".encode()
        output += b"0000000000 65535 f \n"
        for offset in offsets:
            output += f"{offset:010d} 00000 n \n".encode()
        output += f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(output)


_BASE_FONTS = {
    "F1": b"Helvetica",
    "F2": b"Helvetica-Bold",
    "F3": b"Courier",
}


def _page_tree(writer: _PdfWriter, contents: list[int], resources: bytes) -> int:
    pages_id = writer.reserve()
    page_ids = [
        writer.add(
            b"<< /Type /Page /Parent " + str(pages_id).encode() + b" 0 R /MediaBox [0 0 "
            + f"{PAGE_WIDTH} {PAGE_HEIGHT}".encode() + b"] /Resources " + resources
            + b" /Contents " + str(content).encode() + b" 0 R >>"
        )
        for content in contents
    ]
    kids = b" ".join(str(page_id).encode() + b" 0 R" for page_id in page_ids)
    writer.set(pages_id, b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(len(page_ids)).encode() + b" >>")
    return writer.add(b"<< /Type /Catalog /Pages " + str(pages_id).encode() + b" 0 R >>")


def text_pdf(pages: list[list[TextRun]], *, font_encoding: bytes | None = None) -> bytes:
    """A PDF whose pages carry a real text layer made of the given runs.

    `font_encoding` optionally replaces the font `/Encoding` entry, which lets a test build a
    text layer whose character codes cannot be mapped back to Unicode.
    """
    writer = _PdfWriter()
    font_ids = {}
    for resource, base in _BASE_FONTS.items():
        encoding = font_encoding if font_encoding is not None else b"/WinAnsiEncoding"
        font_ids[resource] = writer.add(
            b"<< /Type /Font /Subtype /Type1 /BaseFont /" + base + b" /Encoding " + encoding + b" >>"
        )
    resources = b"<< /Font << " + b" ".join(
        f"/{resource} {font_id} 0 R".encode() for resource, font_id in font_ids.items()
    ) + b" >> >>"
    contents = []
    for runs in pages:
        body = bytearray()
        for font, size, x, y, text in runs:
            body += f"BT /{font} {size} Tf {x} {y} Td (".encode() + _escape(text) + b") Tj ET\n"
        contents.append(writer.stream(b"", bytes(body)))
    return writer.render(_page_tree(writer, contents, resources))


def image_only_pdf(pixels: bytes, width: int, height: int, pages: int = 1) -> bytes:
    """A PDF whose pages are one full-page 8-bit grayscale image and no text layer."""
    if len(pixels) != width * height:
        raise ValueError("pixels must hold width * height gray bytes")
    writer = _PdfWriter()
    image_id = writer.stream(
        f"/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray "
        "/BitsPerComponent 8 /Filter /FlateDecode".encode(),
        zlib.compress(pixels),
    )
    resources = b"<< /XObject << /Im0 " + str(image_id).encode() + b" 0 R >> >>"
    draw = f"q {PAGE_WIDTH} 0 0 {PAGE_HEIGHT} 0 0 cm /Im0 Do Q".encode()
    contents = [writer.stream(b"", draw) for _ in range(pages)]
    return writer.render(_page_tree(writer, contents, resources))


def mixed_image_pdf(pixels: bytes, width: int, height: int, *, image_box=(50, 150, 510, 550), native_runs=None,
                    crop_box=None, rotation=0) -> bytes:
    """Native text plus an independently positioned grayscale image, generated without external data."""
    if len(pixels) != width * height:
        raise ValueError("pixels must hold width * height gray bytes")
    writer = _PdfWriter()
    font_id = writer.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    image_id = writer.stream(
        f"/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray "
        "/BitsPerComponent 8 /Filter /FlateDecode".encode(), zlib.compress(pixels),
    )
    resources = f"<< /Font << /F1 {font_id} 0 R >> /XObject << /Im0 {image_id} 0 R >> >>".encode()
    x, y, w, h = image_box
    body = bytearray(f"q {w} 0 0 {h} {x} {y} cm /Im0 Do Q\n".encode())
    for text, tx, ty in native_runs if native_runs is not None else [("Native caption", 72, 740)]:
        body += f"BT /F1 12 Tf {tx} {ty} Td (".encode() + _escape(text) + b") Tj ET\n"
    root = _page_tree(writer, [writer.stream(b"", bytes(body))], resources)
    page_options = f" /Rotate {rotation}".encode()
    if crop_box is not None:
        page_options += (" /CropBox [" + " ".join(str(value) for value in crop_box) + "]").encode()
    writer.objects = [obj.replace(b"/MediaBox [0 0 612 792]", b"/MediaBox [0 0 612 792]" + page_options)
                      for obj in writer.objects]
    return writer.render(root)


def decompression_bomb_pdf(decoded_size: int) -> bytes:
    """A valid one-page PDF whose Flate content stream is blank space that decodes to `decoded_size` bytes.

    The compressed stream is about a thousandth of that size, so the file stays small. It is a stand-in for a
    malicious file and holds nothing but whitespace.
    """
    compressor = zlib.compressobj(9)
    block = b" " * (1 << 20)
    chunks = []
    remaining = decoded_size
    while remaining > 0:
        part = min(remaining, len(block))
        chunks.append(compressor.compress(block[:part]))
        remaining -= part
    chunks.append(compressor.flush())
    writer = _PdfWriter()
    content = writer.stream(b"/Filter /FlateDecode", b"".join(chunks))
    return writer.render(_page_tree(writer, [content], b"<< >>"))


def article_pdf() -> bytes:
    """Two pages with a heading, body paragraphs, a bullet list and a monospaced snippet."""
    first: list[TextRun] = [
        ("F2", 22, 72, 720, "Quarterly Energy Report"),
        ("F1", 11, 72, 690, "This synthetic report summarises electricity use across three campuses."),
        ("F1", 11, 72, 676, "All figures are invented for the purpose of testing text extraction."),
        ("F2", 14, 72, 640, "Highlights"),
        ("F1", 11, 90, 618, "- Consumption fell by four percent."),
        ("F1", 11, 90, 602, "- Solar output doubled in July."),
        ("F3", 10, 72, 560, "total = north + south + east"),
    ]
    second: list[TextRun] = [
        ("F2", 14, 72, 720, "Method"),
        ("F1", 11, 72, 698, "Meters were read monthly and averaged per building."),
        ("F1", 11, 72, 684, "Outliers beyond three deviations were checked by hand."),
    ]
    return text_pdf([first, second])


def gray_text_bitmap(text: str, width: int = PAGE_WIDTH * 2, height: int = PAGE_HEIGHT * 2) -> bytes:
    """Gray pixels with `text` drawn large, for scanned-page tests. Needs Pillow."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=56)
    except TypeError:  # Pillow without sized default fonts
        font = ImageFont.load_default()
    y = 160
    for line in text.split("\n"):
        draw.text((120, y), line, fill=0, font=font)
        y += 110
    return image.tobytes()
