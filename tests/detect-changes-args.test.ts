import { describe, test, expect } from "bun:test";
import { gitDiffArgs } from "../src/search/detect-changes.ts";

/**
 * Pins `-c core.quotePath=false`: parseGitDiff's unquote fallback makes dropping the
 * flag invisible to every end-to-end test, so only the argument list can catch it.
 */
describe("gitDiffArgs", () => {
  for (const ref of [undefined, "HEAD~1"]) {
    test(`sets core.quotePath=false before the diff subcommand (ref=${ref ?? "none"})`, () => {
      const args = gitDiffArgs(ref);
      const diffAt = args.indexOf("diff");
      const flagAt = args.indexOf("core.quotePath=false");
      expect(args[0]).toBe("git");
      expect(diffAt).toBeGreaterThan(0);
      expect(flagAt).toBeGreaterThan(0);
      expect(flagAt).toBeLessThan(diffAt);
      expect(args[flagAt - 1]).toBe("-c");
      if (ref) expect(args.slice(diffAt + 1)).toContain(ref);
    });
  }
});
