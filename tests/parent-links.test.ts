import { describe, test, expect } from "bun:test";
import { buildParentLinks } from "../src/indexer/symbol-extractor.ts";

/**
 * Regression guard for the critical "parent_id is never populated" bug: symbols were
 * inserted with parent_id = NULL and never wired up, collapsing the entire call graph
 * and degenerating import "top-level only" filters. buildParentLinks is the pure core
 * that maps each symbol's in-batch parentIndex to its parent's DB id.
 */
describe("buildParentLinks", () => {
  test("maps a nested method to its enclosing class id", () => {
    // 0 = class (top-level), 1 = method whose parentIndex points at the class
    const symbols = [{ parentIndex: null }, { parentIndex: 0 }];
    const ids = ["class-id", "method-id"];
    expect(buildParentLinks(symbols, ids)).toEqual([
      { id: "method-id", parent_id: "class-id" },
    ]);
  });

  test("top-level symbols produce no links", () => {
    const symbols = [{ parentIndex: null }, { parentIndex: null }];
    expect(buildParentLinks(symbols, ["a", "b"])).toEqual([]);
  });

  test("handles deep nesting (outer class > inner class > method)", () => {
    const symbols = [
      { parentIndex: null }, // 0 outer class
      { parentIndex: 0 }, // 1 inner class
      { parentIndex: 1 }, // 2 method inside inner class
    ];
    const ids = ["outer", "inner", "method"];
    expect(buildParentLinks(symbols, ids)).toEqual([
      { id: "inner", parent_id: "outer" },
      { id: "method", parent_id: "inner" },
    ]);
  });

  test("skips a link when either id is missing rather than emitting a bad pair", () => {
    const symbols = [{ parentIndex: null }, { parentIndex: 0 }];
    // child id present but parent id empty → no link (defensive against length mismatch)
    expect(buildParentLinks(symbols, ["", "child"])).toEqual([]);
  });

  test("empty input → empty links", () => {
    expect(buildParentLinks([], [])).toEqual([]);
  });
});
