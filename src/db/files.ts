import { sql } from "./connection.ts";

export interface CiFile {
  id: string;
  repo_id: string;
  path: string;
  language: string;
  content_hash: string;
  indexed_at: Date;
}

/**
 * Resolve the file row for (repo, path), creating a placeholder for new files, and
 * report whether its content changed — WITHOUT persisting the new content_hash.
 *
 * The hash is the durable "this file is fully indexed" marker, so it must land only
 * after the file's symbols/imports/edges are stored (see markFileIndexed). New files
 * are inserted with an empty hash so that a crash before markFileIndexed leaves the
 * row looking un-indexed (hash mismatch) and it gets re-processed, rather than being
 * skipped forever as symbol-less.
 */
export async function ensureFile(
  repoId: string,
  path: string,
  language: string,
  contentHash: string,
): Promise<{ id: string; changed: boolean }> {
  const [existing] = await sql<{ id: string; content_hash: string }[]>`
    SELECT id, content_hash FROM ci_files
    WHERE repo_id = ${repoId} AND path = ${path}
  `;

  if (existing) {
    return { id: existing.id, changed: existing.content_hash !== contentHash };
  }

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ci_files (repo_id, path, language, content_hash)
    VALUES (${repoId}, ${path}, ${language}, '')
    RETURNING id
  `;

  return { id: row.id, changed: true };
}

/** Persist the content_hash (+ language) once a file's symbols/imports/edges are
 *  durably stored. Until this runs, the file reads as un-indexed and re-processes. */
export async function markFileIndexed(
  fileId: string,
  language: string,
  contentHash: string,
): Promise<void> {
  await sql`
    UPDATE ci_files
    SET content_hash = ${contentHash}, language = ${language}, indexed_at = now()
    WHERE id = ${fileId}
  `;
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
