import unittest

from benchmarks.run_covost2_st import prepare_examples


class Covost2SpeechTranslationTests(unittest.TestCase):
    def test_limit_uses_only_the_requested_public_examples(self):
        self.assertEqual(list(prepare_examples(iter([1, 2, 3]), 2)), [1, 2])

    def test_unlimited_stream_is_not_materialised(self):
        values = iter(["a", "b"])
        self.assertIs(prepare_examples(values, None), values)


if __name__ == "__main__":
    unittest.main()
