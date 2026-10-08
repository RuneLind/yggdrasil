import { describe, test, expect } from "bun:test";
import { gitDiffArgs } from "../src/search/detect-changes.ts";

/**
 * Pins the `git diff` argv. Each flag overrides a user or repo config that would
 * otherwise change the output: quoted paths (core.quotePath; parseGitDiff's unquote
 * fallback hides its loss end to end), missing a/ b/ prefixes (diff.noprefix,
 * diff.mnemonicPrefix), textconv and external diff drivers, and diff.renames=false.
 */
describe("gitDiffArgs", () => {
  test("pins config-independent output flags and ends options before the revisions", () => {
    expect(gitDiffArgs(["abc"])).toEqual([
      "git", "-c", "core.quotePath=false", "diff",
      "--unified=0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
      "--no-textconv", "--no-ext-diff", "-M",
      "--end-of-options", "abc", "--",
    ]);
  });

  test("passes both sides of a two-sided diff in order", () => {
    expect(gitDiffArgs(["base", "head"]).slice(-4)).toEqual(["--end-of-options", "base", "head", "--"]);
  });
});
