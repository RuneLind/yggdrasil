import { sql } from "../db/connection.ts";
import { generateEmbedding } from "../embeddings.ts";
import { toVectorLiteral } from "../db/symbols.ts";
import { fuseAndRank } from "./rrf.ts";
import { timed, type SearchTracer } from "../tracing/trace.ts";

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
    tracer?: SearchTracer;
  },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 10;
  const candidateLimit = 30;
  const tracer = options?.tracer;

  tracer?.setQuery(query, {
    repo: options?.repo,
    kind: options?.kind,
    language: options?.language,
  });

  const embedding = await timed(tracer, "embedding", generateEmbedding(query));
  const embeddingStr = embedding ? toVectorLiteral(embedding) : null;

  const repoFilter = options?.repo ? sql`AND r.name = ${options.repo}` : sql``;
  const kindFilter = options?.kind ? sql`AND s.kind = ${options.kind}` : sql``;
  const langFilter = options?.language ? sql`AND f.language = ${options.language}` : sql``;
  const filters = sql`${repoFilter} ${kindFilter} ${langFilter}`;

  // plainto_tsquery ANDs every token — precise for 1–2 word symbol searches, but a
  // multi-word natural-language query (the kind analyze_ticket sends) returns 0 because
  // no single symbol's search_vector contains all tokens. When the strict AND yields
  // nothing, retry once with the same lexed tokens ORed together — swap the AND operator
  // for OR in the parsed tsquery text, so the FTS leg still contributes instead of
  // silently dropping out and leaving the semantic leg to carry it alone.
  //
  // The swap targets ' & ' (space-delimited): the tsquery text renders the AND operator
  // with surrounding spaces, while a literal '&' that lives *inside* a lexeme (URL/path
  // tokens like 'example.com/a&b') has none. A bare replace('&','|') would corrupt those
  // lexemes into a different, non-existent token; matching on ' & ' touches only the
  // connective. Lexemes never contain ' & ' since whitespace is a token separator.
  const ftsPromise = timed(
    tracer,
    "fts",
    (async () => {
      const andRows = await sql<{ id: string; rank: number }[]>`
        SELECT s.id, ts_rank(s.search_vector, plainto_tsquery('simple', ${query})) as rank
        FROM ci_symbols s
        JOIN ci_files f ON f.id = s.file_id
        JOIN ci_repos r ON r.id = f.repo_id
        WHERE s.search_vector @@ plainto_tsquery('simple', ${query})
        ${filters}
        ORDER BY rank DESC, s.id
        LIMIT ${candidateLimit}
      `;
      if (andRows.length > 0) return andRows;
      return sql<{ id: string; rank: number }[]>`
        SELECT s.id, ts_rank(s.search_vector, replace(plainto_tsquery('simple', ${query})::text, ' & ', ' | ')::tsquery) as rank
        FROM ci_symbols s
        JOIN ci_files f ON f.id = s.file_id
        JOIN ci_repos r ON r.id = f.repo_id
        WHERE s.search_vector @@ replace(plainto_tsquery('simple', ${query})::text, ' & ', ' | ')::tsquery
        ${filters}
        ORDER BY rank DESC, s.id
        LIMIT ${candidateLimit}
      `;
    })(),
  );

  const semanticPromise = embeddingStr
    ? timed(tracer, "semantic", sql<{ id: string; rank: number }[]>`
        SELECT s.id, 1 - (s.embedding <=> ${embeddingStr}::vector) as rank
        FROM ci_symbols s
        JOIN ci_files f ON f.id = s.file_id
        JOIN ci_repos r ON r.id = f.repo_id
        WHERE s.embedding IS NOT NULL
        ${filters}
        ORDER BY s.embedding <=> ${embeddingStr}::vector
        LIMIT ${candidateLimit}
      `)
    : Promise.resolve([] as { id: string; rank: number }[]);

  const namePromise = timed(tracer, "name", sql<{ id: string; rank: number }[]>`
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
  `);

  const [ftsResults, semanticResults, nameResults] = await Promise.all([
    ftsPromise, semanticPromise, namePromise,
  ]);

  if (tracer) {
    ftsResults.forEach((r, i) => tracer.recordStage("fts", r.id, i + 1, r.rank));
    semanticResults.forEach((r, i) => tracer.recordStage("semantic", r.id, i + 1, r.rank));
    nameResults.forEach((r, i) => tracer.recordStage("name", r.id, i + 1, r.rank));
  }

  // Kind-boost must see the whole candidate pool *before* the top-`limit` cut, so a
  // high-value kind (class, 1.5) just below the RRF cutoff isn't permanently buried
  // under a low-value kind (property, 0.7) just above it. Fetch the candidate pool once
  // (≤ 3×candidateLimit ids), fuse + boost over all of it, then slice — the details are
  // already in hand, so no second round-trip for the survivors.
  const candidateIds = [
    ...new Set([...ftsResults, ...semanticResults, ...nameResults].map((r) => r.id)),
  ];
  if (candidateIds.length === 0) return [];

  const candidates = await sql<Omit<SearchResult, "score">[]>`
    SELECT s.id, s.name, s.qualified_name, s.kind, s.signature,
           f.path as file_path, r.name as repo_name,
           s.start_line, s.end_line
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.id = ANY(${candidateIds})
  `;
  const detailById = new Map(candidates.map((c) => [c.id, c]));
  const kindById = new Map(candidates.map((c) => [c.id, c.kind]));

  const tRrfStart = performance.now();
  const fused = fuseAndRank(
    [
      { results: ftsResults, weight: 1.0 },
      { results: semanticResults, weight: 1.0 },
      { results: nameResults, weight: 1.5 },
    ],
    kindById,
  );

  if (tracer) {
    fused.rrfRanked.forEach((c, i) => tracer.recordStage("rrf", c.id, i + 1, c.rrfScore));
    tracer.recordTiming("rrf", performance.now() - tRrfStart);
    // The candidate fetch already carries qualified_name + kind for every ranked id.
    for (const c of candidates) tracer.annotate(c.id, c.qualified_name, c.kind);
  }

  // fused.boosted is already sorted (score desc, id asc). Drop any candidate we didn't
  // hydrate (e.g. a row deleted by a concurrent re-index between the leg queries and the
  // detail fetch) *before* slicing, so it can't occupy a top-`limit` slot that a valid
  // lower-ranked candidate would otherwise fill.
  const finalResults: SearchResult[] = fused.boosted
    .filter((c) => detailById.has(c.id))
    .slice(0, limit)
    .map((c) => ({ ...detailById.get(c.id)!, score: c.score }));

  if (tracer) {
    finalResults.forEach((r, i) => tracer.recordStage("final", r.id, i + 1, r.score));
  }

  return finalResults;
}
