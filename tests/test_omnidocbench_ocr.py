import unittest

from benchmarks.run_omnidocbench_ocr import (
    edit_similarity,
    ground_truth_spans,
    oracle_span_predictions,
)


class OmniDocBenchOcrTests(unittest.TestCase):
    def test_edit_similarity_matches_exact_text(self):
        self.assertEqual(edit_similarity("A  table", "A table"), 1.0)

    def test_ground_truth_uses_ordered_text_spans(self):
        data = {
            "layout_dets": [
                {"anno_id": None, "order": 2, "ignore": False, "line_with_spans": [], "text": "second", "poly": [0, 20, 20, 20]},
                {"anno_id": 1, "order": 1, "ignore": False, "line_with_spans": [{"text": "first", "poly": [0, 0, 20, 0]}]},
            ]
        }
        self.assertEqual([span.text for span in ground_truth_spans(data)], ["first", "second"])

    def test_oracle_assignment_uses_span_centers(self):
        spans = ground_truth_spans(
            {"layout_dets": [{"order": 1, "ignore": False, "line_with_spans": [{"text": "answer", "poly": [0, 0, 100, 0, 100, 20, 0, 20]}]}]}
        )

        class Detection:
            def __init__(self, text, polygon, score=1.0):
                self.text, self.polygon, self.score = text, polygon, score

        self.assertEqual(oracle_span_predictions(spans, [Detection("answer", ((10, 5), (50, 5), (50, 15), (10, 15))) ]), ["answer"])


if __name__ == "__main__":
    unittest.main()
