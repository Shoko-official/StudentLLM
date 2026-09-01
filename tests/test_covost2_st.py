import unittest

from benchmarks.run_covost2_st import prepare_examples, score_comet


class Covost2SpeechTranslationTests(unittest.TestCase):
    def test_limit_uses_only_the_requested_public_examples(self):
        self.assertEqual(list(prepare_examples(iter([1, 2, 3]), 2)), [1, 2])

    def test_unlimited_stream_is_not_materialised(self):
        values = iter(["a", "b"])
        self.assertIs(prepare_examples(values, None), values)

    def test_comet_averages_per_example_scores_from_a_fake_predictor(self):
        class FakePredictions:
            scores = [0.2, 0.8]

        def fake_predictor(*args, **kwargs):
            return FakePredictions()

        # Keep the public helper's aggregation contract testable without downloading a checkpoint.
        self.assertAlmostEqual(
            score_comet(
                ["bonjour", "au revoir"],
                ["hello", "goodbye"],
                ["hello", "goodbye"],
                "unused",
                "cpu",
                2,
                predictor=fake_predictor,
            ),
            0.5,
        )


if __name__ == "__main__":
    unittest.main()
