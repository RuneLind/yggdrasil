/**
 * Pure parser for `git diff --unified=0` output. Kept free of I/O so it can be
 * table-driven over fixture diff text without spawning git or touching a DB.
 *
 * Produces, per changed file, the line numbers a change touched on each side: new-side
 * lines keyed on the new path (`files`, matched against an index of the diff's head) and
 * one old-side range per hunk keyed on the old path (`baseFiles`, matched against an
 * index of the base), plus the added/removed totals. detect-changes intersects them with
 * the indexed symbols' [start_line, end_line] to find which symbols a change hit.
 */

/**
 * Inclusive line span. `end < start` is the empty span between lines `end` and `start`:
 * an insertion point. rangeHits then requires a symbol to contain both neighbouring
 * lines, so code inserted just after a method's closing brace does not flag that
 * method, but code inserted inside its body does.
 */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * An old-side hunk range. `removed` holds the text of its old-side lines (start..end);
 * an insertion-only hunk keeps its inserted (new-side) lines in `inserted` instead.
 */
export interface BaseRange extends LineRange {
  inserted?: string[];
  removed?: string[];
}

export interface DiffSummary {
  /** Head side: new path → touched new-side lines (old-side for pure deletions). */
  files: Map<string, Set<number>>;
  /**
   * Base side: old path → one old-side range per hunk. Added files
   * (`--- /dev/null`) are absent, since an index of the base holds no symbols for them.
   */
  baseFiles: Map<string, BaseRange[]>;
  addedLines: number;
  removedLines: number;
}

/** git emits "a/<path>" (old) and "b/<path>" (new) by default; strip that prefix. */
function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  "\\": 0x5c, '"': 0x22, t: 0x09, n: 0x0a, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b,
};

/**
 * Undo git's C-style path quoting (`core.quotePath`, on by default): `"b/\303\205rs.kt"`.
 * Octal escapes are UTF-8 *bytes*, so they are collected into a byte buffer and decoded
 * together; decoding each escape to its own char would turn Å into "Ã\x85".
 * detect-changes runs git with quotePath off; this is the guard for diffs from elsewhere.
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  // Code points, not UTF-16 units: with quotePath off git still quotes a path that
  // contains `"` or a control char, and leaves its non-ASCII text (emoji included) raw.
  const chars = Array.from(path.slice(1, -1));
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== "\\" || i + 1 >= chars.length) {
      bytes.push(...utf8.encode(ch));
      continue;
    }
    const next = chars[i + 1];
    const octal = chars.slice(i + 1, i + 4).join("");
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
      bytes.push(SIMPLE_ESCAPES[next]);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Header path → repo-relative path. git appends a TAB to a `---`/`+++` path that holds a
 * space (`+++ b/a b.kt\t`, `+++ "b/\303\205 b.kt"\t`), so drop that first; then unquote,
 * since the a/ b/ prefix sits inside the quotes.
 */
function headerPath(raw: string): string {
  return stripDiffPrefix(unquoteGitPath(raw.endsWith("\t") ? raw.slice(0, -1) : raw));
}

/**
 * Parse unified-diff text (expects `--unified=0`, but tolerates context counts).
 *
 * Header detection is anchored on the `diff --git` line so a *deleted code line*
 * that happens to read `-- foo` (rendered as `--- foo` in the diff body) can never
 * be mistaken for a `--- a/file` header — `---`/`+++` are only consumed while we're
 * in a file header, never inside a hunk body.
 *
 * Deletions:
 *  - A deletion-only hunk (`@@ -10,5 +9,0 @@`) contributes no `+`side lines, so its
 *    region is taken from the `-`side (old line numbers, which match the still-indexed
 *    pre-deletion file). Without this, deleting a method reports zero blast radius.
 *  - A wholly deleted file (`+++ /dev/null`) is attributed to its *old* path so its
 *    symbols (still in the index until re-index) are flagged, instead of leaking the
 *    hunks onto the previously-seen file.
 */
export function parseGitDiff(text: string): DiffSummary {
  const files = new Map<string, Set<number>>();
  const baseFiles = new Map<string, BaseRange[]>();
  let addedLines = 0;
  let removedLines = 0;

  let currentFile: string | null = null;
  let currentOldFile: string | null = null;
  let pendingOldFile: string | null = null;
  let inHeader = false;
  let inserting: string[] | null = null;
  let removing: string[] | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      inserting = null;
      removing = null;
      currentFile = null;
      currentOldFile = null;
      pendingOldFile = null;
      continue;
    }

    if (inHeader && line.startsWith("--- ")) {
      // Old-side path. "/dev/null" means a newly added file (no old path).
      pendingOldFile = line.startsWith("--- /dev/null") ? null : headerPath(line.slice(4));
      continue;
    }

    if (inHeader && line.startsWith("+++ ")) {
      // New-side path. "/dev/null" means a deleted file — fall back to the old path.
      currentFile = line.startsWith("+++ /dev/null") ? pendingOldFile : headerPath(line.slice(4));
      if (currentFile && !files.has(currentFile)) files.set(currentFile, new Set());
      currentOldFile = pendingOldFile;
      if (currentOldFile && !baseFiles.has(currentOldFile)) baseFiles.set(currentOldFile, []);
      inHeader = false;
      continue;
    }

    if (inserting && line.startsWith("+")) {
      inserting.push(line.slice(1));
      continue;
    }

    if (removing && line.startsWith("-")) {
      removing.push(line.slice(1));
      continue;
    }

    if (line.startsWith("@@ ") && currentFile) {
      inserting = null;
      removing = null;
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@  (counts default to 1)
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      const removedStart = parseInt(match[1], 10);
      const removed = parseInt(match[2] ?? "1", 10);
      const addedStart = parseInt(match[3], 10);
      const added = parseInt(match[4] ?? "1", 10);
      addedLines += added;
      removedLines += removed;

      const lines = files.get(currentFile)!;
      if (added > 0) {
        for (let i = addedStart; i < addedStart + added; i++) lines.add(i);
      } else {
        // Deletion-only hunk: no new-side lines, so flag the old-side region.
        for (let i = removedStart; i < removedStart + removed; i++) lines.add(i);
      }

      if (currentOldFile) {
        // git writes an empty old side as `-N,0`: zero lines *after* line N.
        const start = removed === 0 ? removedStart + 1 : removedStart;
        const range: BaseRange = { start, end: start + removed - 1 };
        if (removed === 0) inserting = range.inserted = [];
        else removing = range.removed = [];
        baseFiles.get(currentOldFile)!.push(range);
      }
    }
  }

  return { files, baseFiles, addedLines, removedLines };
}

/** Does `range` touch a symbol spanning [start_line, end_line]? See LineRange for empty ranges. */
export function rangeHits(range: LineRange, sym: { start_line: number; end_line: number }): boolean {
  return sym.start_line <= range.end && sym.end_line >= range.start;
}
