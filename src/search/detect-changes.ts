import { sql } from "../db/connection.ts";
import { getRepo } from "../db/repos.ts";
import { analyzeImpact } from "./impact.ts";
import { parseGitDiff, type DiffSummary } from "./diff-parse.ts";
import { timed, type DetectChangesTracer } from "../tracing/trace.ts";

export interface ChangedSymbol {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
}

export interface ChangeDetectionResult {
  repo: string;
  ref: string;
  changedFiles: string[];
  changedSymbols: ChangedSymbol[];
  affectedSymbols: {
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    repo_name: string;
    via: string;
    confidence: number;
  }[];
}

/** Run `git diff --unified=0` and parse it into changed files + touched line ranges. */
async function getChangedLines(repoPath: string, ref?: string): Promise<DiffSummary> {
  // quotePath=false: by default git C-quotes non-ASCII paths ("b/\303\205rsavregning.kt"),
  // which then never match ci_files.path. parseGitDiff also unquotes, as a second guard.
  const git = ["git", "-c", "core.quotePath=false", "diff"];
  const args = ref
    ? [...git, ref, "--unified=0", "--no-color"]
    : [...git, "--unified=0", "--no-color"];

  const proc = Bun.spawn(args, { cwd: repoPath, stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();

  return parseGitDiff(output);
}

/** Detect which indexed symbols overlap with git changes, then compute impact. */
export async function detectChanges(
  repoName: string,
  options?: { ref?: string; tracer?: DetectChangesTracer },
): Promise<ChangeDetectionResult | null> {
  const ref = options?.ref;
  const tracer = options?.tracer;
  tracer?.setQuery(repoName, ref);

  const repo = await getRepo(repoName);
  if (!repo) return null;

  const diff = await timed(tracer, "diff", getChangedLines(repo.path, ref));
  tracer?.setDiff(diff.files.size, diff.addedLines, diff.removedLines);

  const changedFiles = [...diff.files.keys()];

  if (changedFiles.length === 0) {
    tracer?.setTotals(0, 0);
    return {
      repo: repoName,
      ref: ref ?? "working tree",
      changedFiles: [],
      changedSymbols: [],
      affectedSymbols: [],
    };
  }

  const tSymbolStart = performance.now();
  const changedSymbols: ChangedSymbol[] = [];

  for (const [filePath, lines] of diff.files) {
    let minLine = Infinity, maxLine = -Infinity;
    for (const l of lines) {
      if (l < minLine) minLine = l;
      if (l > maxLine) maxLine = l;
    }
    if (minLine === Infinity) {
      tracer?.recordFileSymbols(filePath, 0);
      continue;
    }
    const symbols = await sql<ChangedSymbol[]>`
      SELECT s.id, s.name, s.qualified_name, s.kind, f.path as file_path
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repoName}
        AND f.path = ${filePath}
        AND s.start_line <= ${maxLine}
        AND s.end_line >= ${minLine}
    `;
    tracer?.recordFileSymbols(filePath, symbols.length);
    changedSymbols.push(...symbols);
  }
  tracer?.recordTiming("symbolResolution", performance.now() - tSymbolStart);

  const tImpactStart = performance.now();
  const affectedMap = new Map<string, ChangeDetectionResult["affectedSymbols"][0]>();

  for (const sym of changedSymbols) {
    const impact = await analyzeImpact(sym.qualified_name, { repo: repoName });
    if (!impact) continue;

    tracer?.recordImpact(sym.id, sym.qualified_name, impact.affected.length);

    for (const entry of impact.affected) {
      const key = entry.qualified_name;
      const existing = affectedMap.get(key);
      if (!existing || entry.confidence > existing.confidence) {
        affectedMap.set(key, {
          name: entry.name,
          qualified_name: entry.qualified_name,
          kind: entry.kind,
          file_path: entry.file_path,
          repo_name: entry.repo_name,
          via: sym.qualified_name,
          confidence: entry.confidence,
        });
      }
    }
  }
  tracer?.recordTiming("impact", performance.now() - tImpactStart);

  const affectedSymbols = [...affectedMap.values()].sort((a, b) => b.confidence - a.confidence);
  tracer?.setTotals(changedSymbols.length, affectedSymbols.length);

  return {
    repo: repoName,
    ref: ref ?? "working tree",
    changedFiles,
    changedSymbols,
    affectedSymbols,
  };
}
