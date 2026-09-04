import unittest

from benchmarks.run_crag import normalize, parse_judge


class CragTests(unittest.TestCase):
    def test_normalize_handles_punctuation_and_whitespace(self):
        self.assertEqual(normalize(" The, Answer! "), "the answer")

    def test_parse_judge_accepts_json_and_rejects_unknown_scores(self):
        self.assertEqual(parse_judge('{"score": 1, "explanation": "correct"}'), 1)
        self.assertEqual(parse_judge('{"score": 2}'), -1)
        self.assertEqual(parse_judge("not json"), -1)


if __name__ == "__main__":
    unittest.main()
