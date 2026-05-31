import { describe, test, expect } from "bun:test";
import { fuseAndRank, RRF_K, type FuseLeg } from "../src/search/rrf.ts";

const leg = (ids: string[], weight = 1.0): FuseLeg => ({
  results: ids.map((id, i) => ({ id, rank: 1 - i * 0.1 })),
  weight,
});

describe("fuseAndRank", () => {
  test("single leg ranks by position (RRF score decreases down the list)", () => {
    const { rrfRanked } = fuseAndRank([leg(["a", "b", "c"])], new Map());
    expect(rrfRanked.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(rrfRanked[0].rrfScore).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(rrfRanked[1].rrfScore).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  test("an id in multiple legs accumulates score", () => {
    // "x" is rank-0 in both legs; "y" only in one. x must outrank y.
    const { rrfRanked } = fuseAndRank([leg(["x", "z"]), leg(["x", "y"])], new Map());
    expect(rrfRanked[0].id).toBe("x");
    const x = rrfRanked.find((c) => c.id === "x")!;
    expect(x.rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1), 10);
  });

  test("leg weight scales contribution (name leg weight 1.5)", () => {
    const weighted = fuseAndRank([leg(["a"], 1.5)], new Map());
    expect(weighted.rrfRanked[0].rrfScore).toBeCloseTo(1.5 / (RRF_K + 1), 10);
  });

  test("kind not in the boost table → multiplier 1.0 (score == rrfScore)", () => {
    const { boosted } = fuseAndRank([leg(["a"])], new Map([["a", "unknown"]]));
    expect(boosted[0].score).toBeCloseTo(boosted[0].rrfScore, 10);
  });

  test("ties break by id ascending (deterministic order)", () => {
    // Same leg position in two separate single-item legs → equal rrfScore, same kind.
    const kinds = new Map([
      ["b", "class"],
      ["a", "class"],
    ]);
    const { boosted, rrfRanked } = fuseAndRank([leg(["b"]), leg(["a"])], kinds);
    expect(boosted.map((c) => c.id)).toEqual(["a", "b"]);
    expect(rrfRanked.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("empty legs → empty result", () => {
    const { rrfRanked, boosted } = fuseAndRank([], new Map());
    expect(rrfRanked).toEqual([]);
    expect(boosted).toEqual([]);
  });

  test("rank-9 regression: kind boost lifts a class past a property across the limit", () => {
    // One leg: property P is RRF-ahead of class C (P at idx 0, C at idx 1).
    // Pre-boost order is [P, C], so slicing to limit=1 BEFORE boosting (the old bug)
    // would keep P and drop C forever. After boosting over the full pool, C (×1.5)
    // overtakes P (×0.7) and wins the single slot.
    const kinds = new Map([
      ["P", "property"],
      ["C", "class"],
    ]);
    const { rrfRanked, boosted } = fuseAndRank([leg(["P", "C"])], kinds);

    // Pre-boost: property leads.
    expect(rrfRanked.map((c) => c.id)).toEqual(["P", "C"]);
    // Post-boost: class leads — so the top-1 slice now yields C, not P.
    expect(boosted.map((c) => c.id)).toEqual(["C", "P"]);
    expect(boosted[0].id).toBe("C");

    const c = boosted.find((x) => x.id === "C")!;
    const p = boosted.find((x) => x.id === "P")!;
    expect(c.score).toBeCloseTo(c.rrfScore * 1.5, 10);
    expect(p.score).toBeCloseTo(p.rrfScore * 0.7, 10);
    expect(c.score).toBeGreaterThan(p.score);
  });
});
