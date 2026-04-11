import { sql } from "../db/connection.ts";
import { generateEmbedding } from "../embeddings.ts";

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
  },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 10;
  const candidateLimit = 30; // Pull more candidates for RRF merging

  // Generate embedding for semantic search
  const embedding = await generateEmbedding(query);
  const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;

  // Build optional filters
  const repoFilter = options?.repo ? sql`AND r.name = ${options.repo}` : sql``;
  const kindFilter = options?.kind ? sql`AND s.kind = ${options.kind}` : sql``;
  const langFilter = options?.language ? sql`AND f.language = ${options.language}` : sql``;
  const filters = sql`${repoFilter} ${kindFilter} ${langFilter}`;

  // 1. Full-text search ranked results
  const ftsResults = await sql<{ id: string; rank: number }[]>`
    SELECT s.id, ts_rank(s.search_vector, plainto_tsquery('english', ${query})) as rank
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.search_vector @@ plainto_tsquery('english', ${query})
    ${filters}
    ORDER BY rank DESC
    LIMIT ${candidateLimit}
  `;

  // 2. Semantic search (if embedding available)
  let semanticResults: { id: string; rank: number }[] = [];
  if (embeddingStr) {
    semanticResults = await sql.unsafe(
      `SELECT s.id, 1 - (s.embedding <=> $1::vector) as rank
       FROM ci_symbols s
       JOIN ci_files f ON f.id = s.file_id
       JOIN ci_repos r ON r.id = f.repo_id
       WHERE s.embedding IS NOT NULL
       ${options?.repo ? `AND r.name = $2` : ""}
       ${options?.kind ? `AND s.kind = $${options?.repo ? 3 : 2}` : ""}
       ORDER BY s.embedding <=> $1::vector
       LIMIT $${1 + (options?.repo ? 1 : 0) + (options?.kind ? 1 : 0) + 1}`,
      [
        embeddingStr,
        ...(options?.repo ? [options.repo] : []),
        ...(options?.kind ? [options.kind] : []),
        candidateLimit,
      ],
    );
  }

  // 3. Name similarity — exact match > prefix > qualified name substring
  const nameResults = await sql<{ id: string; rank: number }[]>`
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
  `;

  // 4. RRF merge
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

  // 5. Fetch full details for top results
  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (topIds.length === 0) return [];

  const details = await sql<Omit<SearchResult, "score">[]>`
    SELECT s.id, s.name, s.qualified_name, s.kind, s.signature,
           f.path as file_path, r.name as repo_name,
           s.start_line, s.end_line
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.id = ANY(${topIds})
  `;

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

  return details
    .map((d) => ({
      ...d,
      score: (scores.get(d.id) ?? 0) * (kindBoost[d.kind] ?? 1.0),
    }))
    .sort((a, b) => b.score - a.score);
}
