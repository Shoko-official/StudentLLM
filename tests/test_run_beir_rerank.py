import unittest

from benchmarks.run_beir_rerank import stable_rank


class BeirRerankTests(unittest.TestCase):
    def test_stable_rank_breaks_ties_by_document_id(self):
        self.assertEqual(stable_rank(["b", "a", "c"], [0.5, 0.5, 0.2], 3), [1, 0, 2])

    def test_stable_rank_limits_results(self):
        self.assertEqual(stable_rank(["a", "b", "c"], [0.1, 0.9, 0.8], 2), [1, 2])
