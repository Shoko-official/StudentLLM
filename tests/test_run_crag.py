import bz2
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.run_crag import load_checkpoint, normalize, parse_judge, run


class CragTests(unittest.TestCase):
    def test_normalize_handles_punctuation_and_whitespace(self):
        self.assertEqual(normalize(" The, Answer! "), "the answer")

    def test_parse_judge_accepts_json_and_rejects_unknown_scores(self):
        self.assertEqual(parse_judge('{"score": 1, "explanation": "correct"}'), 1)
        self.assertEqual(parse_judge('{"score": 2}'), -1)
        self.assertEqual(parse_judge("not json"), -1)

    @patch("benchmarks.run_crag.judge_one", return_value=1)
    @patch("benchmarks.run_crag.generate_one", return_value="answer")
    def test_run_resumes_generation_and_judging_from_checkpoint(self, generate_one, judge_one):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset_path = root / "crag.jsonl.bz2"
            with bz2.open(dataset_path, "wt", encoding="utf-8") as handle:
                handle.write(json.dumps({"interaction_id": "one", "split": 0, "query": "Question", "domain": "open", "question_type": "simple", "answer": "answer", "search_results": []}) + "\n")
            checkpoint_path = root / "checkpoint.json"
            output_path = root / "receipt.json"

            first = run(dataset_path, 0, None, "model", "http://example.test/v1", "key", 1, 100, 16, "judge", output_path, checkpoint_path)
            self.assertEqual(first["judge"]["score"], 1.0)
            self.assertEqual(generate_one.call_count, 1)
            self.assertEqual(judge_one.call_count, 1)

            second = run(dataset_path, 0, None, "model", "http://example.test/v1", "key", 1, 100, 16, "judge", output_path, checkpoint_path)
            self.assertEqual(second["judge"]["score"], 1.0)
            self.assertEqual(generate_one.call_count, 1)
            self.assertEqual(judge_one.call_count, 1)

    def test_checkpoint_rejects_different_run_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            path.write_text(json.dumps({"metadata": {"split": 0}, "records": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "metadata"):
                load_checkpoint(path, {"split": 1})

    def test_run_rejects_output_checkpoint_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "same.json"
            with self.assertRaisesRegex(ValueError, "different files"):
                run(Path("dataset.jsonl.bz2"), 0, None, "model", "url", "key", 1, 100, 16, None, path, path)


if __name__ == "__main__":
    unittest.main()
