import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "benchmarks" / "humaneval_code_only" / "utils.py"
SPEC = importlib.util.spec_from_file_location("studentllm_humaneval_code_only", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None


class HumanEvalCodeOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            SPEC.loader.exec_module(MODULE)
        except ModuleNotFoundError as error:
            raise unittest.SkipTest(f"HumanEval scorer dependencies are unavailable: {error}") from error

    def test_extracts_fenced_python_after_explanation(self):
        response = "Explanation first.\n```python\ndef add(a, b):\n    return a + b\n```"
        self.assertEqual(MODULE.extract_code(response, "add"), "def add(a, b):\n    return a + b")

    def test_extracts_unfenced_entrypoint_without_prose(self):
        response = "Here is the implementation:\n\ndef add(a, b):\n    return a + b"
        self.assertEqual(MODULE.extract_code(response, "add"), "def add(a, b):\n    return a + b")

    def test_builds_official_candidate_with_original_prompt(self):
        docs = [{"prompt": "def add(a, b):\n    ", "entry_point": "add"}]
        result = MODULE.build_predictions_code_only([["return a + b"]], docs)
        self.assertEqual(result, [["def add(a, b):\n    return a + b"]])


if __name__ == "__main__":
    unittest.main()
