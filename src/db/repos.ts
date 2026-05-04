import { sql } from "./connection.ts";

export interface CiRepo {
  id: string;
  name: string;
  path: string;
  last_commit: string | null;
  indexed_at: Date | null;
  created_at: Date;
}

export interface CiRepoWithStats extends CiRepo {
  total_symbols: number;
  embedded_symbols: number;
}

export async function upsertRepo(
  name: string,
  path: string,
): Promise<CiRepo> {
  const [row] = await sql<CiRepo[]>`
    INSERT INTO ci_repos (name, path)
    VALUES (${name}, ${path})
    ON CONFLICT (name) DO UPDATE SET path = ${path}
    RETURNING *
  `;
  return row;
}

export async function getRepo(name: string): Promise<CiRepo | undefined> {
  const [row] = await sql<CiRepo[]>`
    SELECT * FROM ci_repos WHERE name = ${name}
  `;
  return row;
}

export async function listRepos(): Promise<CiRepo[]> {
  return sql<CiRepo[]>`SELECT * FROM ci_repos ORDER BY name`;
}

/**
 * List repos with symbol/embedding counts. Use this for `list_repos` so a
 * degraded index (e.g. embedded_symbols == 0) is visible at a glance.
 */
export async function listReposWithStats(): Promise<CiRepoWithStats[]> {
  return sql<CiRepoWithStats[]>`
    SELECT
      r.*,
      coalesce(stats.total_symbols, 0)::int    AS total_symbols,
      coalesce(stats.embedded_symbols, 0)::int AS embedded_symbols
    FROM ci_repos r
    LEFT JOIN (
      SELECT
        f.repo_id,
        count(*)             AS total_symbols,
        count(s.embedding)   AS embedded_symbols
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      GROUP BY f.repo_id
    ) stats ON stats.repo_id = r.id
    ORDER BY r.name
  `;
}

export async function updateRepoCommit(
  repoId: string,
  commit: string,
): Promise<void> {
  await sql`
    UPDATE ci_repos
    SET last_commit = ${commit}, indexed_at = now()
    WHERE id = ${repoId}
  `;
}
