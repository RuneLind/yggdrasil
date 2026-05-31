/**
 * Pure parser for `git diff --unified=0` output. Kept free of I/O so it can be
 * table-driven over fixture diff text without spawning git or touching a DB.
 *
 * Produces, per changed file, the set of line numbers a change touched, plus the
 * running added/removed totals. Those line ranges are later intersected with the
 * indexed symbols' [start_line, end_line] to find which symbols a change hit.
 */

export interface DiffSummary {
  /** path → set of touched line numbers (new-side for edits/adds, old-side for pure deletions) */
  files: Map<string, Set<number>>;
  addedLines: number;
  removedLines: number;
}

/** git emits "a/<path>" (old) and "b/<path>" (new) by default; strip that prefix. */
function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
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
  let addedLines = 0;
  let removedLines = 0;

  let currentFile: string | null = null;
  let pendingOldFile: string | null = null;
  let inHeader = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      currentFile = null;
      pendingOldFile = null;
      continue;
    }

    if (inHeader && line.startsWith("--- ")) {
      // Old-side path. "/dev/null" means a newly added file (no old path).
      pendingOldFile = line.startsWith("--- /dev/null") ? null : stripDiffPrefix(line.slice(4));
      continue;
    }

    if (inHeader && line.startsWith("+++ ")) {
      // New-side path. "/dev/null" means a deleted file — fall back to the old path.
      currentFile = line.startsWith("+++ /dev/null") ? pendingOldFile : stripDiffPrefix(line.slice(4));
      if (currentFile && !files.has(currentFile)) files.set(currentFile, new Set());
      inHeader = false;
      continue;
    }

    if (line.startsWith("@@ ") && currentFile) {
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
    }
  }

  return { files, addedLines, removedLines };
}
