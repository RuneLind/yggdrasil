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
}

export async function insertSymbol(sym: SymbolInsert): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ci_symbols (
      file_id, name, qualified_name, kind, parent_id,
      start_line, end_line, signature, doc_comment, visibility, is_static
    ) VALUES (
      ${sym.file_id}, ${sym.name}, ${sym.qualified_name}, ${sym.kind},
      ${sym.parent_id ?? null}, ${sym.start_line}, ${sym.end_line},
      ${sym.signature ?? null}, ${sym.doc_comment ?? null},
      ${sym.visibility ?? null}, ${sym.is_static ?? false}
    )
    RETURNING id
  `;
  return row.id;
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
    )}
    RETURNING id
  `;
  return rows.map((r) => r.id);
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

export async function getSymbolsWithoutEmbeddings(
  limit = 100,
): Promise<{ id: string; qualified_name: string; signature: string | null; doc_comment: string | null }[]> {
  return sql`
    SELECT id, qualified_name, signature, doc_comment
    FROM ci_symbols
    WHERE embedding IS NULL
    LIMIT ${limit}
  `;
}

export async function findSymbolByQualifiedName(
  qualifiedName: string,
  repoName?: string,
): Promise<(CiSymbol & { file_path: string; repo_name: string })[]> {
  const repoFilter = repoName ? sql`AND r.name = ${repoName}` : sql``;
  return sql`
    SELECT s.*, f.path as file_path, r.name as repo_name
    FROM ci_symbols s
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE s.qualified_name = ${qualifiedName}
    ${repoFilter}
  `;
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
