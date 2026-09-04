"""Evaluate retrieval on the public MTRAG human retrieval tasks.

The runner consumes the official IBM MTRAG repository layout and emits the
JSONL format expected by the official retrieval evaluator. It supports a
deterministic BM25 baseline, SentenceTransformers dense retrieval, and a
fixed reciprocal-rank fusion of both result lists.
"""

from __future__ import annotations

import argparse
import json
import time
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable

try:
    from benchmarks.run_beir_bm25 import BM25
except ModuleNotFoundError:
    from run_beir_bm25 import BM25


COLLECTIONS = {
    "clapnq": "mt-rag-clapnq-elser-512-100-20240503",
    "cloud": "mt-rag-ibmcloud-elser-512-100-20240502",
    "fiqa": "mt-rag-fiqa-beir-elser-512-100-20240501",
    "govt": "mt-rag-govt-elser-512-100-20240611",
}
VARIANTS = ("lastturn", "rewrite", "questions")


def read_jsonl(path: Path) -> Iterable[dict[str, object]]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def read_zipped_jsonl(path: Path) -> list[dict[str, object]]:
    with zipfile.ZipFile(path) as archive:
        members = [name for name in archive.namelist() if name.endswith(".jsonl")]
        if len(members) != 1:
            raise ValueError(f"Expected one JSONL member in {path}, found {members}")
        with archive.open(members[0]) as handle:
            return [json.loads(line) for line in handle if line.strip()]


def load_collection(root: Path, collection: str, variant: str) -> tuple[list[tuple[str, str]], list[dict[str, object]], dict[str, dict[str, int]]]:
    if collection not in COLLECTIONS:
        raise ValueError(f"Unknown collection: {collection}")
    if variant not in VARIANTS:
        raise ValueError(f"Unknown query variant: {variant}")
    corpus_path = root / "corpora" / "passage_level" / f"{collection}.jsonl.zip"
    query_path = root / "mtrag-human" / "retrieval_tasks" / collection / f"{collection}_{variant}.jsonl"
    qrels_path = root / "mtrag-human" / "retrieval_tasks" / collection / "qrels" / "dev.tsv"
    corpus = read_zipped_jsonl(corpus_path)
    queries = list(read_jsonl(query_path))
    qrels: dict[str, dict[str, int]] = defaultdict(dict)
    with qrels_path.open(encoding="utf-8") as handle:
        next(handle)
        for line in handle:
            query_id, document_id, score = line.rstrip("\n").split("\t")
            qrels[query_id][document_id] = int(score)
    documents = [(str(row.get("_id") or row.get("id")), str(row.get("title", "")) + " " + str(row.get("text", ""))) for row in corpus]
    return documents, queries, qrels


def reciprocal_rank_fusion(rankings: list[list[str]], limit: int, rrf_k: int = 60) -> list[tuple[str, float]]:
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for rank, document_id in enumerate(ranking, start=1):
            scores[document_id] += 1.0 / (rrf_k + rank)
    ranked = sorted(scores, key=lambda document_id: (-scores[document_id], document_id))
    return [(document_id, scores[document_id]) for document_id in ranked[:limit]]


def dense_ranking(embeddings, document_ids: list[str], query_embedding, limit: int) -> list[tuple[str, float]]:
    import numpy as np

    candidate_count = min(limit, len(document_ids))
    similarities = embeddings @ query_embedding
    candidate_indices = np.argpartition(-similarities, candidate_count - 1)[:candidate_count]
    ranked_indices = sorted(candidate_indices, key=lambda index: (-float(similarities[index]), document_ids[index]))
    return [(document_ids[index], float(similarities[index])) for index in ranked_indices]


def evaluate_results(results: dict[str, dict[str, float]], qrels: dict[str, dict[str, int]]) -> dict[str, float]:
    import pytrec_eval

    evaluator = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut.1,3,5,10", "recall.1,3,5,10"})
    evaluated = evaluator.evaluate(results)
    if not evaluated:
        return {f"nDCG@{k}": 0.0 for k in (1, 3, 5, 10)} | {f"Recall@{k}": 0.0 for k in (1, 3, 5, 10)}
    metrics: dict[str, float] = {}
    for metric, prefix in (("ndcg_cut", "nDCG"), ("recall", "Recall")):
        for k in (1, 3, 5, 10):
            metrics[f"{prefix}@{k}"] = sum(row[f"{metric}_{k}"] for row in evaluated.values()) / len(evaluated)
    return metrics


def run(root: Path, variant: str, retriever: str, model_name: str, device: str, batch_size: int, top_k: int, candidate_k: int, collections: list[str], predictions_path: Path | None = None, query_prefix: str = "", max_seq_length: int | None = None) -> dict[str, object]:
    if retriever not in {"bm25", "dense", "hybrid"}:
        raise ValueError(f"Unknown retriever: {retriever}")
    started_at = time.perf_counter()
    collection_receipts: list[dict[str, object]] = []
    all_results: dict[str, dict[str, float]] = {}
    all_qrels: dict[str, dict[str, int]] = {}
    prediction_handle = None
    if predictions_path:
        predictions_path.parent.mkdir(parents=True, exist_ok=True)
        prediction_handle = predictions_path.open("w", encoding="utf-8")

    encoder = None
    if retriever in {"dense", "hybrid"}:
        from sentence_transformers import SentenceTransformer

        encoder = SentenceTransformer(model_name, device=device)
        if max_seq_length is not None:
            encoder.max_seq_length = max_seq_length

    for collection in collections:
        documents, queries, qrels = load_collection(root, collection, variant)
        document_ids = [document_id for document_id, _ in documents]
        rankings_by_query: dict[str, list[tuple[str, float]]] = {}
        bm25 = BM25(documents) if retriever in {"bm25", "hybrid"} else None
        document_embeddings = None
        if encoder is not None:
            document_embeddings = encoder.encode(
                [text for _, text in documents],
                batch_size=batch_size,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=True,
            )
        query_rows = {str(row["_id"]): str(row["text"]) for row in queries if str(row["_id"]) in qrels}
        query_embeddings = None
        if encoder is not None:
            query_ids = list(query_rows)
            query_embeddings = encoder.encode(
                [query_prefix + query_rows[query_id] for query_id in query_ids],
                batch_size=batch_size,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=True,
            )
        for query_index, (query_id, query_text) in enumerate(query_rows.items()):
            if retriever == "bm25":
                ranking = [(document_id, float(candidate_k - rank)) for rank, document_id in enumerate(bm25.search(query_text, candidate_k))]
            elif retriever == "dense":
                ranking = dense_ranking(document_embeddings, document_ids, query_embeddings[query_index], candidate_k)
            else:
                dense = dense_ranking(document_embeddings, document_ids, query_embeddings[query_index], candidate_k)
                lexical = bm25.search(query_text, candidate_k)
                ranking = reciprocal_rank_fusion([[document_id for document_id, _ in dense], lexical], candidate_k)
            rankings_by_query[query_id] = ranking[:top_k]
            all_results[query_id] = {document_id: score for document_id, score in rankings_by_query[query_id]}
            all_qrels[query_id] = qrels[query_id]
            if prediction_handle:
                prediction_handle.write(json.dumps({
                    "task_id": query_id,
                    "Collection": COLLECTIONS[collection],
                    "contexts": [{"document_id": document_id, "score": score} for document_id, score in rankings_by_query[query_id]],
                }) + "\n")
        collection_results = {query_id: all_results[query_id] for query_id in query_rows}
        collection_receipts.append({
            "collection": collection,
            "official_collection": COLLECTIONS[collection],
            "documents": len(documents),
            "queries": len(query_rows),
            "metrics": evaluate_results(collection_results, qrels),
        })

    if prediction_handle:
        prediction_handle.close()
    metrics = evaluate_results(all_results, all_qrels)
    result = {
        "benchmark": "MTRAG human retrieval tasks",
        "source": "IBM mt-rag-benchmark",
        "variant": variant,
        "retriever": retriever,
        "model": model_name if retriever in {"dense", "hybrid"} else None,
        "parameters": {"device": device, "batch_size": batch_size, "top_k": top_k, "candidate_k": candidate_k, "rrf_k": 60, "query_prefix": query_prefix, "max_seq_length": encoder.max_seq_length if encoder is not None else None},
        "collections": collection_receipts,
        "queries": len(all_results),
        "metrics": metrics,
        "elapsed_seconds": round(time.perf_counter() - started_at, 3),
    }
    if predictions_path:
        result["predictions_path"] = str(predictions_path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate public MTRAG retrieval tasks.")
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--variant", choices=VARIANTS, default="rewrite")
    parser.add_argument("--retriever", choices=("bm25", "dense", "hybrid"), default="hybrid")
    parser.add_argument("--model", default="BAAI/bge-base-en-v1.5")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--candidate-k", type=int, default=100)
    parser.add_argument("--collections", nargs="+", choices=sorted(COLLECTIONS), default=sorted(COLLECTIONS))
    parser.add_argument("--output-path", type=Path)
    parser.add_argument("--predictions-path", type=Path)
    parser.add_argument("--query-prefix", default="", help="Optional model-specific instruction prepended to every query.")
    parser.add_argument("--max-seq-length", type=int, help="Optional encoder token limit for long-context embedding models.")
    args = parser.parse_args()
    if args.batch_size <= 0 or args.top_k <= 0 or args.candidate_k < args.top_k or (args.max_seq_length is not None and args.max_seq_length <= 0):
        raise SystemExit("Require positive batch-size, top-k, and max-seq-length, with candidate-k >= top-k")
    result = run(args.dataset_root, args.variant, args.retriever, args.model, args.device, args.batch_size, args.top_k, args.candidate_k, args.collections, args.predictions_path, args.query_prefix, args.max_seq_length)
    if args.output_path:
        args.output_path.parent.mkdir(parents=True, exist_ok=True)
        args.output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
