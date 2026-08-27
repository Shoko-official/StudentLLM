"""Run a full public BEIR lexical retrieval baseline.

The corpus, queries, and test qrels are loaded from the public BeIR datasets on
the Hugging Face Hub. This script evaluates the complete test split with a
small, deterministic BM25 implementation and writes an optional JSON receipt.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


TOKEN_PATTERN = re.compile(r"[^\w]+", re.UNICODE)
DATASETS = {
    "scifact": {"dataset": "BeIR/scifact", "qrels": "BeIR/scifact-qrels", "label": "BEIR SciFact"},
    "nfcorpus": {"dataset": "BeIR/nfcorpus", "qrels": "BeIR/nfcorpus-qrels", "label": "BEIR NFCorpus"},
    "arguana": {"dataset": "BeIR/arguana", "qrels": "BeIR/arguana-qrels", "label": "BEIR ArguAna"},
    "fiqa": {"dataset": "BeIR/fiqa", "qrels": "BeIR/fiqa-qrels", "label": "BEIR FiQA"},
    "scidocs": {"dataset": "BeIR/scidocs", "qrels": "BeIR/scidocs-qrels", "label": "BEIR SCIDOCS"},
    "trec-covid": {"dataset": "BeIR/trec-covid", "qrels": "BeIR/trec-covid-qrels", "label": "BEIR TREC-COVID"},
}


def tokenize(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return [token for token in TOKEN_PATTERN.split(normalized.lower()) if len(token) > 1]


class BM25:
    def __init__(self, documents: list[tuple[str, str]], k1: float = 1.2, b: float = 0.75):
        self.document_ids = [document_id for document_id, _ in documents]
        self.tokens = [tokenize(text) for _, text in documents]
        self.term_frequencies = [Counter(tokens) for tokens in self.tokens]
        self.k1 = k1
        self.b = b
        self.average_length = sum(len(tokens) for tokens in self.tokens) / max(len(self.tokens), 1)
        self.inverted_index: dict[str, list[int]] = defaultdict(list)
        self.document_frequency: Counter[str] = Counter()
        for index, tokens in enumerate(self.tokens):
            for term in set(tokens):
                self.inverted_index[term].append(index)
                self.document_frequency[term] += 1

    def search(self, query: str, limit: int) -> list[str]:
        query_terms = set(tokenize(query))
        scores: Counter[int] = Counter()
        document_count = len(self.tokens)
        for term in query_terms:
            frequency = self.document_frequency.get(term, 0)
            if not frequency:
                continue
            inverse_document_frequency = math.log(1 + (document_count - frequency + 0.5) / (frequency + 0.5))
            for index in self.inverted_index[term]:
                term_frequency = self.term_frequencies[index][term]
                length_normalization = 1 - self.b + self.b * (len(self.tokens[index]) / max(self.average_length, 1))
                scores[index] += inverse_document_frequency * ((term_frequency * (self.k1 + 1)) / (term_frequency + self.k1 * length_normalization))
        ranked = sorted(scores, key=lambda index: (-scores[index], self.document_ids[index]))
        return [self.document_ids[index] for index in ranked[:limit]]


def ndcg_at_k(retrieved: list[str], relevant: dict[str, int], k: int) -> float:
    ranked = retrieved[:k]
    dcg = sum((2 ** relevant[document_id] - 1) / math.log2(rank + 2) for rank, document_id in enumerate(ranked) if document_id in relevant)
    ideal = sorted(relevant.values(), reverse=True)[:k]
    idcg = sum((2 ** score - 1) / math.log2(rank + 2) for rank, score in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def recall_at_k(retrieved: list[str], relevant: dict[str, int], k: int) -> float:
    if not relevant:
        return 0.0
    return len(set(retrieved[:k]) & relevant.keys()) / len(relevant)


def reciprocal_rank_at_k(retrieved: list[str], relevant: dict[str, int], k: int) -> float:
    for rank, document_id in enumerate(retrieved[:k], start=1):
        if document_id in relevant:
            return 1 / rank
    return 0.0


def run(dataset_name: str, output_path: Path | None) -> dict[str, object]:
    from datasets import load_dataset

    dataset_info = DATASETS[dataset_name]
    started_at = time.perf_counter()
    corpus = load_dataset(dataset_info["dataset"], "corpus", split="corpus")
    queries = load_dataset(dataset_info["dataset"], "queries", split="queries")
    qrels = load_dataset(dataset_info["qrels"], "default", split="test")
    documents = [(str(row["_id"]), f"{row['title']} {row['text']}") for row in corpus]
    query_text = {str(row["_id"]): row["text"] for row in queries}
    relevance: dict[str, dict[str, int]] = defaultdict(dict)
    for row in qrels:
        if int(row["score"]) > 0:
            relevance[str(row["query-id"])][str(row["corpus-id"])] = int(row["score"])

    retriever = BM25(documents)
    scores = {"nDCG@10": [], "Recall@10": [], "MRR@10": []}
    evaluated_queries = 0
    for query_id, relevant in relevance.items():
        if query_id not in query_text:
            continue
        retrieved = retriever.search(query_text[query_id], 10)
        scores["nDCG@10"].append(ndcg_at_k(retrieved, relevant, 10))
        scores["Recall@10"].append(recall_at_k(retrieved, relevant, 10))
        scores["MRR@10"].append(reciprocal_rank_at_k(retrieved, relevant, 10))
        evaluated_queries += 1

    result = {
        "benchmark": dataset_info["label"],
        "dataset": dataset_info["dataset"],
        "qrels_dataset": dataset_info["qrels"],
        "split": "test",
        "retriever": "BM25",
        "parameters": {"k1": 1.2, "b": 0.75, "top_k": 10},
        "corpus_documents": len(documents),
        "query_rows": len(query_text),
        "qrel_rows": len(qrels),
        "evaluated_queries": evaluated_queries,
        "metrics": {name: sum(values) / len(values) if values else 0.0 for name, values in scores.items()},
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
    }
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a full BEIR BM25 baseline.")
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="scifact")
    parser.add_argument("--output_path", type=Path)
    args = parser.parse_args()
    result = run(args.dataset, args.output_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
