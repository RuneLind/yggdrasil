import { sql } from "../db/connection.ts";
import { getRepo } from "../db/repos.ts";
import { CONTAINER_KINDS } from "../indexer/symbol-extractor.ts";
import { analyzeImpactBySymbolId, type ImpactEntry } from "./impact.ts";
import { parseGitDiff, rangeHits, type BaseRange, type LineRange } from "./diff-parse.ts";
import { timed, type DetectChangesTracer } from "../tracing/trace.ts";

/**
 * Which side of the diff the index holds, and so which hunk lines to intersect:
 * - "base": old-side ranges keyed on the `---` path. A PR review asks who calls what
 *   the PR changes, and those callers live on the base.
 * - "head": new-side lines keyed on the `+++` path.
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

export interface AffectedSymbol extends ImpactEntry {
  /** Every changed symbol whose blast radius reaches this entry (qualified names, one per symbol id). */
  changed_symbols: string[];
}

export interface ChangeDetectionResult {
  repo: string;
  ref: string;
  side: DiffSide;
  /** Resolved base commit: HEAD when no ref is given, the empty tree in a repo without commits. */
  base: string;
  /** Resolved head commit; null when the diff's head is the working tree. */
  head: string | null;
  warnings: string[];
  changedFiles: string[];
  changedSymbols: ChangedSymbol[];
  /** Containers left out of changedSymbols because no hit changes the container itself (see changesContainer). */
  droppedContainers: string[];
  affectedSymbols: AffectedSymbol[];
}

/** A ref that git cannot resolve, or a git command that failed. */
export class DetectChangesError extends Error {
  constructor(message: string, readonly repoPath?: string) {
    super(message);
  }
}

/** argv for the `git diff` that detectChanges runs; exported so a test can pin the flags. */
export function gitDiffArgs(revs: string[]): string[] {
  // Each flag overrides a config that would change the output parseGitDiff reads:
  // core.quotePath (C-quoted non-ASCII paths never match ci_files.path), diff.noprefix /
  // diff.mnemonicPrefix (the a/ b/ prefixes), textconv and external drivers, and
  // diff.renames=false (a rename turns into a delete + add of the whole file), and
  // diff.interHunkContext (merges nearby hunks, so a base range spans unchanged lines).
  return [
    "git", "-c", "core.quotePath=false", "diff",
    "--unified=0", "--inter-hunk-context=0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
    "--no-textconv", "--no-ext-diff", "-M",
    "--end-of-options", ...revs, "--",
  ];
}

async function runGit(repoPath: string, args: string[], what: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new DetectChangesError(`${what} failed in ${repoPath}${err.trim() ? `: ${err.trim()}` : ""}`, repoPath);
  }
  return out;
}

/** Resolve a revision to a commit sha. Resolved first and peeled second, so `:/text` keeps its text intact. */
async function revParse(repoPath: string, rev: string): Promise<string> {
  const what = `resolving ref '${rev}'`;
  const sha = (await runGit(repoPath, ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", rev], what)).trim();
  return (await runGit(repoPath, ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`], what)).trim();
}

/** HEAD's commit, or the empty tree in a repo whose HEAD names a branch without commits. */
async function headOrEmptyTree(repoPath: string): Promise<string> {
  try {
    return await revParse(repoPath, "HEAD");
  } catch (err) {
    const unborn = await runGit(repoPath, ["git", "symbolic-ref", "--quiet", "HEAD"], "reading HEAD").then(
      () => true,
      () => false,
    );
    if (!unborn) throw err;
    return (await runGit(repoPath, ["git", "hash-object", "-t", "tree", "/dev/null"], "hashing the empty tree")).trim();
  }
}

/** `X^!` → `X^..X`, `X^-n` → `X^n..X` (n defaults to 1), as git reads them. */
function expandParentShorthand(ref: string): string {
  if (ref.endsWith("^!")) {
    const x = ref.slice(0, -2);
    return `${x}^..${x}`;
  }
  const m = ref.match(/^(.+)\^-(\d*)$/);
  return m ? `${m[1]}^${m[2] || "1"}..${m[1]}` : ref;
}

/**
 * The commits on each side of the diff for `ref`: `a...b` → (merge-base, b), `a..b` → (a, b),
 * `X^!` / `X^-n` → (X's parent, X), `a` or `:/text` → (a, working tree), none → (HEAD,
 * working tree). An empty side of a range is HEAD, as in git. Throws DetectChangesError for
 * a ref git cannot resolve and for a flag-style ref (`--cached`, `-R`, …).
 */
export async function resolveDiffSides(repoPath: string, ref?: string): Promise<{ base: string; head: string | null }> {
  if (!ref) return { base: await headOrEmptyTree(repoPath), head: null };
  if (ref.startsWith("-")) throw new DetectChangesError(`'${ref}' is not a revision: flag-style refs are not supported`);
  if (ref.startsWith(":/")) return { base: await revParse(repoPath, ref), head: null };
  const range = expandParentShorthand(ref);
  const threeDot = range.indexOf("...");
  if (threeDot >= 0) {
    const a = await revParse(repoPath, range.slice(0, threeDot) || "HEAD");
    const b = await revParse(repoPath, range.slice(threeDot + 3) || "HEAD");
    const base = (await runGit(repoPath, ["git", "merge-base", a, b], `merge-base of '${ref}'`)).trim();
    return { base, head: b };
  }
  const twoDot = range.indexOf("..");
  if (twoDot >= 0) {
    return {
      base: await revParse(repoPath, range.slice(0, twoDot) || "HEAD"),
      head: await revParse(repoPath, range.slice(twoDot + 2) || "HEAD"),
    };
  }
  return { base: await revParse(repoPath, range), head: null };
}

/** Head-side matching: one bounding range over a file's touched lines. */
function boundingRanges(files: Map<string, Set<number>>): Map<string, LineRange[]> {
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

/** Head-side hit lines as runs of consecutive lines, for the container check. */
function lineRuns(files: Map<string, Set<number>>): Map<string, LineRange[]> {
  const out = new Map<string, LineRange[]>();
  for (const [path, lines] of files) {
    const runs: LineRange[] = [];
    for (const l of [...lines].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && last.end === l - 1) last.end = l;
      else runs.push({ start: l, end: l });
    }
    out.set(path, runs);
  }
  return out;
}

const FIELD_KINDS: ReadonlySet<string> = new Set(["field", "property"]);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(["method", "function", "constructor"]);

type Spanned = { id: string; kind: string; start_line: number; end_line: number };

/** Drop field/property symbols that lie inside a callable: function-local vals, not members. */
export function dropLocalFields<T extends Spanned>(symbols: T[]): T[] {
  const callables = symbols.filter((s) => CALLABLE_KINDS.has(s.kind));
  return symbols.filter(
    (s) =>
      !FIELD_KINDS.has(s.kind) ||
      !callables.some((c) => c.id !== s.id && c.start_line <= s.start_line && c.end_line >= s.end_line),
  );
}

/**
 * An annotation inserted directly above a symbol sits outside that symbol's base-side range,
 * so the insertion point would flag nothing. When every non-blank inserted line starts with
 * `@` and a symbol starts on the line after the insertion point, count it as a hit on that line.
 */
export function attributeAnnotationInsertions(ranges: BaseRange[], symbols: Array<{ start_line: number }>): BaseRange[] {
  return ranges.map((r) => {
    if (r.end >= r.start || !r.inserted) return r;
    const text = r.inserted.map((l) => l.trim()).filter((l) => l !== "");
    const annotationOnly = text.length > 0 && text.every((l) => l.startsWith("@"));
    return annotationOnly && symbols.some((s) => s.start_line === r.start) ? { start: r.start, end: r.start } : r;
  });
}

/** Not blank and not comment-only. */
function isCode(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
}

const KOTLIN_PROPERTY = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:[a-z]+\s+)*(?:val|var)\s/;
const JAVA_FIELD = /^(?:@\w+(?:\([^)]*\))?\s+)*[\w.<>[\],? ]+\s+\w+\s*(?:=.*)?;$/;

/** A Kotlin property without initializer whose next line is a getter holds no state. */
function isComputedProperty(t: string, next: string | undefined): boolean {
  return KOTLIN_PROPERTY.test(t) && !t.includes("=") && /^get\(\)/.test(next ?? "");
}

/**
 * Does inserted text declare a field or property at its own top level (not inside a body)?
 * A computed property counts as a method.
 */
function declaresField(lines: string[]): boolean {
  const trimmed = lines.map((l) => l.trim()).filter((t) => t !== "");
  let depth = 0;
  for (const [i, t] of trimmed.entries()) {
    const field = KOTLIN_PROPERTY.test(t) || (JAVA_FIELD.test(t) && !/^(return|throw)\b/.test(t));
    if (depth === 0 && field && !isComputedProperty(t, trimmed[i + 1])) return true;
    depth += (t.match(/{/g)?.length ?? 0) - (t.match(/}/g)?.length ?? 0);
  }
  return false;
}

/**
 * Does hit `r` change `container` itself rather than only its members? A changed or deleted
 * old-side line outside every member counts unless it is blank or comment-only (text from
 * `removed`; a range without text counts every such line). An insertion outside the members
 * counts when it adds code before `bodyStart`, the first child, fields included (header,
 * primary constructor), or declares a field; a method inserted between members does not.
 */
function changesContainer(r: BaseRange, container: Spanned, members: Spanned[], bodyStart: number): boolean {
  if (r.end < r.start) {
    if (members.some((m) => rangeHits(r, m))) return false;
    const inserted = r.inserted ?? [];
    return (r.start <= bodyStart && inserted.some(isCode)) || declaresField(inserted);
  }
  const from = Math.max(r.start, container.start_line);
  const to = Math.min(r.end, container.end_line);
  for (let line = from; line <= to; line++) {
    if (members.some((m) => m.start_line <= line && m.end_line >= line)) continue;
    const text = r.removed?.[line - r.start];
    if (text === undefined || isCode(text)) return true;
  }
  return false;
}

/**
 * A method edit always overlaps its enclosing class too, and the class's blast radius is
 * its import graph. Drop a container hit by `symbols` unless a range changes the container
 * itself (see changesContainer). `fileSymbols` are all symbols of the changed files, so the
 * members include methods the diff did not hit.
 */
export function dropEnclosingContainers<T extends Spanned & { parent_id: string | null; file_path: string }>(
  symbols: T[],
  ranges: Map<string, BaseRange[]>,
  fileSymbols: T[] = symbols,
): { kept: T[]; dropped: T[] } {
  const isDropped = (c: T) => {
    if (!CONTAINER_KINDS.has(c.kind)) return false;
    const children = fileSymbols.filter((s) => s.parent_id === c.id);
    const members = children.filter((s) => !FIELD_KINDS.has(s.kind));
    if (members.length === 0) return false;
    const bodyStart = Math.min(...children.map((s) => s.start_line));
    const hits = (ranges.get(c.file_path) ?? []).filter((r) => rangeHits(r, c));
    return !hits.some((r) => changesContainer(r, c, members, bodyStart));
  };
  const dropped = new Set(symbols.filter(isDropped));
  return { kept: symbols.filter((s) => !dropped.has(s)), dropped: [...dropped] };
}

type Ranked = { edge_kind: string; confidence: number; depth: number; qualified_name?: string };

/** Calls and overrides before imports; then confidence; then calls before overrides, depth, qualified name. */
export function compareAffected(a: Ranked, b: Ranked): number {
  const rank = (e: Ranked) => (e.edge_kind === "imports" ? 1 : 0);
  const kind = (e: Ranked) => (e.edge_kind === "calls" ? 0 : e.edge_kind === "overrides" ? 1 : 2);
  return (
    rank(a) - rank(b) ||
    b.confidence - a.confidence ||
    kind(a) - kind(b) ||
    a.depth - b.depth ||
    (a.qualified_name ?? "").localeCompare(b.qualified_name ?? "")
  );
}

/**
 * One entry per affected symbol id across all changed symbols' blast radii: the best entry
 * by compareAffected (so a call wins over an import even at lower confidence), listing every
 * changed symbol that reached it. Sorted by compareAffected.
 */
export function mergeAffected(
  perChanged: Array<{ changed: { id: string; qualified_name: string }; affected: ImpactEntry[] }>,
): AffectedSymbol[] {
  const best = new Map<string, ImpactEntry>();
  const reachedBy = new Map<string, Map<string, string>>();
  for (const { changed, affected } of perChanged) {
    for (const entry of affected) {
      const existing = best.get(entry.id);
      if (!existing || compareAffected(entry, existing) < 0) best.set(entry.id, entry);
      const via = reachedBy.get(entry.id) ?? new Map<string, string>();
      via.set(changed.id, changed.qualified_name);
      reachedBy.set(entry.id, via);
    }
  }
  return [...best.values()]
    .map((entry) => ({ ...entry, changed_symbols: [...reachedBy.get(entry.id)!.values()] }))
    .sort(compareAffected);
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
  tracer?.setQuery(repoName, ref, options?.side);

  const repo = await getRepo(repoName);
  if (!repo) return null;

  const { base, head } = await resolveDiffSides(repo.path, ref);
  // A single ref or no ref diffs against the working tree. The index holds the base only
  // when it was built at the base and HEAD has moved since (it predates the checkout);
  // with HEAD still at last_commit it may hold working-tree edits, so it is the head.
  const headNow = head === null ? (ref ? await headOrEmptyTree(repo.path) : base) : null;
  const atBase = repo.last_commit === base && (head !== null || repo.last_commit !== headNow);
  const side: DiffSide = options?.side ?? (atBase ? "base" : "head");
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
  } else if (side === "head" && headNow && repo.last_commit !== headNow) {
    warnings.push(
      `Index of ${repoName} is at ${short(repo.last_commit)}, but the working tree is on ${short(headNow)}: ` +
        `head-side line ranges may not match the indexed symbols. Reindex the working tree, or pass side "base" for an index of the base.`,
    );
  }
  for (const w of warnings) tracer?.recordWarning(w);

  const revs = head ? [base, head] : [base];
  const diffText = await timed(tracer, "diff", runGit(repo.path, gitDiffArgs(revs), `git diff ${ref ?? base}`));
  const diff = parseGitDiff(diffText);
  // Head side matches one bounding range per file but checks containers against the exact lines.
  const ranges: Map<string, LineRange[]> = side === "base" ? diff.baseFiles : boundingRanges(diff.files);
  const containerRanges: Map<string, BaseRange[]> = side === "base" ? new Map() : lineRuns(diff.files);
  tracer?.setDiff(ranges.size, diff.addedLines, diff.removedLines);

  const tSymbolStart = performance.now();
  const overlapping: ChangedSymbol[] = [];
  const fileSymbols: ChangedSymbol[] = [];
  for (const [filePath, rawRanges] of ranges) {
    if (rawRanges.length === 0) {
      tracer?.recordFileSymbols(filePath, 0);
      continue;
    }
    const symbols = dropLocalFields(
      await sql<ChangedSymbol[]>`
        SELECT s.id, s.name, s.qualified_name, s.kind, f.path AS file_path,
          s.start_line, s.end_line, s.parent_id
        FROM ci_symbols s
        JOIN ci_files f ON f.id = s.file_id
        WHERE f.repo_id = ${repo.id} AND f.path = ${filePath}
        ORDER BY s.start_line, s.id
      `,
    );
    const fileRanges = side === "base" ? attributeAnnotationInsertions(rawRanges, symbols) : rawRanges;
    if (side === "base") containerRanges.set(filePath, fileRanges);
    fileSymbols.push(...symbols);
    const hit = symbols.filter((s) => fileRanges.some((r) => rangeHits(r, s)));
    tracer?.recordFileSymbols(filePath, hit.length);
    overlapping.push(...hit);
  }
  const { kept: changedSymbols, dropped } = dropEnclosingContainers(overlapping, containerRanges, fileSymbols);
  const droppedContainers = dropped.map((s) => s.qualified_name);
  for (const qn of droppedContainers) tracer?.recordDroppedContainer(qn);
  tracer?.recordTiming("symbolResolution", performance.now() - tSymbolStart);

  const tImpactStart = performance.now();
  const perChanged: Parameters<typeof mergeAffected>[0] = [];
  for (const sym of changedSymbols) {
    const impact = await analyzeImpactBySymbolId(sym.id);
    if (!impact) continue;
    tracer?.recordImpact(sym.id, sym.qualified_name, impact.affected.length);
    perChanged.push({ changed: sym, affected: impact.affected });
  }
  const affectedSymbols = mergeAffected(perChanged);
  tracer?.recordTiming("impact", performance.now() - tImpactStart);

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
