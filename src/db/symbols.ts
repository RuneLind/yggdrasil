import { sql } from "./connection.ts";

export interface CiSymbol {
  id: string;
  file_id: string;
  name: string;
  qualified_name: string;
  kind: string;
  parent_id: string | null;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_comment: string | null;
  visibility: string | null;
  is_static: boolean;
  declared_type?: string | null;
  min_params?: number | null;
  max_params?: number | null;
  param_types?: (string | null)[] | null;
  param_names?: (string | null)[] | null;
  extension_receiver?: string | null;
}

export interface SymbolInsert {
  file_id: string;
  name: string;
  qualified_name: string;
  kind: string;
  parent_id?: string | null;
  start_line: number;
  end_line: number;
  signature?: string | null;
  doc_comment?: string | null;
  visibility?: string | null;
  is_static?: boolean;
  declared_type?: string | null;
  min_params?: number | null;
  max_params?: number | null;
  param_types?: (string | null)[] | null;
  param_names?: (string | null)[] | null;
  extension_receiver?: string | null;
  is_local?: boolean;
  type_params?: string[] | null;
  param_type_vars?: (string | null)[] | null;
}

export async function insertSymbolsBatch(symbols: SymbolInsert[]): Promise<string[]> {
  if (symbols.length === 0) return [];

  const rows = await sql<{ id: string }[]>`
    INSERT INTO ci_symbols ${sql(
      symbols.map((s) => ({
        file_id: s.file_id,
        name: s.name,
        qualified_name: s.qualified_name,
        kind: s.kind,
        parent_id: s.parent_id ?? null,
        start_line: s.start_line,
        end_line: s.end_line,
        signature: s.signature ?? null,
        doc_comment: s.doc_comment ?? null,
        visibility: s.visibility ?? null,
        is_static: s.is_static ?? false,
        declared_type: s.declared_type ?? null,
        min_params: s.min_params ?? null,
        max_params: s.max_params ?? null,
        param_types: s.param_types ?? null,
        param_names: s.param_names ?? null,
        extension_receiver: s.extension_receiver ?? null,
        is_local: s.is_local ?? false,
        type_params: s.type_params ?? null,
        param_type_vars: s.param_type_vars ?? null,
      })),
      "file_id",
      "name",
      "qualified_name",
      "kind",
      "parent_id",
      "start_line",
      "end_line",
      "signature",
      "doc_comment",
      "visibility",
      "is_static",
      "declared_type",
      "min_params",
      "max_params",
      "param_types",
      "param_names",
      "extension_receiver",
      "is_local",
      "type_params",
      "param_type_vars",
    )}
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/**
 * Set parent_id for symbols whose parent could only be resolved after insertion.
 *
 * Symbols are inserted with parent_id = NULL because a child's parent_id needs the
 * parent's DB id, which only exists post-insert. This second pass wires them up.
 * Relies on the same positional contract the edge resolver uses: symbolDbIds[i]
 * corresponds to the i-th extracted symbol (see buildParentLinks). One round-trip
 * via a VALUES join; ids are bound as parameters.
 */
export async function updateSymbolParents(
  links: { id: string; parent_id: string }[],
): Promise<void> {
  if (links.length === 0) return;
  const values = links.map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::uuid)`).join(", ");
  const params = links.flatMap((l) => [l.id, l.parent_id]);
  await sql.unsafe(
    `UPDATE ci_symbols AS s
     SET parent_id = v.parent_id
     FROM (VALUES ${values}) AS v(id, parent_id)
     WHERE s.id = v.id`,
    params,
  );
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function updateSymbolEmbedding(
  id: string,
  embedding: number[],
): Promise<void> {
  await sql.unsafe(
    `UPDATE ci_symbols SET embedding = $1::vector WHERE id = $2`,
    [toVectorLiteral(embedding), id],
  );
}

/**
 * Fetch a page of symbols missing an embedding, ordered by id and starting after
 * `afterId` (exclusive). The cursor is what makes the embedder drain loop terminate:
 * symbols whose embedding generation keeps failing stay NULL, but advancing the cursor
 * past them means they are never re-fetched, so the loop always makes forward progress
 * through the id space instead of spinning on the same poison rows forever.
 */
export async function getSymbolsWithoutEmbeddings(
  limit = 100,
  repoId?: string,
  afterId?: string,
): Promise<{ id: string; qualified_name: string; signature: string | null; doc_comment: string | null }[]> {
  const repoFilter = repoId
    ? sql`AND f.repo_id = ${repoId}`
    : sql``;
  const cursorFilter = afterId
    ? sql`AND s.id > ${afterId}::uuid`
    : sql``;
  return sql`
    SELECT s.id, s.qualified_name, s.signature, s.doc_comment
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    WHERE s.embedding IS NULL
    ${repoFilter}
    ${cursorFilter}
    ORDER BY s.id
    LIMIT ${limit}
  `;
}

export async function findSymbolByQualifiedName(
  qualifiedName: string,
  repoName?: string,
): Promise<(CiSymbol & { file_path: string; repo_name: string })[]> {
  const repoFilter = repoName ? sql`AND r.name = ${repoName}` : sql``;
  // qualified_name is non-unique (overloads, partial names, multi-repo collisions),
  // and callers take [0]. ORDER BY makes that pick deterministic across identical
  // calls instead of relying on Postgres's physical row order.
  return sql`
    SELECT s.*, f.path as file_path, r.name as repo_name
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.qualified_name = ${qualifiedName}
    ${repoFilter}
    ORDER BY r.name, f.path, s.start_line, s.id
  `;
}

/** Resolve a symbol by its DB id, with file_path + repo_name joined in.
 *  Lets callers that already hold a concrete id (search candidates) avoid a
 *  lossy re-resolution by qualified_name.
 *  Explicit column list (like getSymbolsByFile) so the 384-dim embedding vector and
 *  the search_vector tsvector — neither in CiSymbol — aren't fetched and discarded. */
export async function getSymbolById(
  id: string,
): Promise<(CiSymbol & { file_path: string; repo_name: string }) | null> {
  const [row] = await sql<(CiSymbol & { file_path: string; repo_name: string })[]>`
    SELECT s.id, s.file_id, s.name, s.qualified_name, s.kind, s.parent_id,
           s.start_line, s.end_line, s.signature, s.doc_comment, s.visibility, s.is_static,
           f.path as file_path, r.name as repo_name
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.id = ${id}
  `;
  return row ?? null;
}

export async function getSymbolsByFile(
  fileId: string,
): Promise<CiSymbol[]> {
  // Explicit column list — the table also has embedding (384-dim vector) and
  // search_vector (FTS tsvector) which would balloon JSON responses if returned.
  return sql<CiSymbol[]>`
    SELECT id, file_id, name, qualified_name, kind, parent_id,
           start_line, end_line, signature, doc_comment, visibility, is_static
    FROM ci_symbols
    WHERE file_id = ${fileId}
    ORDER BY start_line
  `;
}

export async function getRepoSymbolCount(repoId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text as count FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    WHERE f.repo_id = ${repoId}
  `;
  return parseInt(row.count, 10);
}
