import unittest

from scripts.local_document_server import formula_aware_pdf_blocks, group_formula_blocks, is_block_covered_by_formula_crop, is_formula_block, is_formula_group


class LocalDocumentServerTests(unittest.TestCase):
    def test_emits_semantic_text_for_math_regions_instead_of_formula_images(self):
        class Page:
            rect = type("Rect", (), {"width": 600.0, "height": 800.0})()

            def get_text(self, _mode):
                return {"blocks": [
                    {"type": 0, "bbox": (80, 100, 150, 112), "lines": [{"spans": [{"text": "Divergence", "font": "F37"}]}]},
                    {"type": 0, "bbox": (150, 120, 260, 132), "lines": [{"spans": [{"text": "∂Fₓ/∂x + ∂Fᵧ/∂y", "font": "CMMI10"}]}]},
                ]}

        blocks = formula_aware_pdf_blocks(Page())

        self.assertTrue(any("∂Fₓ" in str(block["text"]) for block in blocks))
        self.assertTrue(all("imageData" not in block for block in blocks))

    def test_keeps_prose_with_an_inline_variable_as_text(self):
        block = {
            "lines": [{"spans": [
                {"text": "Definition. For ", "font": "F37"},
                {"text": "f(x)", "font": "CMMI10"},
                {"text": ", derive with respect to one variable.", "font": "F37"},
            ]}],
        }

        self.assertFalse(is_formula_block(block))

    def test_groups_adjacent_math_fragments_into_one_faithful_crop(self):
        blocks = [
            {"bbox": (49.0, 298.0, 89.0, 308.0), "math": False},
            {"bbox": (147.0, 312.0, 158.0, 322.0), "math": True},
            {"bbox": (147.0, 326.0, 207.0, 336.0), "math": True},
            {"bbox": (221.0, 312.0, 232.0, 322.0), "math": True},
            {"bbox": (221.0, 326.0, 281.0, 336.0), "math": True},
            {"bbox": (49.0, 343.0, 374.0, 366.0), "math": False},
        ]

        self.assertEqual(group_formula_blocks(blocks), [[1, 2, 3, 4]])

    def test_keeps_math_regions_separated_by_a_section_gap(self):
        blocks = [
            {"bbox": (265.0, 375.0, 330.0, 400.0), "math": True},
            {"bbox": (233.0, 408.0, 284.0, 437.0), "math": True},
        ]

        self.assertEqual(group_formula_blocks(blocks), [[0], [1]])

    def test_removes_text_already_present_inside_a_formula_crop(self):
        crop = (96.0, 461.0, 499.0, 552.0)

        self.assertTrue(is_block_covered_by_formula_crop({"bbox": (283.0, 468.0, 495.0, 481.0)}, crop))
        self.assertFalse(is_block_covered_by_formula_crop({"bbox": (49.0, 448.0, 374.0, 461.0)}, crop))

    def test_keeps_a_dense_math_table_as_a_faithful_crop(self):
        table_rows = [
            {"lines": [{"spans": [{"text": "m" * 10, "font": "CMMI10"}, {"text": "label" * 5, "font": "F37"}]}]},
            {"lines": [{"spans": [{"text": "m" * 10, "font": "CMMI10"}, {"text": "label" * 5, "font": "F37"}]}]},
            {"lines": [{"spans": [{"text": "m" * 10, "font": "CMMI10"}, {"text": "label" * 5, "font": "F37"}]}]},
        ]

        self.assertTrue(is_formula_group(table_rows))


if __name__ == "__main__":
    unittest.main()
