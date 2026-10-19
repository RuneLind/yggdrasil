import { describe, test, expect } from "bun:test";
import { compareAffected, dropLocalFields, mergeAffected, selectChangedSymbols } from "../src/search/detect-changes.ts";
import type { ImpactEntry } from "../src/search/impact.ts";

const sym = (id: string, kind: string, parent_id: string | null, start_line: number, end_line: number) => ({
  id, kind, parent_id, start_line, end_line, file_path: "A.kt",
});

/** Without a parsed file (a TypeScript file, an unreadable blob), member spans from the index decide. */
describe("selectChangedSymbols without an AST", () => {
  const cls = sym("c", "class", null, 1, 20);
  const field = sym("f", "property", "c", 3, 3);
  const m1 = sym("m1", "method", "c", 5, 9);
  const m2 = sym("m2", "method", "c", 11, 15);
  const run = (...ranges: Array<[number, number]>) => {
    const { changed, reasons } = selectChangedSymbols([
      { symbols: [cls, field, m1, m2], ranges: ranges.map(([start, end]) => ({ start, end })), indexed: null, head: null },
    ]);
    return { changed: changed.map((s) => s.id), reasons: Object.fromEntries(reasons) };
  };

  test("a hit inside a method drops the class", () => {
    expect(run([6, 7])).toEqual({ changed: ["m1"], reasons: {} });
  });

  test("a changed line outside every member keeps the class as unknown", () => {
    expect(run([10, 10], [6, 6])).toEqual({ changed: ["c", "m1"], reasons: { c: "unknown" } });
    expect(run([3, 3], [6, 6])).toEqual({ changed: ["c", "f", "m1"], reasons: { c: "unknown" } });
  });

  test("an insertion inside a method drops the class; one between members keeps it", () => {
    expect(run([7, 6])).toEqual({ changed: ["m1"], reasons: {} });
    expect(run([11, 10], [6, 6])).toEqual({ changed: ["c", "m1"], reasons: { c: "unknown" } });
  });

  test("a hunk running past the container counts only the container's own lines", () => {
    const k = sym("k", "class", null, 10, 20);
    const head = sym("kh", "method", "k", 10, 15);
    const tail = sym("kt", "method", "k", 16, 20);
    const top = sym("top", "function", null, 21, 25);
    const { changed } = selectChangedSymbols([
      { symbols: [k, head, tail, top], ranges: [{ start: 18, end: 25 }], indexed: null, head: null },
    ]);
    expect(changed.map((s) => s.id)).toEqual(["kt", "top"]);
  });

  test("drops every enclosing level for a method in a nested class", () => {
    const inner = sym("i", "class", "c", 4, 16);
    const innerMethod = sym("im", "function", "i", 6, 8);
    const { changed, dropped } = selectChangedSymbols([
      { symbols: [cls, inner, innerMethod], ranges: [{ start: 7, end: 7 }], indexed: null, head: null },
    ]);
    expect(changed.map((s) => s.id)).toEqual(["im"]);
    expect(dropped.map((s) => s.id)).toEqual(["c", "i"]);
  });

  test("keeps a method whose local function overlaps (only container kinds drop)", () => {
    const local = sym("l", "function", "m1", 6, 7);
    const { changed } = selectChangedSymbols([{ symbols: [m1, local], ranges: [{ start: 6, end: 6 }], indexed: null, head: null }]);
    expect(changed.map((s) => s.id)).toEqual(["m1", "l"]);
  });

  test("head side: the bounding range selects symbols, the exact lines classify the class", () => {
    const gap = sym("gap", "method", "c", 10, 10);
    const { changed } = selectChangedSymbols([
      { symbols: [cls, m1, gap, m2], ranges: [{ start: 6, end: 6 }, { start: 12, end: 12 }], match: [{ start: 6, end: 12 }], indexed: null, head: null },
    ]);
    // gap lies only inside the bounding range; the class is dropped since both exact lines are in methods.
    expect(changed.map((s) => s.id)).toEqual(["m1", "gap", "m2"]);
  });
});

describe("dropLocalFields", () => {
  test("drops a property inside a method and keeps a class-level one", () => {
    const symbols = [
      sym("c", "class", null, 1, 20),
      sym("f", "property", "c", 3, 3),
      sym("m", "method", "c", 5, 9),
      sym("local", "property", "m", 6, 6),
      sym("ctorLocal", "field", "k", 12, 12),
      sym("k", "constructor", "c", 11, 13),
    ];
    expect(dropLocalFields(symbols).map((s) => s.id)).toEqual(["c", "f", "m", "k"]);
  });

  test("drops a local val on the function's first line", () => {
    const symbols = [sym("m", "method", "c", 5, 9), sym("first", "property", "m", 5, 5)];
    expect(dropLocalFields(symbols).map((s) => s.id)).toEqual(["m"]);
  });
});

describe("compareAffected", () => {
  const e = (edge_kind: string, confidence: number, depth = 1) => ({ edge_kind, confidence, depth });

  test("calls and overrides sort above imports at the same confidence", () => {
    const sorted = [e("imports", 0.7), e("calls", 0.7), e("overrides", 0.7)].sort(compareAffected);
    expect(sorted.map((x) => x.edge_kind)).toEqual(["calls", "overrides", "imports"]);
  });

  test("a deeper call sorts above a direct import", () => {
    const sorted = [e("imports", 0.7, 1), e("calls", 0.2, 3)].sort(compareAffected);
    expect(sorted.map((x) => x.edge_kind)).toEqual(["calls", "imports"]);
  });

  test("within one kind, higher confidence first", () => {
    const sorted = [e("calls", 0.4, 2), e("calls", 0.7, 1)].sort(compareAffected);
    expect(sorted.map((x) => x.confidence)).toEqual([0.7, 0.4]);
  });

  test("at equal confidence, the shallower entry first (extends at depth 3 and calls at depth 2 both score 0.4)", () => {
    const sorted = [e("extends", 0.4, 3), e("calls", 0.4, 2)].sort(compareAffected);
    expect(sorted.map((x) => x.depth)).toEqual([2, 3]);
  });
});

describe("compareAffected ties", () => {
  const e = (edge_kind: string, qualified_name = "p.x") => ({ edge_kind, confidence: 0.7, depth: 1, qualified_name });

  test("on equal confidence and depth, calls sort above overrides in either order, then qualified name", () => {
    expect([e("overrides"), e("calls")].sort(compareAffected).map((x) => x.edge_kind)).toEqual(["calls", "overrides"]);
    expect([e("calls"), e("overrides")].sort(compareAffected).map((x) => x.edge_kind)).toEqual(["calls", "overrides"]);
    expect([e("calls", "p.b"), e("calls", "p.a")].sort(compareAffected).map((x) => x.qualified_name)).toEqual(["p.a", "p.b"]);
  });
});

describe("mergeAffected", () => {
  const entry = (id: string, edge_kind: string, confidence: number, depth = 1): ImpactEntry => ({
    id, name: id, qualified_name: `p.${id}`, kind: "method", file_path: "A.kt", repo_name: "r",
    depth, edge_kind, resolution: edge_kind === "calls" ? "typed" : null, confidence, archetype: "other",
  });

  test("keeps the better entry per id in either order and lists every changed symbol that reached it", () => {
    const viaCall = { changed: { id: "s1", qualified_name: "p.S.a" }, affected: [entry("x", "calls", 0.4, 2)] };
    const viaImport = { changed: { id: "s2", qualified_name: "p.S.b" }, affected: [entry("x", "imports", 0.7)] };
    for (const order of [[viaCall, viaImport], [viaImport, viaCall]]) {
      const [x] = mergeAffected(order);
      expect(x.edge_kind).toBe("calls");
      expect(x.confidence).toBe(0.4);
      expect([...x.changed_symbols].sort()).toEqual(["p.S.a", "p.S.b"]);
    }
  });

  test("a call and an override of the same id at equal confidence merge to the call in either order", () => {
    const viaCall = { changed: { id: "s1", qualified_name: "p.S.a" }, affected: [entry("x", "calls", 0.7)] };
    const viaOverride = { changed: { id: "s2", qualified_name: "p.S.b" }, affected: [entry("x", "overrides", 0.7)] };
    for (const order of [[viaCall, viaOverride], [viaOverride, viaCall]]) {
      expect(mergeAffected(order)[0].edge_kind).toBe("calls");
    }
  });

  test("carries every ImpactEntry field through", () => {
    const e = { ...entry("x", "calls", 0.7), via: "p.Base.run" } as ImpactEntry & { via: string };
    const [x] = mergeAffected([{ changed: { id: "s1", qualified_name: "p.S.a" }, affected: [e] }]);
    expect(x).toEqual({ ...e, changed_symbols: ["p.S.a"] });
  });

  test("lists overloads that share a qualified name once each", () => {
    const [x] = mergeAffected([
      { changed: { id: "o1", qualified_name: "p.S.f" }, affected: [entry("x", "calls", 0.7)] },
      { changed: { id: "o2", qualified_name: "p.S.f" }, affected: [entry("x", "calls", 0.7)] },
      { changed: { id: "o1", qualified_name: "p.S.f" }, affected: [entry("x", "calls", 0.7)] },
    ]);
    expect(x.changed_symbols).toEqual(["p.S.f", "p.S.f"]);
  });

  test("returns the merged entries sorted: calls above imports, then confidence", () => {
    const merged = mergeAffected([
      {
        changed: { id: "s1", qualified_name: "p.S.a" },
        affected: [entry("imp", "imports", 0.7), entry("deep", "calls", 0.2, 3), entry("near", "calls", 0.7)],
      },
    ]);
    expect(merged.map((m) => m.id)).toEqual(["near", "deep", "imp"]);
  });
});

/**
 * compareAffected is a total order, so mergeAffected keeps the same entry for an id in any
 * input order. Each test pins one key: swapping or dropping it flips the expected order.
 */
describe("compareAffected total order", () => {
  type E = { edge_kind: string; confidence: number; depth: number; resolution?: string | null; via?: string | null; via_id?: string | null; qualified_name?: string; id?: string };
  const base: E = { edge_kind: "calls", confidence: 0.4, depth: 2, resolution: "typed", via: null, via_id: null, qualified_name: "p.x", id: "1" };
  const e = (over: Partial<E>): E => ({ ...base, ...over });
  const firstOf = (a: E, b: E) => {
    const one = [a, b].sort(compareAffected)[0];
    const two = [b, a].sort(compareAffected)[0];
    expect(two).toBe(one);
    return one;
  };

  test("confidence ranks above edge kind: an override at 0.7 before a call at 0.4", () => {
    expect(firstOf(e({ edge_kind: "calls", confidence: 0.4 }), e({ edge_kind: "overrides", confidence: 0.7 })).edge_kind).toBe("overrides");
  });

  test("extends before implements at equal confidence", () => {
    expect(firstOf(e({ edge_kind: "implements", confidence: 0.9, depth: 1 }), e({ edge_kind: "extends", confidence: 0.9, depth: 1 })).edge_kind).toBe("extends");
  });

  test("an unknown edge kind after implements, and two unknown kinds by name", () => {
    expect(firstOf(e({ edge_kind: "uses" }), e({ edge_kind: "implements" })).edge_kind).toBe("implements");
    expect(firstOf(e({ edge_kind: "uses" }), e({ edge_kind: "binds" })).edge_kind).toBe("binds");
  });

  test("same kind and confidence: the shallower entry first, whatever its name", () => {
    expect(firstOf(e({ depth: 3, qualified_name: "p.a" }), e({ depth: 2, qualified_name: "p.b" })).depth).toBe(2);
  });

  test("then resolution: local, static, super, typed, chain, then unknown, then none", () => {
    const order = ["local", "static", "super", "typed", "chain", "zeta", null];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(firstOf(e({ resolution: order[i + 1], qualified_name: "p.a" }), e({ resolution: order[i], qualified_name: "p.b" })).resolution).toBe(order[i]);
    }
    expect(firstOf(e({ resolution: "zz" }), e({ resolution: "za" })).resolution).toBe("za");
  });

  test("then a direct edge before one via an ancestor, then via by name", () => {
    expect(firstOf(e({ via: "p.Base.run", qualified_name: "p.a" }), e({ via: null, qualified_name: "p.b" })).via).toBeNull();
    expect(firstOf(e({ via: "p.B.run", qualified_name: "p.a" }), e({ via: "p.A.run", qualified_name: "p.b" })).via).toBe("p.A.run");
    expect(firstOf(e({ via: "p.A.run", via_id: "9", qualified_name: "p.a" }), e({ via: "p.A.run", via_id: "3", qualified_name: "p.b" })).via_id).toBe("3");
  });

  test("then qualified name, then id", () => {
    expect(firstOf(e({ qualified_name: "p.b", id: "1" }), e({ qualified_name: "p.a", id: "2" })).qualified_name).toBe("p.a");
    expect(firstOf(e({ id: "2" }), e({ id: "1" })).id).toBe("1");
    expect(firstOf(e({ qualified_name: undefined }), e({ qualified_name: "p.z" })).qualified_name).toBe("p.z");
  });
});

describe("mergeAffected is independent of input order", () => {
  const entry = (over: Partial<ImpactEntry> & { via?: string | null }): ImpactEntry => ({
    id: "x", name: "x", qualified_name: "p.x", kind: "class", file_path: "X.kt", repo_name: "r",
    depth: 1, edge_kind: "calls", resolution: null, confidence: 0.9, archetype: "other", ...over,
  } as ImpactEntry);
  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));

  test("a class that extends A and implements I, both changed, merges to extends in every order", () => {
    const viaA = { changed: { id: "a", qualified_name: "p.A" }, affected: [entry({ edge_kind: "extends" })] };
    const viaI = { changed: { id: "i", qualified_name: "p.I" }, affected: [entry({ edge_kind: "implements" })] };
    for (const order of permutations([viaA, viaI])) expect(mergeAffected(order)[0].edge_kind).toBe("extends");
  });

  test("two calls of one id differing in resolution and via merge to the same entry in every order", () => {
    const inputs = [
      { changed: { id: "s1", qualified_name: "p.S.a" }, affected: [entry({ confidence: 0.7, resolution: "typed", via: "p.B.run" })] },
      { changed: { id: "s2", qualified_name: "p.S.b" }, affected: [entry({ confidence: 0.7, resolution: "local", via: "p.B.run" })] },
      { changed: { id: "s3", qualified_name: "p.S.c" }, affected: [entry({ confidence: 0.7, resolution: "local", via: null })] },
    ];
    const results = permutations(inputs).map((order) => mergeAffected(order)[0]);
    for (const r of results) {
      expect(r.resolution).toBe("local");
      expect((r as ImpactEntry & { via?: string | null }).via).toBeNull();
    }
  });
});

