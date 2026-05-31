import { describe, test, expect } from "bun:test";
import { confidenceScore } from "../src/search/impact.ts";

/**
 * Pins the depth→confidence mapping for blast-radius scoring.
 *
 * The traversal seeds direct callers at depth 1 (see getImpact in db/edges.ts), so the
 * lowest depth ever scored here is 1 → 0.7. Before the rank-7 fix, direct callers were
 * seeded at depth 0 → 1.0, making them indistinguishable from the changed symbol itself.
 */
describe("confidenceScore", () => {
  describe("call edges (no structural boost)", () => {
    const cases: Array<[number, number]> = [
      [0, 1.0], // the changed symbol itself (not present in the blast radius)
      [1, 0.7], // direct callers
      [2, 0.4],
      [3, 0.2],
      [4, 0.1], // beyond the table → floor
      [10, 0.1],
    ];
    for (const [depth, expected] of cases) {
      test(`depth ${depth} → ${expected}`, () => {
        expect(confidenceScore(depth, "calls")).toBeCloseTo(expected, 10);
      });
    }
  });

  describe("structural edges get +0.2", () => {
    test("extends at depth 1 → 0.9", () => {
      expect(confidenceScore(1, "extends")).toBeCloseTo(0.9, 10);
    });
    test("implements at depth 2 → 0.6", () => {
      expect(confidenceScore(2, "implements")).toBeCloseTo(0.6, 10);
    });
    test("extends beyond the table (depth 4) → 0.1 + 0.2 = 0.3", () => {
      expect(confidenceScore(4, "extends")).toBeCloseTo(0.3, 10);
    });
  });

  test("the structural boost is capped at 1.0 (Math.min)", () => {
    // depth 0 base is 1.0; +0.2 must not exceed 1.0.
    expect(confidenceScore(0, "extends")).toBe(1.0);
    expect(confidenceScore(0, "implements")).toBe(1.0);
  });

  test("only extends/implements boost; imports/calls do not", () => {
    expect(confidenceScore(1, "imports")).toBeCloseTo(0.7, 10);
    expect(confidenceScore(1, "calls")).toBeCloseTo(0.7, 10);
  });
});
