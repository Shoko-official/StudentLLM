import tempfile
import unittest
from pathlib import Path

from benchmarks.run_mmlu_pro_full import (
    CATEGORY_ITEM_COUNTS,
    build_category_command,
    parse_categories,
    receipt_is_complete,
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


if __name__ == "__main__":
    unittest.main()
