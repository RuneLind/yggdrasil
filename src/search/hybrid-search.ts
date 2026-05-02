import { sql } from "../db/connection.ts";
import { generateEmbedding } from "../embeddings.ts";
import { toVectorLiteral } from "../db/symbols.ts";
import type { Tracer } from "../tracing/trace.ts";

export interface SearchResult {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  signature: string | null;
  file_path: string;
  repo_name: string;
  start_line: number;
  end_line: number;
  score: number;
}

/**
 * Hybrid search over symbols using Reciprocal Rank Fusion (RRF).
 * Combines: full-text search, semantic similarity, and name trigram matching.
 */
export async function hybridSearch(
  query: string,
  options?: {
    repo?: string;
    kind?: string;
    language?: string;
    limit?: number;
    tracer?: Tracer;
  },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 10;
  const candidateLimit = 30; // Pull more candidates for RRF merging
  const tracer = options?.tracer;
  const t0 = performance.now();

  tracer?.setQuery(query, {
    repo: options?.repo,
    kind: options?.kind,
    language: options?.language,
  });

  // Generate embedding for semantic search
  const tEmbedStart = performance.now();
  const embedding = await generateEmbedding(query);
  tracer?.recordTiming("embedding", performance.now() - tEmbedStart);
  const embeddingStr = embedding ? toVectorLiteral(embedding) : null;

  // Build optional filters
  const repoFilter = options?.repo ? sql`AND r.name = ${options.repo}` : sql``;
  const kindFilter = options?.kind ? sql`AND s.kind = ${options.kind}` : sql``;
  const langFilter = options?.language ? sql`AND f.language = ${options.language}` : sql``;
  const filters = sql`${repoFilter} ${kindFilter} ${langFilter}`;

  // Run all three search strategies in parallel; time each independently.
  const tFtsStart = performance.now();
  const ftsPromise = sql<{ id: string; rank: number }[]>`
    SELECT s.id, ts_rank(s.search_vector, plainto_tsquery('simple', ${query})) as rank
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.search_vector @@ plainto_tsquery('simple', ${query})
    ${filters}
    ORDER BY rank DESC
    LIMIT ${candidateLimit}
  `.then((r) => {
    tracer?.recordTiming("fts", performance.now() - tFtsStart);
    return r;
  });

  const tSemStart = performance.now();
  const semanticPromise = embeddingStr
    ? sql<{ id: string; rank: number }[]>`
        SELECT s.id, 1 - (s.embedding <=> ${embeddingStr}::vector) as rank
        FROM ci_symbols s
        JOIN ci_files f ON f.id = s.file_id
        JOIN ci_repos r ON r.id = f.repo_id
        WHERE s.embedding IS NOT NULL
        ${filters}
        ORDER BY s.embedding <=> ${embeddingStr}::vector
        LIMIT ${candidateLimit}
      `.then((r) => {
        tracer?.recordTiming("semantic", performance.now() - tSemStart);
        return r;
      })
    : Promise.resolve([] as { id: string; rank: number }[]);

  const tNameStart = performance.now();
  const namePromise = sql<{ id: string; rank: number }[]>`
    SELECT s.id,
      CASE
        WHEN s.name = ${query} THEN 1.0
        WHEN lower(s.name) = lower(${query}) THEN 0.9
        WHEN lower(s.name) LIKE lower(${query + "%"}) THEN 0.7
        WHEN lower(s.qualified_name) LIKE lower(${"%" + query + "%"}) THEN 0.5
        ELSE 0.0
      END as rank
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE (
      lower(s.name) LIKE lower(${query + "%"})
      OR lower(s.qualified_name) LIKE lower(${"%" + query + "%"})
    )
    ${filters}
    ORDER BY rank DESC, s.kind ASC
    LIMIT ${candidateLimit}
  `.then((r) => {
    tracer?.recordTiming("name", performance.now() - tNameStart);
    return r;
  });

  const [ftsResults, semanticResults, nameResults] = await Promise.all([
    ftsPromise, semanticPromise, namePromise,
  ]);

  if (tracer) {
    ftsResults.forEach((r, i) => tracer.recordStage("fts", r.id, i + 1, r.rank));
    semanticResults.forEach((r, i) => tracer.recordStage("semantic", r.id, i + 1, r.rank));
    nameResults.forEach((r, i) => tracer.recordStage("name", r.id, i + 1, r.rank));
  }

  // 4. RRF merge
  const tRrfStart = performance.now();
  const K = 60; // RRF constant
  const scores = new Map<string, number>();

  const addScores = (results: { id: string; rank: number }[], weight: number) => {
    results.forEach((r, idx) => {
      const rrfScore = weight / (K + idx + 1);
      scores.set(r.id, (scores.get(r.id) ?? 0) + rrfScore);
    });
  };

  addScores(ftsResults, 1.0);
  addScores(semanticResults, 1.0);
  addScores(nameResults, 1.5); // Boost name matches

  if (tracer) {
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([id, score], i) => tracer.recordStage("rrf", id, i + 1, score));
    tracer.recordTiming("rrf", performance.now() - tRrfStart);
  }

  // 5. Fetch full details for top results (or, when tracing, the full candidate union for annotation)
  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (topIds.length === 0) {
    tracer?.recordTiming("total", performance.now() - t0);
    return [];
  }

  const detailIds = tracer ? [...scores.keys()] : topIds;
  const details = await sql<Omit<SearchResult, "score">[]>`
    SELECT s.id, s.name, s.qualified_name, s.kind, s.signature,
           f.path as file_path, r.name as repo_name,
           s.start_line, s.end_line
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.id = ANY(${detailIds})
  `;

  if (tracer) {
    for (const d of details) tracer.annotate(d.id, d.qualified_name, d.kind);
  }

  // Attach scores with kind-based boost: classes/interfaces/enums rank higher than fields/properties
  const kindBoost: Record<string, number> = {
    class: 1.5,
    interface: 1.5,
    enum: 1.4,
    method: 1.2,
    function: 1.2,
    constructor: 1.1,
    object: 1.3,
    type: 1.3,
    property: 0.7,
    field: 0.7,
  };

  const topIdSet = new Set(topIds);
  const finalResults = details
    .filter((d) => topIdSet.has(d.id))
    .map((d) => ({
      ...d,
      score: (scores.get(d.id) ?? 0) * (kindBoost[d.kind] ?? 1.0),
    }))
    .sort((a, b) => b.score - a.score);

  if (tracer) {
    finalResults.forEach((r, i) => tracer.recordStage("final", r.id, i + 1, r.score));
    tracer.recordTiming("total", performance.now() - t0);
  }

  return finalResults;
}
