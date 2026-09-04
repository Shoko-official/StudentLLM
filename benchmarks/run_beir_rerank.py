"""Run a public BEIR dense-retrieval plus CrossEncoder reranking experiment."""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path

try:
    from benchmarks.run_beir_bm25 import DATASETS, ndcg_at_k, recall_at_k, reciprocal_rank_at_k
except ModuleNotFoundError:
    from run_beir_bm25 import DATASETS, ndcg_at_k, recall_at_k, reciprocal_rank_at_k


def stable_rank(document_ids: list[str], scores: list[float], limit: int) -> list[int]:
    return sorted(range(len(document_ids)), key=lambda index: (-scores[index], document_ids[index]))[:limit]


def run(
    dataset_name: str,
    encoder_name: str,
    reranker_name: str,
    device: str,
    batch_size: int,
    rerank_batch_size: int,
    candidate_k: int,
    output_path: Path | None,
    query_prefix: str = "",
    max_seq_length: int | None = None,
) -> dict[str, object]:
    import numpy as np
    from datasets import load_dataset
    from sentence_transformers import CrossEncoder, SentenceTransformer

    dataset_info = DATASETS[dataset_name]
    started_at = time.perf_counter()
    corpus = load_dataset(dataset_info["dataset"], "corpus", split="corpus")
    queries = load_dataset(dataset_info["dataset"], "queries", split="queries")
    qrels = load_dataset(dataset_info["qrels"], "default", split="test")
    document_ids = [str(row["_id"]) for row in corpus]
    document_text = [f"{row['title']} {row['text']}" for row in corpus]
    query_text = {str(row["_id"]): row["text"] for row in queries}
    relevance: dict[str, dict[str, int]] = defaultdict(dict)
    for row in qrels:
        if int(row["score"]) > 0:
            relevance[str(row["query-id"])][str(row["corpus-id"])] = int(row["score"])

    encoder = SentenceTransformer(encoder_name, device=device)
    if max_seq_length is not None:
        encoder.max_seq_length = max_seq_length
    document_embeddings = encoder.encode(
        document_text,
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    query_ids = [query_id for query_id in relevance if query_id in query_text]
    query_embeddings = encoder.encode(
        [query_prefix + query_text[query_id] for query_id in query_ids],
        batch_size=batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    reranker = CrossEncoder(reranker_name, device=device)

    scores = {"nDCG@10": [], "Recall@10": [], "MRR@10": []}
    candidate_count = min(candidate_k, len(document_ids))
    top_k = min(10, candidate_count)
    for query_id, query_embedding in zip(query_ids, query_embeddings):
        similarities = document_embeddings @ query_embedding
        candidate_indices = np.argpartition(-similarities, candidate_count - 1)[:candidate_count]
        pairs = [[query_prefix + query_text[query_id], document_text[index]] for index in candidate_indices]
        rerank_scores = [float(score) for score in reranker.predict(pairs, batch_size=rerank_batch_size, show_progress_bar=False)]
        ranked_order = stable_rank([document_ids[index] for index in candidate_indices], rerank_scores, top_k)
        retrieved = [document_ids[candidate_indices[index]] for index in ranked_order]
        relevant = relevance[query_id]
        scores["nDCG@10"].append(ndcg_at_k(retrieved, relevant, 10))
        scores["Recall@10"].append(recall_at_k(retrieved, relevant, 10))
        scores["MRR@10"].append(reciprocal_rank_at_k(retrieved, relevant, 10))

    result = {
        "benchmark": dataset_info["label"],
        "dataset": dataset_info["dataset"],
        "qrels_dataset": dataset_info["qrels"],
        "split": "test",
        "retriever": "SentenceTransformers dense cosine similarity plus CrossEncoder reranking",
        "encoder": encoder_name,
        "reranker": reranker_name,
        "parameters": {
            "device": device,
            "batch_size": batch_size,
            "rerank_batch_size": rerank_batch_size,
            "candidate_k": candidate_count,
            "top_k": top_k,
            "normalize_embeddings": True,
            "query_prefix": query_prefix,
            "max_seq_length": encoder.max_seq_length,
        },
        "corpus_documents": len(document_ids),
        "query_rows": len(query_text),
        "qrel_rows": len(qrels),
        "evaluated_queries": len(query_ids),
        "metrics": {name: sum(values) / len(values) if values else 0.0 for name, values in scores.items()},
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
    }
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a full BEIR dense retrieval plus reranking experiment.")
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="scifact")
    parser.add_argument("--model", default="BAAI/bge-base-en-v1.5")
    parser.add_argument("--reranker-model", default="cross-encoder/ms-marco-MiniLM-L-6-v2")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--rerank-batch-size", type=int, default=32)
    parser.add_argument("--candidate-k", type=int, default=100)
    parser.add_argument("--query-prefix", default="", help="Optional model-specific instruction prepended to every query.")
    parser.add_argument("--max-seq-length", type=int, help="Optional encoder token limit for long-context embedding models.")
    parser.add_argument("--output-path", type=Path)
    args = parser.parse_args()
    if args.batch_size <= 0 or args.rerank_batch_size <= 0 or args.candidate_k <= 0 or (args.max_seq_length is not None and args.max_seq_length <= 0):
        raise SystemExit("batch sizes, candidate-k, and max-seq-length must be positive")
    print(json.dumps(run(
        args.dataset,
        args.model,
        args.reranker_model,
        args.device,
        args.batch_size,
        args.rerank_batch_size,
        args.candidate_k,
        args.output_path,
        args.query_prefix,
        args.max_seq_length,
    ), indent=2))


if __name__ == "__main__":
    main()
