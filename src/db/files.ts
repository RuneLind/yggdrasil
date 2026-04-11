import { sql } from "./connection.ts";

export interface CiFile {
  id: string;
  repo_id: string;
  path: string;
  language: string;
  content_hash: string;
  indexed_at: Date;
}

export async function upsertFile(
  repoId: string,
  path: string,
  language: string,
  contentHash: string,
): Promise<{ id: string; changed: boolean }> {
  // Check if file exists and hash matches
  const [existing] = await sql<{ id: string; content_hash: string }[]>`
    SELECT id, content_hash FROM ci_files
    WHERE repo_id = ${repoId} AND path = ${path}
  `;

  if (existing && existing.content_hash === contentHash) {
    return { id: existing.id, changed: false };
  }

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ci_files (repo_id, path, language, content_hash)
    VALUES (${repoId}, ${path}, ${language}, ${contentHash})
    ON CONFLICT (repo_id, path) DO UPDATE SET
      language = ${language},
      content_hash = ${contentHash},
      indexed_at = now()
    RETURNING id
  `;

  return { id: row.id, changed: true };
}

export async function deleteFileData(fileId: string): Promise<void> {
  // ci_symbols cascade-deletes ci_edges via FK; import_map needs explicit delete
  await Promise.all([
    sql`DELETE FROM ci_symbols WHERE file_id = ${fileId}`,
    sql`DELETE FROM ci_import_map WHERE file_id = ${fileId}`,
  ]);
}

export async function getFilesByRepo(repoId: string): Promise<CiFile[]> {
  return sql<CiFile[]>`
    SELECT * FROM ci_files WHERE repo_id = ${repoId} ORDER BY path
  `;
}

export async function deleteStaleFiles(
  repoId: string,
  currentPaths: string[],
): Promise<number> {
  if (currentPaths.length === 0) return 0;
  const result = await sql`
    DELETE FROM ci_files
    WHERE repo_id = ${repoId} AND path != ALL(${currentPaths})
  `;
  return result.count;
}
