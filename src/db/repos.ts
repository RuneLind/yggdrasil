import { sql } from "./connection.ts";

export interface CiRepo {
  id: string;
  name: string;
  path: string;
  last_commit: string | null;
  indexed_at: Date | null;
  created_at: Date;
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
