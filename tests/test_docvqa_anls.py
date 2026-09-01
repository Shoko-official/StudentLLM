import unittest

from benchmarks.run_docvqa_anls import anls, levenshtein_similarity


class DocVqaAnlsTests(unittest.TestCase):
    def test_identical_answer_scores_one(self):
        self.assertEqual(anls("New York", ["New York"]), 1.0)

    def test_best_reference_is_used(self):
        self.assertEqual(anls("12", ["twelve", "12"]), 1.0)

    def test_low_similarity_is_thresholded(self):
        self.assertEqual(anls("abc", ["xyz"]), 0.0)

    def test_similarity_is_bounded(self):
        value = levenshtein_similarity("answer", "anser")
        self.assertGreater(value, 0.8)
        self.assertLess(value, 1.0)


if __name__ == "__main__":
    unittest.main()
