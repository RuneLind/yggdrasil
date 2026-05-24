import { sql } from "../db/connection.ts";
import { generateEmbedding } from "../embeddings.ts";
import { toVectorLiteral } from "../db/symbols.ts";
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

  const tRrfStart = performance.now();
  const K = 60;
  const scores = new Map<string, number>();

  const addScores = (results: { id: string; rank: number }[], weight: number) => {
    results.forEach((r, idx) => {
      const rrfScore = weight / (K + idx + 1);
      scores.set(r.id, (scores.get(r.id) ?? 0) + rrfScore);
    });
  };

  addScores(ftsResults, 1.0);
  addScores(semanticResults, 1.0);
  addScores(nameResults, 1.5);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (tracer) {
    ranked.forEach(([id, score], i) => tracer.recordStage("rrf", id, i + 1, score));
    tracer.recordTiming("rrf", performance.now() - tRrfStart);
  }

  const topIds = ranked.slice(0, limit).map(([id]) => id);
  if (topIds.length === 0) return [];

  const topIdSet = new Set(topIds);

  const detailsPromise = sql<Omit<SearchResult, "score">[]>`
    SELECT s.id, s.name, s.qualified_name, s.kind, s.signature,
           f.path as file_path, r.name as repo_name,
           s.start_line, s.end_line
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.id = ANY(${topIds})
  `;

  // Annotation fetch is in parallel with the wider details query and only pulls
  // the columns needed for the trace, so the trace-on path stays cheap.
  const annotateIds = tracer
    ? ranked.filter(([id]) => !topIdSet.has(id)).map(([id]) => id)
    : [];
  const annotatePromise = annotateIds.length
    ? sql<{ id: string; qualified_name: string; kind: string }[]>`
        SELECT id, qualified_name, kind FROM ci_symbols WHERE id = ANY(${annotateIds})
      `
    : Promise.resolve([] as { id: string; qualified_name: string; kind: string }[]);

  const [details, annotations] = await Promise.all([detailsPromise, annotatePromise]);

  if (tracer) {
    for (const d of details) tracer.annotate(d.id, d.qualified_name, d.kind);
    for (const a of annotations) tracer.annotate(a.id, a.qualified_name, a.kind);
  }

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

  const finalResults = details
    .map((d) => ({
      ...d,
      score: (scores.get(d.id) ?? 0) * (kindBoost[d.kind] ?? 1.0),
    }))
    .sort((a, b) => b.score - a.score);

  if (tracer) {
    finalResults.forEach((r, i) => tracer.recordStage("final", r.id, i + 1, r.score));
  }

  return finalResults;
}
