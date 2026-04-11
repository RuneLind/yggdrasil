import { sql } from "../db/connection.ts";
import { getRepo } from "../db/repos.ts";
import { analyzeImpact } from "./impact.ts";

export interface ChangedSymbol {
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
    via: string; // which changed symbol causes this impact
    confidence: number;
  }[];
}

/** Parse git diff to get changed files and line ranges. */
async function getChangedLines(
  repoPath: string,
  ref?: string,
): Promise<Map<string, Set<number>>> {
  const args = ref
    ? ["git", "diff", ref, "--unified=0", "--no-color"]
    : ["git", "diff", "--unified=0", "--no-color"];

  const proc = Bun.spawn(args, {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();

  const result = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!result.has(currentFile)) result.set(currentFile, new Set());
    } else if (line.startsWith("@@ ") && currentFile) {
      // Parse hunk header: @@ -start,count +start,count @@
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = parseInt(match[2] ?? "1", 10);
        const lines = result.get(currentFile)!;
        for (let i = start; i < start + count; i++) {
          lines.add(i);
        }
      }
    }
  }

  return result;
}

/** Detect which indexed symbols overlap with git changes, then compute impact. */
export async function detectChanges(
  repoName: string,
  ref?: string,
): Promise<ChangeDetectionResult | null> {
  const repo = await getRepo(repoName);
  if (!repo) return null;

  const changedLines = await getChangedLines(repo.path, ref);
  const changedFiles = [...changedLines.keys()];

  if (changedFiles.length === 0) {
    return {
      repo: repoName,
      ref: ref ?? "working tree",
      changedFiles: [],
      changedSymbols: [],
      affectedSymbols: [],
    };
  }

  // Find symbols in changed files that overlap with changed lines
  const changedSymbols: ChangedSymbol[] = [];

  for (const [filePath, lines] of changedLines) {
    const symbols = await sql<ChangedSymbol[]>`
      SELECT s.name, s.qualified_name, s.kind, f.path as file_path
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repoName}
        AND f.path = ${filePath}
        AND (
          s.start_line <= ${Math.max(...lines)} AND
          s.end_line >= ${Math.min(...lines)}
        )
    `;
    changedSymbols.push(...symbols);
  }

  // Compute impact for each changed symbol
  const affectedMap = new Map<string, ChangeDetectionResult["affectedSymbols"][0]>();

  for (const sym of changedSymbols) {
    const impact = await analyzeImpact(sym.qualified_name, { repo: repoName });
    if (!impact) continue;

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

  const result: ChangeDetectionResult = {
    repo: repoName,
    ref: ref ?? "working tree",
    changedFiles,
    changedSymbols,
    affectedSymbols: [...affectedMap.values()].sort(
      (a, b) => b.confidence - a.confidence,
    ),
  };

  return result;
}
