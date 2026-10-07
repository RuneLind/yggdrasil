import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { indexRepo, type IndexResult } from "../../src/indexer/index.ts";
import { sql } from "../../src/db/connection.ts";
import type { SupportedLanguage } from "../../src/indexer/parser.ts";

/**
 * Integration harness: write a small source tree to a temp dir, index it through the
 * real `indexRepo`, and query the resulting edges.
 *
 * The DB is shared with Muninn and other indexed repos, so isolation is the unique
 * repo name (`itest-<random>`); `cleanup()` deletes that ci_repos row (cascades to
 * files, symbols, edges, imports) and the temp dir.
 *
 * Each harness start also sweeps `itest-*` rows older than an hour, left behind by runs
 * killed before cleanup. `created_at`, not `indexed_at`: indexed_at is only set from a
 * git commit, and fixture dirs are not git repos.
 *
 * The harness never calls `sql.end()`: bun runs every test file in one process
 * against one shared pool, so ending it in one file's afterAll breaks the next file.
 */

export interface FixtureEdge {
  source: string;
  target: string;
  kind: string;
  line: number | null;
}

export interface FixtureRepo {
  name: string;
  path: string;
  index: IndexResult;
  /** All edges whose source and target both live in this repo, by qualified name. */
  edges(kind?: string): Promise<FixtureEdge[]>;
  /** Incoming edges to `targetQualifiedName`, optionally filtered by kind. */
  edgesTo(targetQualifiedName: string, kind?: string): Promise<FixtureEdge[]>;
  /** Outgoing edges from `sourceQualifiedName`, optionally filtered by kind. */
  edgesFrom(sourceQualifiedName: string, kind?: string): Promise<FixtureEdge[]>;
  cleanup(): Promise<void>;
}

export async function createFixtureRepo(
  files: Record<string, string>,
  languages: SupportedLanguage[] = ["java", "kotlin"],
): Promise<FixtureRepo> {
  await sql`DELETE FROM ci_repos WHERE name LIKE 'itest-%' AND created_at < now() - interval '1 hour'`;

  const name = `itest-${crypto.randomUUID().slice(0, 8)}`;
  const path = await mkdtemp(join(tmpdir(), `yggdrasil-${name}-`));

  const cleanup = async () => {
    try {
      await sql`DELETE FROM ci_repos WHERE name = ${name}`;
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  };

  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(path, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    // exclude: [] — the default excludes nothing a fixture uses, but an explicit empty
    // list keeps `src/test/...` fixture paths from ever being filtered.
    const index = await indexRepo({ name, path, languages, exclude: [] }, { skipEmbeddings: true });

    const edges = async (filter: { kind?: string; source?: string; target?: string } = {}) => {
      const kindFilter = filter.kind ? sql`AND e.kind = ${filter.kind}` : sql``;
      const sourceFilter = filter.source ? sql`AND src.qualified_name = ${filter.source}` : sql``;
      const targetFilter = filter.target ? sql`AND tgt.qualified_name = ${filter.target}` : sql``;
      return sql<FixtureEdge[]>`
        SELECT src.qualified_name AS source, tgt.qualified_name AS target, e.kind, e.line
        FROM ci_edges e
        JOIN ci_symbols src ON src.id = e.source_id
        JOIN ci_files sf ON sf.id = src.file_id
        JOIN ci_symbols tgt ON tgt.id = e.target_id
        JOIN ci_files tf ON tf.id = tgt.file_id
        JOIN ci_repos r ON r.id = sf.repo_id
        WHERE r.name = ${name} AND tf.repo_id = r.id
        ${kindFilter} ${sourceFilter} ${targetFilter}
        ORDER BY source, target, e.kind, e.line
      `;
    };

    return {
      name,
      path,
      index,
      edges: (kind) => edges({ kind }),
      edgesTo: (target, kind) => edges({ target, kind }),
      edgesFrom: (source, kind) => edges({ source, kind }),
      cleanup,
    };
  } catch (err) {
    // Keep the indexing error: a cleanup failure here would otherwise replace it.
    await cleanup().catch((cleanupErr) => console.error(`cleanup of ${name} failed:`, cleanupErr));
    throw err;
  }
}
