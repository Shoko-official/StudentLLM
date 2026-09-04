import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from benchmarks.run_mtrag_retrieval import load_collection, reciprocal_rank_fusion


class MtragRetrievalTests(unittest.TestCase):
    def test_rrf_is_deterministic_and_rewards_agreement(self):
        ranking = reciprocal_rank_fusion([["a", "b", "c"], ["b", "a", "d"]], limit=4, rrf_k=60)
        self.assertEqual([document_id for document_id, _ in ranking], ["a", "b", "c", "d"])
        self.assertGreater(ranking[0][1], ranking[2][1])

    def test_load_collection_reads_official_layout(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            corpus_directory = root / "corpora" / "passage_level"
            query_directory = root / "mtrag-human" / "retrieval_tasks" / "clapnq" / "qrels"
            corpus_directory.mkdir(parents=True)
            query_directory.mkdir(parents=True)
            with zipfile.ZipFile(corpus_directory / "clapnq.jsonl.zip", "w") as archive:
                archive.writestr("clapnq.jsonl", json.dumps({"_id": "doc-1", "title": "Title", "text": "Body"}) + "\n")
            (query_directory.parent / "clapnq_rewrite.jsonl").write_text(json.dumps({"_id": "q-1", "text": "query"}) + "\n", encoding="utf-8")
            (query_directory / "dev.tsv").write_text("query-id\tcorpus-id\tscore\nq-1\tdoc-1\t1\n", encoding="utf-8")

            documents, queries, qrels = load_collection(root, "clapnq", "rewrite")

            self.assertEqual(documents, [("doc-1", "Title Body")])
            self.assertEqual(queries[0]["_id"], "q-1")
            self.assertEqual(qrels, {"q-1": {"doc-1": 1}})


if __name__ == "__main__":
    unittest.main()
