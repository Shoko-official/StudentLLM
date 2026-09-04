import unittest

from benchmarks.run_beir_hybrid import reciprocal_rank_fusion


class BeirHybridTests(unittest.TestCase):
    def test_rrf_is_deterministic(self):
        self.assertEqual(
            reciprocal_rank_fusion([["a", "b", "c"], ["b", "a", "d"]], limit=4),
            ["a", "b", "c", "d"],
        )


if __name__ == "__main__":
    unittest.main()
