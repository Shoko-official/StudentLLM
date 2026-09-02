import argparse
import tempfile
import unittest
from pathlib import Path

from benchmarks.run_pubtabnet_teds import (
    checkpoint_metadata,
    extract_table_markup,
    levenshtein_distance,
    load_checkpoint,
    save_checkpoint,
)


class PubTabNetTedsTests(unittest.TestCase):
    def test_extract_table_markup_removes_markdown_wrapper(self):
        self.assertEqual(extract_table_markup("```html\n<table><tr><td>A</td></tr></table>\n```"), "<table><tr><td>A</td></tr></table>")

    def test_extract_table_markup_rejects_non_table_output(self):
        self.assertEqual(extract_table_markup("I cannot reconstruct this table."), "")

    def test_levenshtein_distance_is_symmetric(self):
        self.assertEqual(levenshtein_distance("table", "tables"), levenshtein_distance("tables", "table"))

    def test_checkpoint_round_trip_is_atomic(self):
        arguments = argparse.Namespace(
            dataset="dataset",
            config=None,
            split="validation",
            limit=3,
            offset=0,
            model="model",
            base_url="https://example.test/v1",
            api_key_env="NVIDIA_API_KEY",
            expected_samples=3,
        )
        metadata = checkpoint_metadata(arguments)
        rows = [{"image_id": "1", "error": None}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            save_checkpoint(path, metadata, rows, 12.5)

            self.assertEqual(load_checkpoint(path, metadata), (rows, 12.5))
            self.assertFalse(path.with_name(".run.json.tmp").exists())

    def test_checkpoint_rejects_different_evaluation(self):
        arguments = argparse.Namespace(
            dataset="dataset",
            config=None,
            split="validation",
            limit=3,
            offset=0,
            model="model",
            base_url="https://example.test/v1",
            api_key_env="NVIDIA_API_KEY",
            expected_samples=3,
        )
        metadata = checkpoint_metadata(arguments)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            save_checkpoint(path, metadata, [], 0.0)
            mismatched = dict(metadata, split="test")

            with self.assertRaisesRegex(ValueError, "metadata"):
                load_checkpoint(path, mismatched)


if __name__ == "__main__":
    unittest.main()
