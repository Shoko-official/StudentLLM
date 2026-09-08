import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmarks.run_mtrag_generation import build_messages, run


class MtragGenerationTests(unittest.TestCase):
    def test_build_messages_preserves_conversation_and_bounds_context(self):
        task = {
            "task_id": "task-1",
            "input": [
                {"speaker": "user", "text": "First question"},
                {"speaker": "agent", "text": "Previous answer"},
                {"speaker": "user", "text": "Latest question"},
            ],
            "contexts": [{"title": "Source", "text": "0123456789"}],
        }

        messages = build_messages(task, max_context_chars=4)

        self.assertEqual([message["role"] for message in messages], ["system", "user", "assistant", "user", "user"])
        self.assertIn("Latest question", messages[-2]["content"])
        self.assertIn("0123", messages[-1]["content"])
        self.assertNotIn("012345", messages[-1]["content"])

    @patch("benchmarks.run_mtrag_generation.generate_one", return_value=("answer", 12.5))
    def test_run_writes_official_prediction_records_and_checkpoint(self, _generate_one):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / "tasks.jsonl"
            output_path = root / "predictions.jsonl"
            checkpoint_path = root / "checkpoint.json"
            tasks = [
                {"task_id": "task-1", "input": [{"speaker": "user", "text": "Question"}], "contexts": [], "targets": [{"text": "Gold"}]},
                {"task_id": "task-2", "input": [{"speaker": "user", "text": "Question 2"}], "contexts": [], "targets": [{"text": "Gold 2"}]},
            ]
            input_path.write_text("".join(json.dumps(task) + "\n" for task in tasks), encoding="utf-8")

            receipt = run(input_path, output_path, checkpoint_path, "test-model", "http://localhost/v1", "key", 1)

            records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(receipt["tasks"], 2)
            self.assertEqual(receipt["generation_failures"], 0)
            self.assertEqual([record["predictions"][0]["text"] for record in records], ["answer", "answer"])
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(len(checkpoint["records"]), 2)


if __name__ == "__main__":
    unittest.main()
