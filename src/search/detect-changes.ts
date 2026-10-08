import { sql } from "../db/connection.ts";
import { getRepo } from "../db/repos.ts";
import type { EdgeResolution } from "../db/edges.ts";
import { CONTAINER_KINDS } from "../indexer/symbol-extractor.ts";
import { analyzeImpactBySymbolId } from "./impact.ts";
import type { Archetype } from "./archetype.ts";
import { parseGitDiff, rangeHits, type DiffSummary, type LineRange } from "./diff-parse.ts";
import { timed, type DetectChangesTracer } from "../tracing/trace.ts";

/**
 * Which side of the diff the index holds, and so which hunk lines to intersect:
 * - "base": old-side ranges keyed on the `---` path (review mode, D1). A PR review
 *   asks who calls what the PR changes, and those callers live on the base.
 * - "head": new-side lines keyed on the `+++` path (the pre-D1 behavior).
 */
export type DiffSide = "base" | "head";

export interface ChangedSymbol {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  parent_id: string | null;
}

export interface AffectedSymbol {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  repo_name: string;
  depth: number;
  /** Kind of the edge that reached this symbol: calls, overrides, imports, extends, … */
  edge_kind: string;
  resolution: EdgeResolution | null;
  archetype: Archetype;
  /** The changed symbol whose blast radius produced this entry. */
  via: string;
  confidence: number;
}

export interface ChangeDetectionResult {
  repo: string;
  ref: string;
  side: DiffSide;
  /** Resolved base commit (HEAD when no ref is given). */
  base: string;
  /** Resolved head commit; null when the diff's head is the working tree. */
  head: string | null;
  warnings: string[];
  changedFiles: string[];
  changedSymbols: ChangedSymbol[];
  /** Containers left out of changedSymbols because a member of theirs changed. */
  droppedContainers: string[];
  affectedSymbols: AffectedSymbol[];
}

/** A ref that git cannot resolve, or a git command that failed. */
export class DetectChangesError extends Error {}

/** argv for the `git diff` that getChangedLines runs; exported so a test can pin the flags. */
export function gitDiffArgs(ref?: string): string[] {
  // quotePath=false: by default git C-quotes non-ASCII paths ("b/\303\205rsavregning.kt"),
  // which then never match ci_files.path. parseGitDiff also unquotes, as a second guard.
  const git = ["git", "-c", "core.quotePath=false", "diff"];
  return ref ? [...git, ref, "--unified=0", "--no-color"] : [...git, "--unified=0", "--no-color"];
}

async function runGit(repoPath: string, args: string[], what: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new DetectChangesError(`${what} failed in ${repoPath}${err.trim() ? `: ${err.trim()}` : ""}`);
  }
  return out;
}

async function revParse(repoPath: string, rev: string): Promise<string> {
  const out = await runGit(
    repoPath,
    ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    `resolving ref '${rev}'`,
  );
  return out.trim();
}

/**
 * The commits on each side of `git diff <ref>`: `a...b` → (merge-base, b), `a..b` → (a, b),
 * `a` → (a, working tree), none → (HEAD, working tree). An empty side of a range is HEAD,
 * as in git. Throws DetectChangesError for a ref git cannot resolve.
 */
export async function resolveDiffSides(repoPath: string, ref?: string): Promise<{ base: string; head: string | null }> {
  if (!ref) return { base: await revParse(repoPath, "HEAD"), head: null };
  const threeDot = ref.indexOf("...");
  if (threeDot >= 0) {
    const a = await revParse(repoPath, ref.slice(0, threeDot) || "HEAD");
    const b = await revParse(repoPath, ref.slice(threeDot + 3) || "HEAD");
    const base = (await runGit(repoPath, ["git", "merge-base", a, b], `merge-base of '${ref}'`)).trim();
    return { base, head: b };
  }
  const twoDot = ref.indexOf("..");
  if (twoDot >= 0) {
    return {
      base: await revParse(repoPath, ref.slice(0, twoDot) || "HEAD"),
      head: await revParse(repoPath, ref.slice(twoDot + 2) || "HEAD"),
    };
  }
  return { base: await revParse(repoPath, ref), head: null };
}

/** Run `git diff --unified=0` and parse it into changed files + touched line ranges. */
async function getChangedLines(repoPath: string, ref?: string): Promise<DiffSummary> {
  return parseGitDiff(await runGit(repoPath, gitDiffArgs(ref), `git diff ${ref ?? ""}`.trim()));
}

/** Head mode keeps its pre-D1 matching: one bounding range over a file's touched lines. */
function headRanges(files: Map<string, Set<number>>): Map<string, LineRange[]> {
  const out = new Map<string, LineRange[]>();
  for (const [path, lines] of files) {
    let start = Infinity, end = -Infinity;
    for (const l of lines) {
      if (l < start) start = l;
      if (l > end) end = l;
    }
    out.set(path, lines.size === 0 ? [] : [{ start, end }]);
  }
  return out;
}

const FIELD_KINDS: ReadonlySet<string> = new Set(["field", "property"]);

/**
 * G7: a method edit always overlaps its enclosing class too, and the class's blast radius
 * is its import graph. Drop a container when a non-field member of it also changed; keep
 * it when only its header or fields did.
 */
export function dropEnclosingContainers<T extends { id: string; kind: string; parent_id: string | null }>(
  symbols: T[],
): { kept: T[]; dropped: T[] } {
  const hasChangedMember = new Set(
    symbols.filter((s) => s.parent_id && !FIELD_KINDS.has(s.kind)).map((s) => s.parent_id),
  );
  const isDropped = (s: T) => CONTAINER_KINDS.has(s.kind) && hasChangedMember.has(s.id);
  return { kept: symbols.filter((s) => !isDropped(s)), dropped: symbols.filter(isDropped) };
}

/** Calls (and overrides, which PR 4 adds) before imports; then confidence, then depth. */
export function compareAffected(
  a: { edge_kind: string; confidence: number; depth: number },
  b: { edge_kind: string; confidence: number; depth: number },
): number {
  const rank = (e: { edge_kind: string }) => (e.edge_kind === "imports" ? 1 : 0);
  return rank(a) - rank(b) || b.confidence - a.confidence || a.depth - b.depth;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "no recorded commit";
}

/** Detect which indexed symbols overlap with git changes, then compute impact. */
export async function detectChanges(
  repoName: string,
  options?: { ref?: string; side?: DiffSide; tracer?: DetectChangesTracer },
): Promise<ChangeDetectionResult | null> {
  const ref = options?.ref || undefined;
  const tracer = options?.tracer;

  const repo = await getRepo(repoName);
  if (!repo) {
    tracer?.setQuery(repoName, ref, options?.side);
    return null;
  }

  const { base, head } = await resolveDiffSides(repo.path, ref);
  // Without a ref the index may hold uncommitted edits, so last_commit cannot prove
  // it is at the base; only a ref switches the default to review mode.
  const side: DiffSide = options?.side ?? (ref && repo.last_commit === base ? "base" : "head");
  tracer?.setQuery(repoName, ref, side);
  tracer?.setRefs(base, head);

  const warnings: string[] = [];
  if (side === "base" && repo.last_commit !== base) {
    warnings.push(
      `Index of ${repoName} is at ${short(repo.last_commit)}, but the diff's base is ${short(base)}: ` +
        `base-side line ranges may not match the indexed symbols. Reindex at the base, or pass side "head" for an index of the head.`,
    );
  } else if (side === "head" && head && repo.last_commit !== head) {
    warnings.push(
      `Index of ${repoName} is at ${short(repo.last_commit)}, but the diff's head is ${short(head)}: ` +
        `head-side line ranges may not match the indexed symbols. Reindex at the head, or pass side "base" for an index of the base.`,
    );
  }
  for (const w of warnings) tracer?.recordWarning(w);

  const diff = await timed(tracer, "diff", getChangedLines(repo.path, ref));
  const ranges = side === "base" ? diff.baseFiles : headRanges(diff.files);
  tracer?.setDiff(ranges.size, diff.addedLines, diff.removedLines);

  const tSymbolStart = performance.now();
  const overlapping: ChangedSymbol[] = [];
  for (const [filePath, fileRanges] of ranges) {
    if (fileRanges.length === 0) {
      tracer?.recordFileSymbols(filePath, 0);
      continue;
    }
    const symbols = await sql<ChangedSymbol[]>`
      SELECT s.id, s.name, s.qualified_name, s.kind, f.path AS file_path,
        s.start_line, s.end_line, s.parent_id
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      WHERE f.repo_id = ${repo.id} AND f.path = ${filePath}
      ORDER BY s.start_line, s.id
    `;
    const hit = symbols.filter((s) => fileRanges.some((r) => rangeHits(r, s)));
    tracer?.recordFileSymbols(filePath, hit.length);
    overlapping.push(...hit);
  }
  const { kept: changedSymbols, dropped } = dropEnclosingContainers(overlapping);
  const droppedContainers = dropped.map((s) => s.qualified_name);
  for (const qn of droppedContainers) tracer?.recordDroppedContainer(qn);
  tracer?.recordTiming("symbolResolution", performance.now() - tSymbolStart);

  const tImpactStart = performance.now();
  const affectedMap = new Map<string, AffectedSymbol>();
  for (const sym of changedSymbols) {
    const impact = await analyzeImpactBySymbolId(sym.id);
    if (!impact) continue;
    tracer?.recordImpact(sym.id, sym.qualified_name, impact.affected.length);

    for (const entry of impact.affected) {
      const candidate: AffectedSymbol = {
        id: entry.id,
        name: entry.name,
        qualified_name: entry.qualified_name,
        kind: entry.kind,
        file_path: entry.file_path,
        repo_name: entry.repo_name,
        depth: entry.depth,
        edge_kind: entry.edge_kind,
        resolution: entry.resolution,
        archetype: entry.archetype,
        via: sym.qualified_name,
        confidence: entry.confidence,
      };
      const existing = affectedMap.get(entry.id);
      if (!existing || compareAffected(candidate, existing) < 0) affectedMap.set(entry.id, candidate);
    }
  }
  tracer?.recordTiming("impact", performance.now() - tImpactStart);

  const affectedSymbols = [...affectedMap.values()].sort(compareAffected);
  tracer?.setTotals(changedSymbols.length, affectedSymbols.length);
  for (const a of affectedSymbols) tracer?.countAffectedEdgeKind(a.edge_kind);

  return {
    repo: repoName,
    ref: ref ?? "working tree",
    side,
    base,
    head,
    warnings,
    changedFiles: [...ranges.keys()],
    changedSymbols,
    droppedContainers,
    affectedSymbols,
  };
}
