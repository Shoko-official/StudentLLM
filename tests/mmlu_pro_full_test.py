import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from benchmarks.run_mmlu_pro_full import (
    CATEGORY_ITEM_COUNTS,
    aggregate_chunk_receipts,
    build_category_command,
    build_chunk_ranges,
    latest_receipt_for_output,
    parse_categories,
    receipt_is_complete,
    load_json,
    main,
    summary_scope,
)


class MMLUProFullRunnerTest(unittest.TestCase):
    def test_category_inventory_matches_observed_public_group(self):
        self.assertEqual(len(CATEGORY_ITEM_COUNTS), 14)
        self.assertEqual(sum(CATEGORY_ITEM_COUNTS.values()), 12032)

    def test_category_parser_rejects_unknown_categories(self):
        with self.assertRaises(ValueError):
            parse_categories("biology,not-a-category")

    def test_command_uses_supported_reasoning_effort_and_category_task(self):
        with tempfile.TemporaryDirectory() as directory:
            command = build_category_command(
                "python",
                "benchmarks/run_mmlu_pro.py",
                "biology",
                Path(directory) / "biology.json",
                "openai/gpt-oss-20b",
                "https://example.test/v1/chat/completions",
                4,
                3,
                0,
                512,
                "low",
                42,
            )
        command_text = " ".join(command)
        self.assertIn("mmlu_pro_biology", command_text)
        self.assertIn("reasoning_effort=low", command_text)
        self.assertNotIn("reasoning_effort=none", command_text)

    def test_receipt_requires_scored_task_metric(self):
        self.assertTrue(
            receipt_is_complete(
                {"results": {"mmlu_pro_biology": {"exact_match,flexible-extract": 0.5}}},
                "biology",
            )
        )
        self.assertFalse(receipt_is_complete({"results": {}}, "biology"))

    def test_chunk_ranges_cover_category_without_overlap(self):
        self.assertEqual(build_chunk_ranges(7, 3), [(0, 3), (3, 6), (6, 7)])

    def test_sample_selection_is_encoded_for_chunked_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            command = build_category_command(
                "python",
                "benchmarks/run_mmlu_pro.py",
                "biology",
                Path(directory) / "biology.json",
                "openai/gpt-oss-20b",
                "https://example.test/v1/chat/completions",
                1,
                3,
                0,
                512,
                "low",
                42,
                [3, 4, 5],
            )
        command_text = " ".join(command)
        self.assertIn('--samples {"mmlu_pro_biology":[3,4,5]}', command_text)

    def test_chunk_receipt_finds_harness_timestamped_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            output_path = output_dir / "mmlu_pro_psychology_chunk_00000_00050.json"
            receipt_path = output_dir / "mmlu_pro_psychology_chunk_00000_00050_2026-08-31T08-14-06.json"
            receipt_path.write_text('{"results": {}}', encoding="utf-8")
            self.assertEqual(latest_receipt_for_output(output_dir, output_path), receipt_path)

    def test_partial_category_summary_is_not_called_complete_group(self):
        self.assertEqual(summary_scope(["biology"]), "selected public category set")
        self.assertEqual(summary_scope(list(CATEGORY_ITEM_COUNTS)), "complete public test group")

    def test_chunk_aggregate_is_weighted_by_scored_items(self):
        chunks = [
            ((0, 2), Path("first.json"), {"results": {"mmlu_pro_biology": {"sample_len": 2, "exact_match,custom-extract": 1.0}}}),
            ((2, 3), Path("second.json"), {"results": {"mmlu_pro_biology": {"sample_len": 1, "exact_match,custom-extract": 0.0}}}),
        ]
        aggregate = aggregate_chunk_receipts("biology", chunks)
        self.assertEqual(aggregate["results"]["mmlu_pro_biology"]["sample_len"], 3)
        self.assertAlmostEqual(aggregate["results"]["mmlu_pro_biology"]["exact_match,custom-extract"], 2 / 3)

    def test_interrupted_chunk_is_persisted_as_terminal_manifest_state(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            with patch("benchmarks.run_mmlu_pro_full.subprocess.run", side_effect=KeyboardInterrupt):
                result = main(
                    [
                        "--categories",
                        "biology",
                        "--chunk-size",
                        "3",
                        "--output-dir",
                        str(output_dir),
                        "--benchmark-script",
                        "benchmark.py",
                    ]
                )

            manifest = load_json(output_dir / "mmlu_pro_full_manifest.json")
            self.assertEqual(result, 130)
            self.assertIsNotNone(manifest)
            self.assertEqual(manifest["categories"]["biology"]["status"], "interrupted")
            self.assertEqual(manifest["categories"]["biology"]["chunks"][0]["status"], "interrupted")


if __name__ == "__main__":
    unittest.main()
