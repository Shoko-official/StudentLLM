# Third-party notices

StudentLLM's own code is released under the [MIT License](LICENSE). It is built on open-source software that
keeps its own licences. This file lists what the repository and the desktop release depend on and the notices
those licences ask for. The complete, generated list is in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md),
the release workflow attaches the full licence texts to every release, and the audit behind this page is in
[docs/licensing.md](docs/licensing.md).

## What the desktop release contains

- **Rust crates** (Tauri v2 and plugins, `rusqlite` and about 440 more): permissive licences (MIT, Apache-2.0,
  Unicode-3.0, Zlib, ISC, BSD) except five MPL-2.0 crates used unmodified: `cssparser`, `cssparser-macros`,
  `dtoa-short`, `option-ext` and `selectors`. Their source is available from <https://crates.io/> under the exact
  versions in `src-tauri/Cargo.lock`. SQLite is compiled in through `rusqlite` and is in the public domain.
- **npm packages** in the web app: 146 production packages, all under MIT, ISC, BSD, Apache-2.0 or OFL-1.1
  (`@fontsource-variable/fraunces`).
- **Fonts**
  - Fraunces (variable): Copyright 2020 The Fraunces Project Authors
    (<https://github.com/undercasetype/Fraunces>), SIL Open Font License 1.1,
    <https://openfontlicense.org>.
  - KaTeX fonts (`KaTeX_*`): Copyright (c) 2009-2010 Design Science, Inc. and (c) 2014-2018 Khan Academy,
    SIL Open Font License 1.1, Reserved Font Name "KaTeX_Main". The fonts are bundled unmodified.
- **Icons**: [Lucide](https://lucide.dev/), ISC, Copyright (c) 2026 Lucide Icons and Contributors, and MIT for the
  icons derived from Feather, Copyright (c) 2013-present Cole Bemis
  (<https://github.com/lucide-icons/lucide/blob/main/LICENSE>).
- The application icon and favicon are StudentLLM's own artwork, MIT.

The release does not contain Python, the optional sidecars, OCR models or speech models.

## Optional sidecars the user installs

These are installed from the `requirements-*.txt` files or with `pip install faster-whisper`. They are not
redistributed by this project. See [docs/licensing.md](docs/licensing.md) for the full table and for the
obligations that would apply if a release ever bundles them.

| Component | Licence | Notice |
| --- | --- | --- |
| pdfminer.six | MIT | <https://github.com/pdfminer/pdfminer.six> |
| pypdfium2 and PDFium | Apache-2.0 or BSD-3-Clause; PDFium BSD-3-Clause and Apache-2.0 | <https://github.com/pypdfium2-team/pypdfium2>. Portions of this software are derived from FreeType (the FreeType Project License requires this credit) and other libraries listed in the wheel's `BUILD_LICENSES/` folder. |
| RapidOCR and its PP-OCR models | Apache-2.0 | <https://github.com/RapidAI/RapidOCR>. The ONNX models are converted from Baidu PaddleOCR models (<https://github.com/PaddlePaddle/PaddleOCR>, Apache-2.0). |
| ONNX Runtime | MIT | <https://github.com/microsoft/onnxruntime> |
| OpenCV (headless wheel) | Apache-2.0; the wheel ships FFmpeg under LGPL-2.1 | <https://github.com/opencv/opencv-python> |
| Shapely | BSD-3-Clause; the wheel ships GEOS under LGPL-2.1 | <https://github.com/shapely/shapely> |
| faster-whisper, CTranslate2 | MIT | <https://github.com/SYSTRAN/faster-whisper>, <https://github.com/OpenNMT/CTranslate2> |
| Whisper model weights | MIT | <https://github.com/openai/whisper> |
| PyAV (installed by faster-whisper) | BSD-3-Clause; the wheel bundles FFmpeg with x264 and x265, which are GPL | <https://github.com/PyAV-Org/PyAV>. Treat the wheel as GPL-covered if it is ever redistributed. |

## Models and datasets

No model weights or datasets are committed or bundled. The benchmark commands download public ones when a
developer runs them; their licences and the restricted ones (CRAG, FiQA, NFCorpus, OmniDocBench and DocVQA) are
listed in [docs/licensing.md](docs/licensing.md#models-and-datasets).

## Removed

Animated icons from [Lordicon](https://lordicon.com/) were bundled in earlier commits and have been removed
because their licence does not clearly allow shipping the files inside a product that is sold.
