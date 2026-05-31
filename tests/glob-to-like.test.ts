import { describe, test, expect } from "bun:test";
import { globToLike } from "../src/mcp/server.ts";

/**
 * Documents the glob → SQL LIKE translation used by list_files.
 *
 * Regression for rank 10: `**` used to map to `%` while leaving the trailing `/`, so
 * `**​/*Test*` became `%/%Test%` and never matched a root-level `FooTest.kt`.
 *
 * (Importing server.ts is safe: its Bun.serve bootstrap is guarded by import.meta.main.)
 */
describe("globToLike", () => {
  const cases: Array<[string, string]> = [
    ["*.kt", "%.kt"],
    ["src/main/**", "src/main/%"],
    ["**/*Test*", "%Test%"], // the rank-10 case: matches FooTest.kt at any depth incl. root
    ["**", "%"],
    ["**/foo", "%foo"],
    ["a/**/b", "a/%b"], // interior **/ absorbs its separator
    ["a?b", "a_b"],
    ["Foo.kt", "Foo.kt"], // no wildcards → literal
  ];
  for (const [glob, like] of cases) {
    test(`${glob} → ${like}`, () => {
      expect(globToLike(glob)).toBe(like);
    });
  }

  describe("escaping of literal SQL wildcards", () => {
    test("literal underscore is escaped, not treated as single-char wildcard", () => {
      expect(globToLike("foo_bar.kt")).toBe("foo\\_bar.kt");
    });
    test("literal percent is escaped", () => {
      expect(globToLike("50%off")).toBe("50\\%off");
    });
    test("escaped literal % is not conflated with a wildcard during collapse", () => {
      expect(globToLike("*%")).toBe("%\\%"); // wildcard then literal %
      expect(globToLike("%*")).toBe("\\%%"); // literal % then wildcard
    });
    test("? still maps to _ alongside escaped literals", () => {
      expect(globToLike("a?b_c")).toBe("a_b\\_c");
    });

    test("literal backslash is escaped (no dangling LIKE escape char)", () => {
      // A trailing backslash would otherwise be a dangling escape → Postgres 22025;
      // an interior one would silently consume the next char.
      expect(globToLike("dir\\")).toBe("dir\\\\");
      expect(globToLike("a\\b.kt")).toBe("a\\\\b.kt");
    });

    test("backslash is escaped before %/_, so their added escapes aren't doubled", () => {
      expect(globToLike("a\\b_c")).toBe("a\\\\b\\_c");
    });
  });
});
