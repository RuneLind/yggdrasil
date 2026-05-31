import { walkRepo } from "./file-walker.ts";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "./parser.ts";
import { extractSymbols, buildQualifiedNames, toSymbolInserts, buildParentLinks } from "./symbol-extractor.ts";
import { extractCallGraph } from "./call-graph.ts";
import { storeImports, resolveImports, deleteImportEdges } from "./import-resolver.ts";
import { resolveAndStoreEdges } from "./edge-resolver.ts";
import { embedSymbols } from "./embedder.ts";
import { warmupEmbeddings } from "../embeddings.ts";
import { upsertRepo, updateRepoCommit } from "../db/repos.ts";
import { ensureFile, markFileIndexed, deleteFileData, deleteStaleFiles } from "../db/files.ts";
import { insertSymbolsBatch, updateSymbolParents, getRepoSymbolCount } from "../db/symbols.ts";
import { sql } from "../db/connection.ts";
import type { RepoConfig } from "../config.ts";

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

  if (options.full) {
    const deleted = await sql`DELETE FROM ci_files WHERE repo_id = ${repo.id}`;
    console.log(`[yggdrasil] Dropped ${deleted.count} existing files (cascades to symbols + edges)`);
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

  // Collect per-file extraction data for Phase 2 edge resolution
  const fileExtractions: {
    fileId: string;
    extraction: ReturnType<typeof extractSymbols>;
    callGraph: ReturnType<typeof extractCallGraph>;
    symbolDbIds: string[];
    qualifiedNames: string[];
  }[] = [];

  // Files whose content_hash is written only after Phase 2, so an interrupted run
  // re-processes them instead of skipping them as symbol-less (see ensureFile).
  const pendingHashMarks: { fileId: string; language: string; contentHash: string }[] = [];

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

      // Extract call graph (calls + inheritance)
      const callGraph = extractCallGraph(source, tree, file.language, extraction);

      fileExtractions.push({
        fileId,
        extraction,
        callGraph,
        symbolDbIds,
        qualifiedNames,
      });
    } finally {
      tree.delete();
    }
  }

  // ── Phase 2: Resolve edges (imports, calls, inheritance) ──
  let totalEdges = 0;

  if (changedFiles > 0) {
    // Delete old import edges and re-resolve
    await deleteImportEdges(repo.id);
    const importEdges = await resolveImports(repo.id);
    totalEdges += importEdges;
    if (importEdges > 0) {
      console.log(`[yggdrasil] Resolved ${importEdges} import edges`);
    }

    // Resolve calls and inheritance per file
    for (const fe of fileExtractions) {
      if (fe.callGraph.calls.length === 0 && fe.callGraph.inheritance.length === 0) continue;
      const edgeCount = await resolveAndStoreEdges(
        fe.fileId,
        repo.id,
        fe.extraction,
        fe.callGraph,
        fe.symbolDbIds,
        fe.qualifiedNames,
      );
      totalEdges += edgeCount;
    }

    if (totalEdges > 0) {
      console.log(`[yggdrasil] Created ${totalEdges} total edges`);
    }
  }

  // Now that symbols, imports, and edges are durably stored, stamp each changed file's
  // content_hash. Crashing before this point leaves files re-processable rather than
  // orphaned as symbol-less. (Embeddings below are idempotent and not gated by the hash.)
  // Marks are independent per file → run concurrently (pool-bounded) instead of serially.
  await Promise.all(
    pendingHashMarks.map((mark) => markFileIndexed(mark.fileId, mark.language, mark.contentHash)),
  );

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
    `[yggdrasil] Indexed ${config.name}: ${changedFiles}/${files.length} files changed, ${totalSymbols} symbols, ${totalEdges} edges, ${durationMs}ms`,
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
