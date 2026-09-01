import argparse
import tempfile
import unittest
from pathlib import Path

from benchmarks.run_asr_hf import checkpoint_metadata, load_checkpoint, prepare_examples, save_checkpoint


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

    def test_resume_skips_processed_examples(self):
        examples, expected = prepare_examples(FakeDataset(["a", "b", "c"]), 3, streaming=False, skip=2)

        self.assertEqual(list(examples), ["c"])
        self.assertEqual(expected, 3)

    def test_checkpoint_round_trip_is_atomic(self):
        arguments = argparse.Namespace(
            dataset="dataset",
            config="config",
            split="test",
            reference_field="transcript",
            language="en",
            model="small",
            streaming=True,
            device="cuda",
            compute_type="float16",
            limit=None,
        )
        metadata = checkpoint_metadata(arguments)
        state = {"processed_examples": 100, "audio_seconds": 12.5}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            save_checkpoint(path, metadata, state)

            self.assertEqual(load_checkpoint(path, metadata), state)
            self.assertFalse(path.with_name(".run.json.tmp").exists())

    def test_checkpoint_rejects_different_evaluation(self):
        arguments = argparse.Namespace(
            dataset="dataset",
            config="config",
            split="test",
            reference_field="transcript",
            language="en",
            model="small",
            streaming=False,
            device="cpu",
            compute_type="int8",
            limit=10,
        )
        metadata = checkpoint_metadata(arguments)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            save_checkpoint(path, metadata, {"processed_examples": 1})
            mismatched = dict(metadata, split="validation")

            with self.assertRaisesRegex(ValueError, "metadata"):
                load_checkpoint(path, mismatched)


if __name__ == "__main__":
    unittest.main()
