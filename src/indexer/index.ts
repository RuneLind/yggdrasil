import { walkRepo } from "./file-walker.ts";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "./parser.ts";
import { extractSymbols, buildQualifiedNames, toSymbolInserts } from "./symbol-extractor.ts";
import { upsertRepo, updateRepoCommit } from "../db/repos.ts";
import { upsertFile, deleteFileSymbols, deleteStaleFiles } from "../db/files.ts";
import { insertSymbolsBatch, getRepoSymbolCount } from "../db/symbols.ts";
import type { RepoConfig } from "../config.ts";

export interface IndexResult {
  repoName: string;
  totalFiles: number;
  changedFiles: number;
  totalSymbols: number;
  durationMs: number;
}

/** Index a repository — full or incremental based on content hashes. */
export async function indexRepo(config: RepoConfig): Promise<IndexResult> {
  const start = performance.now();

  console.log(`[yggdrasil] Indexing ${config.name} at ${config.path}...`);

  // 1. Initialize parser
  await initParser();

  // 2. Upsert repo record
  const repo = await upsertRepo(config.name, config.path);

  // 3. Discover files
  const files = await walkRepo(config.path, {
    languages: config.languages as SupportedLanguage[],
    exclude: config.exclude,
  });

  console.log(`[yggdrasil] Found ${files.length} source files`);

  // 4. Remove stale files (deleted from repo since last index)
  const currentPaths = files.map((f) => f.relativePath);
  const staleCount = await deleteStaleFiles(repo.id, currentPaths);
  if (staleCount > 0) {
    console.log(`[yggdrasil] Removed ${staleCount} stale files`);
  }

  // 5. Process each file
  let changedFiles = 0;

  for (const file of files) {
    // Upsert file — returns whether content changed
    const { id: fileId, changed } = await upsertFile(
      repo.id,
      file.relativePath,
      file.language,
      file.contentHash,
    );

    if (!changed) continue;
    changedFiles++;

    // Clear old symbols for this file
    await deleteFileSymbols(fileId);

    // Load language + parse
    const language = await loadLanguage(file.language);
    const source = await Bun.file(file.absolutePath).text();
    const tree = parseSource(source, language);

    try {
      // Extract symbols
      const result = extractSymbols(source, tree, file.language, language);
      const qualifiedNames = buildQualifiedNames(result);

      // Insert symbols (first pass — without parent IDs)
      const inserts = toSymbolInserts(
        result,
        fileId,
        qualifiedNames,
        result.symbols.map(() => null), // parent IDs resolved in a separate pass
      );

      if (inserts.length > 0) {
        await insertSymbolsBatch(inserts);
      }
    } finally {
      tree.delete();
    }
  }

  // 6. Update repo commit
  const headCommit = await getHeadCommit(config.path);
  if (headCommit) {
    await updateRepoCommit(repo.id, headCommit);
  }

  const totalSymbols = await getRepoSymbolCount(repo.id);
  const durationMs = Math.round(performance.now() - start);

  console.log(
    `[yggdrasil] Indexed ${config.name}: ${changedFiles}/${files.length} files changed, ${totalSymbols} symbols, ${durationMs}ms`,
  );

  return {
    repoName: config.name,
    totalFiles: files.length,
    changedFiles,
    totalSymbols,
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
