import unittest

from benchmarks.run_asr_hf import prepare_examples


class FakeDataset:
    def __init__(self, values):
        self.values = values

    def __len__(self):
        return len(self.values)

    def __iter__(self):
        return iter(self.values)

    def select(self, indices):
        return FakeDataset([self.values[index] for index in indices])


class RunAsrHfTests(unittest.TestCase):
    def test_materialized_dataset_selects_first_limit(self):
        examples, expected = prepare_examples(FakeDataset(["a", "b", "c"]), 2, streaming=False)

        self.assertEqual(list(examples), ["a", "b"])
        self.assertEqual(expected, 2)

    def test_streaming_dataset_is_limited_without_select(self):
        examples, expected = prepare_examples(iter(["a", "b", "c"]), 2, streaming=True)

        self.assertEqual(list(examples), ["a", "b"])
        self.assertEqual(expected, 2)

    def test_streaming_full_split_keeps_unknown_count(self):
        examples, expected = prepare_examples(iter(["a", "b"]), None, streaming=True)

        self.assertEqual(list(examples), ["a", "b"])
        self.assertIsNone(expected)


if __name__ == "__main__":
    unittest.main()
