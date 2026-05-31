import { describe, test, expect, spyOn } from "bun:test";
import { extractCallGraph } from "../src/indexer/call-graph.ts";

/**
 * Rank 12: a language declared SupportedLanguage but missing a call extractor used to
 * silently produce an empty call graph (the dispatch was a hardcoded java/kotlin
 * if/else with no else). The table-driven dispatch now returns empty AND logs a warning
 * once per language, so the gap is visible instead of silent.
 *
 * TypeScript/tsx are intentionally without an extractor (pending TS import resolution,
 * review follow-up #18) — that's the path exercised here. The early return happens
 * before the tree is touched, so a stub tree is fine.
 *
 * NOTE: this is the only test that drives extractCallGraph, so the per-language
 * warn-once dedup set starts empty here.
 */
describe("extractCallGraph language dispatch", () => {
  test("language without an extractor → empty graph, warns exactly once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stubTree = {} as Parameters<typeof extractCallGraph>[1];
      const extraction = { symbols: [] } as unknown as Parameters<typeof extractCallGraph>[3];

      const r1 = extractCallGraph("const x = 1;", stubTree, "typescript", extraction);
      const r2 = extractCallGraph("const y = 2;", stubTree, "typescript", extraction);

      expect(r1).toEqual({ calls: [], inheritance: [] });
      expect(r2).toEqual({ calls: [], inheritance: [] });

      const tsWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("'typescript'"));
      expect(tsWarnings.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a different unsupported language warns separately", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stubTree = {} as Parameters<typeof extractCallGraph>[1];
      const extraction = { symbols: [] } as unknown as Parameters<typeof extractCallGraph>[3];

      extractCallGraph("<div/>", stubTree, "tsx", extraction);

      const tsxWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("'tsx'"));
      expect(tsxWarnings.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
