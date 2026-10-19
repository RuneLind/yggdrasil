import { join } from "path";
import { sql } from "../db/connection.ts";
import { getRepo } from "../db/repos.ts";
import { CONTAINER_KINDS } from "../indexer/symbol-extractor.ts";
import { analyzeImpactBySymbolId, type ImpactEntry } from "./impact.ts";
import { parseGitDiff, rangeHits, type BaseRange, type DiffSummary, type LineRange } from "./diff-parse.ts";
import {
  classifyInsertion,
  classifyLine,
  containerPath,
  declarationContinuesAfter,
  findContainerByPath,
  findContainerNode,
  KEEPING,
  parseSourceTree,
  strongest,
  type HitKind,
  type SourceTree,
} from "./container-rule.ts";
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
  /** Containers left out of changedSymbols: no hit inside them keeps them (see selectChangedSymbols). */
  droppedContainers: string[];
  /** Containers in changedSymbols, each with the hit kind that kept it or "floor". */
  keptContainers: Array<{ qualified_name: string; reason: KeepReason }>;
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
type FileSymbol = Spanned & { parent_id: string | null };

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
 * Lines inserted directly above a declaration (annotations, modifiers) sit outside its
 * base-side range, so the insertion point would flag nothing. When the head file shows
 * the inserted lines starting a declaration that continues past them, and a symbol starts
 * on the base line after the insertion point, count the insertion as a hit on that line.
 */
export function attributeDeclarationInsertions(
  ranges: BaseRange[],
  symbols: Array<{ start_line: number }>,
  head: SourceTree,
): BaseRange[] {
  return ranges.map((r) => {
    if (r.end >= r.start || !r.headLines) return r;
    const { start, end } = r.headLines;
    if (!declarationContinuesAfter(head.root, start, end) || !symbols.some((s) => s.start_line === r.start)) return r;
    return { start: r.start, end: r.start, headLines: r.headLines };
  });
}

/** One changed file as the container rule sees it. */
export interface FileSelectionInput<T extends FileSymbol> {
  /** All indexed symbols of the file. */
  symbols: T[];
  /** Exact hit ranges in the index's line numbers (base side: one per hunk, with headLines). */
  ranges: BaseRange[];
  /** Ranges that select the hit symbols when they differ from `ranges` (head side: the bounding range). */
  match?: LineRange[];
  /** The file as indexed: the base blob on the base side, the head content on the head side. */
  indexed: SourceTree | null;
  /** Base side only: the head file, which the hunks' headLines index into. */
  head: SourceTree | null;
}

/** Why a container stayed in changedSymbols: the hit kind that kept it, or the floor. */
export type KeepReason = HitKind | "floor";

/** Hit kinds of range `r` against container `c` without an AST: a member's lines or unknown. */
function spanKinds(c: Spanned, r: BaseRange, symbols: FileSymbol[]): HitKind[] {
  const members = symbols.filter((s) => s.parent_id === c.id && !FIELD_KINDS.has(s.kind));
  if (r.end < r.start) return [members.some((m) => rangeHits(r, m)) ? "member" : "unknown"];
  const kinds: HitKind[] = [];
  for (let line = Math.max(r.start, c.start_line); line <= Math.min(r.end, c.end_line); line++) {
    kinds.push(members.some((m) => m.start_line <= line && m.end_line >= line) ? "member" : "unknown");
  }
  return kinds;
}

/** Hit kinds of range `r` against container `c`: its base-side lines, then its head-side lines. */
function hitKinds<T extends FileSymbol>(c: T, r: BaseRange, file: FileSelectionInput<T>): HitKind[] {
  const node = file.indexed ? findContainerNode(file.indexed.root, c.start_line, c.end_line) : null;
  if (!node) return spanKinds(c, r, file.symbols);
  const kinds: Array<HitKind | null> = [];
  if (r.end < r.start) kinds.push(classifyInsertion(node, r.start - 1));
  else for (let line = Math.max(r.start, c.start_line); line <= Math.min(r.end, c.end_line); line++) kinds.push(classifyLine(node, line));
  const headNode = r.headLines && file.head ? findContainerByPath(file.head.root, containerPath(node)) : null;
  if (headNode && r.headLines) {
    for (let line = r.headLines.start; line <= r.headLines.end; line++) kinds.push(classifyLine(headNode, line));
  }
  return kinds.filter((k): k is HitKind => k !== null);
}

/**
 * The changed symbols of the changed files. A method edit always overlaps its enclosing
 * class too, and the class's blast radius is its import graph, so a container (class,
 * interface, enum, object) is kept only when a hit inside it classifies as a KEEPING kind
 * (see container-rule.ts); otherwise it moves to `dropped`.
 *
 * Floor: when every hit symbol of a file is a dropped container, the innermost container of
 * each hit is kept anyway (reason "floor"). A change the classifier attributes to no member
 * (a comment, a blank line, an inserted method) must not erase the file's blast radius.
 */
export function selectChangedSymbols<T extends FileSymbol>(
  files: Array<FileSelectionInput<T>>,
): { changed: T[]; dropped: T[]; reasons: Map<string, KeepReason> } {
  const changed: T[] = [];
  const dropped: T[] = [];
  const reasons = new Map<string, KeepReason>();
  for (const input of files) {
    const symbols = dropLocalFields(input.symbols);
    const ranges = input.head ? attributeDeclarationInsertions(input.ranges, symbols, input.head) : input.ranges;
    const file: FileSelectionInput<T> = { ...input, symbols, ranges };
    const match = input.match ?? ranges;
    const hit = symbols.filter((s) => match.some((r) => rangeHits(r, s)));
    const fileDropped = new Set<T>();
    for (const c of hit) {
      if (!CONTAINER_KINDS.has(c.kind)) continue;
      const kind = strongest(ranges.filter((r) => rangeHits(r, c)).flatMap((r) => hitKinds(c, r, file)));
      if (kind && KEEPING.has(kind)) reasons.set(c.id, kind);
      else fileDropped.add(c);
    }
    if (hit.every((s) => fileDropped.has(s))) {
      for (const r of ranges) {
        const innermost = [...fileDropped]
          .filter((c) => rangeHits(r, c))
          .sort((a, b) => b.start_line - a.start_line || a.end_line - b.end_line)[0];
        if (innermost) {
          fileDropped.delete(innermost);
          reasons.set(innermost.id, "floor");
        }
      }
    }
    changed.push(...hit.filter((s) => !fileDropped.has(s)));
    dropped.push(...hit.filter((s) => fileDropped.has(s)));
  }
  return { changed, dropped, reasons };
}

type Ranked = {
  edge_kind: string;
  confidence: number;
  depth: number;
  resolution?: string | null;
  via?: string | null;
  via_id?: string | null;
  qualified_name?: string;
  id?: string;
};

const EDGE_ORDER = ["calls", "overrides", "extends", "implements"];
/** Certain resolutions first; PR 4's dispatch kinds after the typed one. */
const RESOLUTION_ORDER = ["local", "static", "super", "typed", "chain"];

/** Position in `order`; an unknown value after every known one; null or missing last of all. */
function orderOf(order: string[], value: string | null | undefined): number {
  if (value === null || value === undefined) return order.length + 1;
  const i = order.indexOf(value);
  return i >= 0 ? i : order.length;
}

/** Compare two optional strings: present before missing, then by code unit. */
function compareText(a: string | null | undefined, b: string | null | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

/**
 * A total order on affected entries, so a merge keeps the same entry whatever the input
 * order: any edge kind above imports; then confidence; edge kind (calls, overrides, extends,
 * implements, others by name); depth; resolution; a direct edge before one `via` an
 * ancestor, then `via`; qualified name; id.
 */
export function compareAffected(a: Ranked, b: Ranked): number {
  const rank = (e: Ranked) => (e.edge_kind === "imports" ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    b.confidence - a.confidence ||
    orderOf(EDGE_ORDER, a.edge_kind) - orderOf(EDGE_ORDER, b.edge_kind) ||
    compareText(a.edge_kind, b.edge_kind) ||
    a.depth - b.depth ||
    orderOf(RESOLUTION_ORDER, a.resolution) - orderOf(RESOLUTION_ORDER, b.resolution) ||
    compareText(a.resolution, b.resolution) ||
    Number(Boolean(a.via)) - Number(Boolean(b.via)) ||
    compareText(a.via, b.via) ||
    compareText(a.via_id, b.via_id) ||
    compareText(a.qualified_name, b.qualified_name) ||
    compareText(a.id, b.id)
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

/** File contents on each side of the diff, read once each. */
class DiffContents {
  private readonly cache = new Map<string, Promise<string | null>>();
  constructor(private readonly repoPath: string, private readonly baseSha: string, private readonly headSha: string | null) {}

  /** The base blob as checked out (`--filters`, like the indexer reads it); null when absent. */
  base(path: string): Promise<string | null> {
    return this.read(`b:${path}`, () => this.blob(this.baseSha, path));
  }

  /** The head commit's blob, or the working-tree file when the head is the working tree. */
  head(path: string): Promise<string | null> {
    return this.read(`h:${path}`, async () => {
      if (this.headSha) return this.blob(this.headSha, path);
      const file = Bun.file(join(this.repoPath, path));
      return (await file.exists()) ? file.text() : null;
    });
  }

  private read(key: string, load: () => Promise<string | null>): Promise<string | null> {
    let p = this.cache.get(key);
    if (!p) this.cache.set(key, (p = load()));
    return p;
  }

  private blob(sha: string, path: string): Promise<string | null> {
    return runGit(this.repoPath, ["git", "cat-file", "--filters", `${sha}:${path}`], `reading ${path}`).catch(() => null);
  }
}

/**
 * Does the index hold `read`'s content for the diff's files? Compares ci_files.content_hash
 * (Bun.hash of the file text, as the file walker computes it) for every indexed path.
 * `verified`: at least one file compared and all match; `mismatched`: files that differ.
 */
async function indexHolds(
  repoId: string,
  paths: string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ verified: boolean; compared: number; mismatched: number }> {
  if (paths.length === 0) return { verified: false, compared: 0, mismatched: 0 };
  const rows = await sql<{ path: string; content_hash: string }[]>`
    SELECT path, content_hash FROM ci_files WHERE repo_id = ${repoId} AND path IN ${sql(paths)}
  `;
  let mismatched = 0;
  for (const row of rows) {
    const text = await read(row.path);
    if (text === null || Bun.hash(text).toString(16) !== row.content_hash) mismatched++;
  }
  return { verified: rows.length > 0 && mismatched === 0, compared: rows.length, mismatched };
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
  const revs = head ? [base, head] : [base];
  const diffText = await timed(tracer, "diff", runGit(repo.path, gitDiffArgs(revs), `git diff ${ref ?? base}`));
  const diff: DiffSummary = parseGitDiff(diffText);
  const contents = new DiffContents(repo.path, base, head);

  // A single ref or no ref diffs against the working tree. By commit, the index holds the
  // base only when it was built at the base and HEAD has moved since (it predates the
  // checkout); with HEAD still at last_commit it may hold working-tree edits, so it is the head.
  const headNow = head === null ? (ref ? await headOrEmptyTree(repo.path) : base) : null;
  const atBase = repo.last_commit === base && (head !== null || repo.last_commit !== headNow);
  // The commit can be right while the content is not: an index built on a dirty tree at the
  // base and committed since holds the head. The content hashes of the diff's files decide.
  const baseCheck = await indexHolds(repo.id, [...diff.baseFiles.keys()], (p) => contents.base(p));
  const headCheck = await indexHolds(repo.id, [...diff.files.keys()], (p) => contents.head(p));
  let side: DiffSide = options?.side ?? (atBase ? "base" : "head");
  if (!options?.side && side === "base" && baseCheck.mismatched > 0 && headCheck.verified) side = "head";
  tracer?.setQuery(repoName, ref, side);
  tracer?.setRefs(base, head);

  const warnings: string[] = [];
  const verified = side === "base" ? baseCheck.verified : headCheck.verified;
  if (verified) {
    // The index holds this side's content for every changed file: commit mismatches do not matter.
  } else if (side === "base" && repo.last_commit !== base) {
    warnings.push(
      `Index of ${repoName} is at ${short(repo.last_commit)}, but the diff's base is ${short(base)}: ` +
        `base-side line ranges may not match the indexed symbols. Reindex at the base, or pass side "head" for an index of the head.`,
    );
  } else if (side === "base" && baseCheck.mismatched > 0) {
    warnings.push(
      `Index of ${repoName} is at the diff's base ${short(base)}, but ${baseCheck.mismatched} of ${baseCheck.compared} changed files ` +
        `hold other content than the base (an index of a dirty tree?): base-side line ranges may not match the indexed symbols. Reindex at the base.`,
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

  // Head side matches one bounding range per file but checks containers against the exact lines.
  const ranges: Map<string, LineRange[]> = side === "base" ? diff.baseFiles : boundingRanges(diff.files);
  const exact: Map<string, BaseRange[]> = side === "base" ? diff.baseFiles : lineRuns(diff.files);
  tracer?.setDiff(ranges.size, diff.addedLines, diff.removedLines);

  const tSymbolStart = performance.now();
  const inputs: Array<FileSelectionInput<ChangedSymbol>> = [];
  const trees: SourceTree[] = [];
  const parse = async (path: string, text: Promise<string | null>) => {
    const content = await text;
    const tree = content === null ? null : await parseSourceTree(path, content);
    if (tree) trees.push(tree);
    return tree;
  };
  let selection: ReturnType<typeof selectChangedSymbols<ChangedSymbol>>;
  try {
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
      if (symbols.length === 0) {
        tracer?.recordFileSymbols(filePath, 0);
        continue;
      }
      const headPath = side === "base" ? diff.headPaths.get(filePath) ?? null : null;
      inputs.push({
        symbols,
        ranges: exact.get(filePath) ?? [],
        match: side === "base" ? undefined : fileRanges,
        indexed: await parse(filePath, side === "base" ? contents.base(filePath) : contents.head(filePath)),
        head: headPath ? await parse(headPath, contents.head(headPath)) : null,
      });
    }
    selection = selectChangedSymbols(inputs);
  } finally {
    for (const t of trees) t.delete();
  }
  const { changed: changedSymbols, dropped, reasons } = selection;
  for (const input of inputs) {
    const path = input.symbols[0].file_path;
    tracer?.recordFileSymbols(path, changedSymbols.filter((s) => s.file_path === path).length + dropped.filter((s) => s.file_path === path).length);
  }
  const droppedContainers = dropped.map((s) => s.qualified_name);
  for (const qn of droppedContainers) tracer?.recordDroppedContainer(qn);
  const keptContainers = changedSymbols
    .filter((s) => reasons.has(s.id))
    .map((s) => ({ qualified_name: s.qualified_name, reason: reasons.get(s.id)! }));
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
    keptContainers,
    affectedSymbols,
  };
}
