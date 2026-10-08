import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { git } from "./helpers/git.ts";
import { gitDiffArgs } from "../src/search/detect-changes.ts";
import { parseGitDiff } from "../src/search/diff-parse.ts";

/**
 * Pins the `git diff` argv. Each flag overrides a user or repo config that would
 * otherwise change the output: quoted paths (core.quotePath; parseGitDiff's unquote
 * fallback hides its loss end to end), missing a/ b/ prefixes (diff.noprefix,
 * diff.mnemonicPrefix), textconv and external diff drivers, diff.renames=false, and
 * diff.interHunkContext (merges nearby hunks and their context lines into one range).
 */
describe("gitDiffArgs", () => {
  test("pins config-independent output flags and ends options before the revisions", () => {
    expect(gitDiffArgs(["abc"])).toEqual([
      "git", "-c", "core.quotePath=false", "diff",
      "--unified=0", "--inter-hunk-context=0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
      "--no-textconv", "--no-ext-diff", "-M",
      "--end-of-options", "abc", "--",
    ]);
  });

  test("passes both sides of a two-sided diff in order", () => {
    expect(gitDiffArgs(["base", "head"]).slice(-4)).toEqual(["--end-of-options", "base", "head", "--"]);
  });

  test("diff.interHunkContext in the repo config does not merge nearby hunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yggdrasil-ihc-"));
    try {
      await git(dir, "init", "-q");
      await git(dir, "config", "diff.interHunkContext", "5");
      await writeFile(join(dir, "a.kt"), "1\n2\n3\n4\n5\n6\n7\n");
      await git(dir, "add", ".");
      await git(dir, "commit", "-q", "-m", "c0");
      // An insertion after line 1 and an edit of line 4, two unchanged lines apart.
      await writeFile(join(dir, "a.kt"), "1\nny\n2\n3\nfire\n5\n6\n7\n");
      const proc = Bun.spawn(gitDiffArgs(["HEAD"]), { cwd: dir, stdout: "pipe" });
      const diff = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const ranges = parseGitDiff(diff).baseFiles.get("a.kt")!;
      expect(ranges.map((r) => [r.start, r.end])).toEqual([[2, 1], [4, 4]]);
      expect(ranges[0].inserted).toEqual(["ny"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
