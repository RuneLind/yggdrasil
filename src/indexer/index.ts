import { walkRepo } from "./file-walker.ts";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "./parser.ts";
import { extractSymbols, buildQualifiedNames, toSymbolInserts, buildParentLinks } from "./symbol-extractor.ts";
import { extractCallGraph } from "./call-graph.ts";
import { storeImports, resolveImports, deleteImportEdges } from "./import-resolver.ts";
import { storeCallGraph, rebuildEdges } from "./edge-resolver.ts";
import { embedSymbols } from "./embedder.ts";
import { warmupEmbeddings } from "../embeddings.ts";
import { upsertRepo, updateRepoCommit, updateRepoExtractorVersion } from "../db/repos.ts";
import { ensureFile, markFileIndexed, deleteFileData, deleteStaleFiles, setFilePackages } from "../db/files.ts";
import { insertSymbolsBatch, updateSymbolParents, getRepoSymbolCount } from "../db/symbols.ts";
import { sql } from "../db/connection.ts";
import type { RepoConfig } from "../config.ts";

/**
 * Version of what extraction stores per file; bump it when that output changes, and a
 * differing ci_repos.extractor_version re-extracts every file (content hashes alone don't).
 * The check is equality only: an older binary on a DB stamped with its version skips call sites.
 */
export const EXTRACTOR_VERSION = 6;

/**
 * Whether a repo's stored extractor version forces a full re-extract. NULL (never gated)
 * is stale; `undefined` means the column is missing, and the stale path would delete
 * every file before failing on the missing ci_call_sites table, so it throws instead.
 */
export function isExtractorVersionStale(
  stored: number | null | undefined,
  current: number = EXTRACTOR_VERSION,
): boolean {
  if (stored === undefined) {
    throw new Error(
      "ci_repos.extractor_version is missing: the database schema is out of date. Run `bun run db:migrate` and index again.",
    );
  }
  return stored !== current;
}

export interface IndexResult {
  repoName: string;
  totalFiles: number;
  changedFiles: number;
  totalSymbols: number;
  totalEdges: number;
  /** Embeddings generated this call (not total coverage). 0 on incremental runs with no new symbols. */
  newEmbeddings: number;
  newEmbeddingFailures: number;
  durationMs: number;
}

export interface IndexOptions {
  /** Force full re-index: drop all existing data for this repo before indexing. */
  full?: boolean;
  /** Skip embedding generation (e.g. for fast iteration during development). */
  skipEmbeddings?: boolean;
}

/** Index a repository — full or incremental based on content hashes. */
export async function indexRepo(
  config: RepoConfig,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const start = performance.now();

  console.log(
    `[yggdrasil] ${options.full ? "Full re-indexing" : "Indexing"} ${config.name} at ${config.path}...`,
  );

  await initParser();

  // Fail fast on an embedding model/dimension misconfig BEFORE doing any indexing work,
  // rather than after symbols + content hashes are already committed (warmup is memoized,
  // so Phase 3's embedSymbols reuses it). Skipped entirely with --no-embed.
  if (!options.skipEmbeddings) {
    await warmupEmbeddings();
  }

  const repo = await upsertRepo(config.name, config.path);

  const versionStale = isExtractorVersionStale(repo.extractor_version);

  if (options.full || versionStale) {
    const [{ count: existingFiles }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ci_files WHERE repo_id = ${repo.id}`;
    if (existingFiles > 0) {
      if (versionStale && !options.full) {
        console.log(
          `[yggdrasil] Extractor version ${repo.extractor_version ?? "none"} → ${EXTRACTOR_VERSION}: re-extracting all files`,
        );
      }
      if (options.skipEmbeddings) {
        console.warn(
          `[yggdrasil] WARNING: re-extracting drops every embedding of ${config.name}, and --no-embed skips regenerating them: semantic search stays dead until you run \`bun run embed\`.`,
        );
      }
      const deleteStart = performance.now();
      const deleted = await sql`DELETE FROM ci_files WHERE repo_id = ${repo.id}`;
      console.log(
        `[yggdrasil] Dropped ${deleted.count} existing files (cascades to symbols + edges) in ${Math.round(performance.now() - deleteStart)}ms`,
      );
    }
  }

  // Pre-load languages into a Map for sync lookup in the file loop
  const requestedLangs = (config.languages ?? ["java", "kotlin", "typescript", "tsx"]) as SupportedLanguage[];
  const langMap = new Map<string, Awaited<ReturnType<typeof loadLanguage>>>();
  await Promise.all(requestedLangs.map(async (l) => langMap.set(l, await loadLanguage(l))));

  const files = await walkRepo(config.path, {
    languages: requestedLangs,
    exclude: config.exclude,
  });

  console.log(`[yggdrasil] Found ${files.length} source files`);

  const currentPaths = files.map((f) => f.relativePath);
  const staleCount = await deleteStaleFiles(repo.id, currentPaths);
  if (staleCount > 0) {
    console.log(`[yggdrasil] Removed ${staleCount} stale files`);
  }

  // ── Phase 1: Extract symbols and imports ──
  let changedFiles = 0;

  // Files whose content_hash is written only after Phase 2, so an interrupted run
  // re-processes them instead of skipping them as symbol-less (see ensureFile).
  const pendingHashMarks: { fileId: string; language: string; contentHash: string }[] = [];
  const packages: { fileId: string; packageName: string | null }[] = [];

  for (const file of files) {
    const { id: fileId, changed } = await ensureFile(
      repo.id,
      file.relativePath,
      file.language,
      file.contentHash,
    );

    if (!changed) continue;
    changedFiles++;
    pendingHashMarks.push({ fileId, language: file.language, contentHash: file.contentHash });

    await deleteFileData(fileId);

    const language = langMap.get(file.language)!;
    const source = await Bun.file(file.absolutePath).text();
    const tree = parseSource(source, language);

    try {
      const extraction = extractSymbols(source, tree, file.language, language);
      const qualifiedNames = buildQualifiedNames(extraction);
      packages.push({ fileId, packageName: extraction.packageName });

      // Insert symbols
      const inserts = toSymbolInserts(
        extraction,
        fileId,
        qualifiedNames,
        extraction.symbols.map(() => null),
      );

      let symbolDbIds: string[] = [];
      if (inserts.length > 0) {
        symbolDbIds = await insertSymbolsBatch(inserts);
        // Symbols are inserted with parent_id = NULL (a child needs its parent's DB
        // id, which only exists post-insert). Wire parents up now so the call graph
        // and import top-level filters work — without this every edge fails to resolve.
        await updateSymbolParents(buildParentLinks(extraction.symbols, symbolDbIds));
      }

      // Store raw imports for later resolution
      if (extraction.imports.length > 0) {
        await storeImports(fileId, extraction.imports);
      }

      // Store call sites + inheritance refs; Phase 2 resolves them repo-wide.
      const callGraph = extractCallGraph(source, tree, file.language, extraction);
      await storeCallGraph(fileId, extraction.symbols, callGraph, symbolDbIds);
    } finally {
      tree.delete();
    }
  }

  // ── Phase 2: Resolve edges (imports, calls, inheritance) ──
  let totalEdges = 0;

  await setFilePackages(packages);

  if (changedFiles > 0 || staleCount > 0) {
    // Delete old import edges and re-resolve
    await deleteImportEdges(repo.id);
    const importEdges = await resolveImports(repo.id);
    totalEdges += importEdges;
    if (importEdges > 0) {
      console.log(`[yggdrasil] Resolved ${importEdges} import edges`);
    }

    // Rebuild every calls/extends/implements edge in the repo from the stored rows:
    // edges from unchanged files into a changed file cascaded away with its symbols.
    const rebuildStart = performance.now();
    const rebuilt = await rebuildEdges(repo.id);
    totalEdges += rebuilt.inheritanceEdges + rebuilt.overrideEdges + rebuilt.callEdges;
    console.log(
      `[yggdrasil] Rebuilt ${rebuilt.inheritanceEdges} inheritance + ${rebuilt.overrideEdges} overrides + ${rebuilt.callEdges} call edges (whole repo) in ${Math.round(performance.now() - rebuildStart)}ms`,
    );

    if (totalEdges > 0) {
      console.log(`[yggdrasil] Created ${totalEdges} total edges (whole repo)`);
    }
  }

  // Now that symbols, imports, and edges are durably stored, stamp each changed file's
  // content_hash. Crashing before this point leaves files re-processable rather than
  // orphaned as symbol-less. (Embeddings below are idempotent and not gated by the hash.)
  // Stamp sequentially: a fan-out here would flood the shared pool (the same instance
  // Muninn uses) with one query per changed file and, on a mid-flight failure, leave
  // other marks committing detached after indexRepo has already thrown.
  for (const mark of pendingHashMarks) {
    await markFileIndexed(mark.fileId, mark.language, mark.contentHash);
  }
  // Written before embedding: embeddings are idempotent, and a failed embed must not
  // force the next run to re-extract (and re-embed) everything again.
  if (versionStale) {
    await updateRepoExtractorVersion(repo.id, EXTRACTOR_VERSION);
  }

  // ── Phase 3: Embed any symbols that don't have an embedding yet ──
  // Idempotent — also picks up gaps from interrupted prior runs.
  let newEmbeddings = 0;
  let newEmbeddingFailures = 0;
  if (!options.skipEmbeddings) {
    const embed = await embedSymbols(repo.id);
    newEmbeddings = embed.embedded;
    newEmbeddingFailures = embed.failed;
    if (newEmbeddings > 0 || newEmbeddingFailures > 0) {
      console.log(
        `[yggdrasil] Embedded ${newEmbeddings} symbols (${newEmbeddingFailures} failed) in ${embed.durationMs}ms`,
      );
    }
  }

  const headCommit = await getHeadCommit(config.path);
  if (headCommit) {
    await updateRepoCommit(repo.id, headCommit);
  }

  const totalSymbols = await getRepoSymbolCount(repo.id);
  const durationMs = Math.round(performance.now() - start);

  console.log(
    `[yggdrasil] Indexed ${config.name}: ${changedFiles}/${files.length} files changed, ${totalSymbols} symbols, ${totalEdges} edges rebuilt (whole repo), ${durationMs}ms`,
  );

  return {
    repoName: config.name,
    totalFiles: files.length,
    changedFiles,
    totalSymbols,
    totalEdges,
    newEmbeddings,
    newEmbeddingFailures,
    durationMs,
  };
}

async function getHeadCommit(repoPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim() || null;
  } catch {
    return null;
  }
}
