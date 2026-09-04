"""Run a fixed BM25+dense reciprocal-rank fusion on a public BEIR split."""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

try:
    from benchmarks.run_beir_bm25 import BM25, DATASETS, ndcg_at_k, recall_at_k, reciprocal_rank_at_k
except ModuleNotFoundError:
    from run_beir_bm25 import BM25, DATASETS, ndcg_at_k, recall_at_k, reciprocal_rank_at_k


def reciprocal_rank_fusion(rankings: list[list[str]], limit: int, rrf_k: int = 60) -> list[str]:
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for rank, document_id in enumerate(ranking, start=1):
            scores[document_id] += 1.0 / (rrf_k + rank)
    return sorted(scores, key=lambda document_id: (-scores[document_id], document_id))[:limit]


def run(dataset_name: str, model_name: str, device: str, batch_size: int, candidate_k: int, output_path: Path | None) -> dict[str, object]:
    import numpy as np
    from datasets import load_dataset
    from sentence_transformers import SentenceTransformer

    dataset_info = DATASETS[dataset_name]
    started_at = time.perf_counter()
    corpus = load_dataset(dataset_info["dataset"], "corpus", split="corpus")
    queries = load_dataset(dataset_info["dataset"], "queries", split="queries")
    qrels = load_dataset(dataset_info["qrels"], "default", split="test")
    documents = [(str(row["_id"]), f"{row['title']} {row['text']}") for row in corpus]
    document_ids = [document_id for document_id, _ in documents]
    query_text = {str(row["_id"]): row["text"] for row in queries}
    relevance: dict[str, dict[str, int]] = defaultdict(dict)
    for row in qrels:
        if int(row["score"]) > 0:
            relevance[str(row["query-id"])][str(row["corpus-id"])] = int(row["score"])

    lexical = BM25(documents)
    encoder = SentenceTransformer(model_name, device=device)
    embeddings = encoder.encode(
        [text for _, text in documents],
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    query_ids = [query_id for query_id in relevance if query_id in query_text]
    query_embeddings = encoder.encode(
        [query_text[query_id] for query_id in query_ids],
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )

    scores = {"nDCG@10": [], "Recall@10": [], "MRR@10": []}
    for query_id, query_embedding in zip(query_ids, query_embeddings):
        similarities = embeddings @ query_embedding
        dense_count = min(candidate_k, len(document_ids))
        candidate_indices = np.argpartition(-similarities, dense_count - 1)[:dense_count]
        dense_indices = sorted(candidate_indices, key=lambda index: (-float(similarities[index]), document_ids[index]))
        dense_ranking = [document_ids[index] for index in dense_indices]
        lexical_ranking = lexical.search(query_text[query_id], candidate_k)
        retrieved = reciprocal_rank_fusion([dense_ranking, lexical_ranking], 10)
        relevant = relevance[query_id]
        scores["nDCG@10"].append(ndcg_at_k(retrieved, relevant, 10))
        scores["Recall@10"].append(recall_at_k(retrieved, relevant, 10))
        scores["MRR@10"].append(reciprocal_rank_at_k(retrieved, relevant, 10))

    result = {
        "benchmark": dataset_info["label"],
        "dataset": dataset_info["dataset"],
        "qrels_dataset": dataset_info["qrels"],
        "split": "test",
        "retriever": "BM25 + dense reciprocal-rank fusion",
        "model": model_name,
        "parameters": {"device": device, "batch_size": batch_size, "normalize_embeddings": True, "candidate_k": candidate_k, "top_k": 10, "rrf_k": 60},
        "corpus_documents": len(document_ids),
        "evaluated_queries": len(query_ids),
        "metrics": {name: sum(values) / len(values) if values else 0.0 for name, values in scores.items()},
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
    }
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a fixed BM25+dense BEIR fusion.")
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="scifact")
    parser.add_argument("--model", default="BAAI/bge-base-en-v1.5")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--candidate-k", type=int, default=100)
    parser.add_argument("--output-path", type=Path)
    args = parser.parse_args()
    if args.batch_size <= 0 or args.candidate_k <= 0:
        raise SystemExit("batch-size and candidate-k must be positive")
    print(json.dumps(run(args.dataset, args.model, args.device, args.batch_size, args.candidate_k, args.output_path), indent=2))


if __name__ == "__main__":
    main()
