import { describe, test, expect } from "bun:test";
import {
  attributeAnnotationInsertions,
  compareAffected,
  dropEnclosingContainers,
  dropLocalFields,
  mergeAffected,
} from "../src/search/detect-changes.ts";
import type { ImpactEntry } from "../src/search/impact.ts";

const sym = (id: string, kind: string, parent_id: string | null, start_line: number, end_line: number) => ({
  id, kind, parent_id, start_line, end_line, file_path: "A.kt",
});

/**
 * Class at 1-20 with a field (3), a method (5-9) and a method (11-15).
 * Header is line 1, the closing brace line 20.
 */
describe("dropEnclosingContainers", () => {
  const cls = sym("c", "class", null, 1, 20);
  const field = sym("f", "property", "c", 3, 3);
  const m1 = sym("m1", "method", "c", 5, 9);
  const m2 = sym("m2", "method", "c", 11, 15);
  const ranges = (...r: Array<[number, number]>) => new Map([["A.kt", r.map(([start, end]) => ({ start, end }))]]);
  const keptIds = (symbols: ReturnType<typeof sym>[], r: ReturnType<typeof ranges>) =>
    dropEnclosingContainers(symbols, r).kept.map((s) => s.id);

  test("drops the class when every hit lies inside its methods", () => {
    const { kept, dropped } = dropEnclosingContainers([cls, m1, m2], ranges([6, 7], [12, 12]));
    expect(kept.map((s) => s.id)).toEqual(["m1", "m2"]);
    expect(dropped.map((s) => s.id)).toEqual(["c"]);
  });

  test("keeps the class when a hit falls on its header, even next to a method hit", () => {
    expect(keptIds([cls, m1], ranges([1, 1], [6, 6]))).toEqual(["c", "m1"]);
  });

  test("keeps the class when a hit falls on a field", () => {
    expect(keptIds([cls, field, m1], ranges([3, 3], [6, 6]))).toEqual(["c", "f", "m1"]);
  });

  // Base-side ranges carry the old-side text of their lines (`removed`) and an insertion's
  // new-side text (`inserted`); a range without text counts every uncovered line.
  const all = [cls, field, m1, m2];
  const r = (start: number, end: number, text: { removed?: string[]; inserted?: string[] } = {}) => ({ start, end, ...text });
  const at = (...rs: ReturnType<typeof r>[]) => new Map([["A.kt", rs]]);
  const keptOf = (hit: ReturnType<typeof sym>[], rs: ReturnType<typeof at>) =>
    dropEnclosingContainers(hit, rs, all).kept.map((s) => s.id);

  test("drops the class when one hunk runs past a method into the blank line after it", () => {
    expect(keptOf([cls, m1], at(r(8, 10, { removed: ["        x()", "    }", ""] })))).toEqual(["m1"]);
  });

  test("drops the class when a new method is inserted between two changed methods", () => {
    const fn = ["    fun n(): Int {", "        val q = 1", "        return q", "    }", ""];
    const rs = at(r(6, 6, { removed: ["a"] }), r(11, 10, { inserted: fn }), r(12, 12, { removed: ["b"] }));
    expect(keptOf([cls, m1, m2], rs)).toEqual(["m1", "m2"]);
  });

  test("drops the class when a deleted method takes its blank separator with it", () => {
    const deleted = ["", "    fun b(): Int {", "        return 2", "", "    }", "    // slutt"];
    expect(keptOf([cls, m1, m2], at(r(10, 15, { removed: deleted }), r(6, 6, { removed: ["a"] })))).toEqual(["m1", "m2"]);
  });

  test("drops the class when only a KDoc outside its members changed", () => {
    expect(keptOf([cls], at(r(10, 10, { removed: ["    /** Gammel doc. */"] })))).toEqual([]);
    expect(dropEnclosingContainers([cls], at(r(10, 10, { removed: ["     * gammel linje"] })), all).dropped.map((s) => s.id)).toEqual(["c"]);
  });

  test("keeps the class when its header changed, next to a changed method", () => {
    expect(keptOf([cls, m1], at(r(1, 1, { removed: ["class A(val x: Int) {"] }), r(6, 6, { removed: ["a"] })))).toEqual(["c", "m1"]);
  });

  test("keeps the class when a field is inserted between members", () => {
    expect(keptOf([cls, m1], at(r(6, 6, { removed: ["a"] }), r(11, 10, { inserted: ["    val ny = 5", ""] })))).toEqual(["c", "m1"]);
    expect(keptOf([cls], at(r(11, 10, { inserted: ["    @Autowired", "    private lateinit var repo: Repo"] })))).toEqual(["c"]);
    expect(keptOf([cls], at(r(11, 10, { inserted: ["    private final Logger log = LoggerFactory.getLogger(A.class);"] })))).toEqual(["c"]);
  });

  test("a computed property inserted between members drops the class, like a method", () => {
    const prop = ["    /** Sum. */", "    val total: BigDecimal", "        get() = a.add(b)", ""];
    expect(keptOf([cls], at(r(11, 10, { inserted: prop })))).toEqual([]);
    const stored = ["    var teller: Int = 0", "        get() = field"];
    expect(keptOf([cls], at(r(11, 10, { inserted: stored })))).toEqual(["c"]);
  });

  test("keeps the class when code is inserted before its first member, but not a comment", () => {
    expect(keptOf([cls], at(r(3, 2, { inserted: ["    fun foerst() = 0"] })))).toEqual(["c"]);
    expect(keptOf([cls], at(r(3, 2, { inserted: ["    // kommentar", ""] })))).toEqual([]);
  });

  test("a method inserted after the fields, before the first method, drops the class", () => {
    expect(keptOf([cls], at(r(5, 4, { inserted: ["    fun foerst() = 0", ""] })))).toEqual([]);
  });

  test("a hunk running past the container's end or start counts only the container's own lines", () => {
    const k = sym("k", "class", null, 10, 20);
    const head = sym("kh", "method", "k", 10, 15);
    const tail = sym("kt", "method", "k", 16, 20);
    const lines = (n: number) => Array.from({ length: n }, () => "x()");
    expect(dropEnclosingContainers([k, tail], at(r(18, 25, { removed: lines(8) })), [k, head, tail]).dropped.map((s) => s.id)).toEqual(["k"]);
    expect(dropEnclosingContainers([k, head], at(r(6, 12, { removed: lines(7) })), [k, head, tail]).dropped.map((s) => s.id)).toEqual(["k"]);
  });

  test("keeps a class without non-field members even when no exact range hits it", () => {
    expect(dropEnclosingContainers([cls, field], new Map()).kept.map((s) => s.id)).toEqual(["c", "f"]);
  });

  test("an insertion between two lines of a method counts as inside it", () => {
    expect(keptIds([cls, m1], ranges([7, 6]))).toEqual(["m1"]);
  });

  test("a method inserted just after a method's closing brace drops the class", () => {
    expect(keptOf([cls], at(r(10, 9, { inserted: ["", "    fun ny() = 1"] })))).toEqual([]);
  });

  test("keeps a class without changed members", () => {
    expect(keptIds([cls], ranges([1, 1]))).toEqual(["c"]);
  });

  test("keeps a method whose local function overlaps (only container kinds drop)", () => {
    const local = sym("l", "function", "m1", 6, 7);
    expect(keptIds([m1, local], ranges([6, 6]))).toEqual(["m1", "l"]);
  });

  test("drops every enclosing level for a method in a nested class", () => {
    const inner = sym("i", "class", "c", 4, 16);
    const innerMethod = sym("im", "function", "i", 6, 8);
    expect(keptIds([cls, inner, innerMethod], ranges([7, 7]))).toEqual(["im"]);
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

describe("attributeAnnotationInsertions", () => {
  const symbols = [sym("c", "class", null, 1, 20), sym("m", "method", "c", 11, 15)];

  test("an annotation inserted right above a method becomes a hit on the method's first line", () => {
    expect(attributeAnnotationInsertions([{ start: 11, end: 10, inserted: ['    @Deprecated("x")'] }], symbols)).toEqual([
      { start: 11, end: 11 },
    ]);
  });

  test("an insertion that is not only annotations stays an insertion point", () => {
    const r = { start: 11, end: 10, inserted: ["    @Test", "    fun ny() {}"] };
    expect(attributeAnnotationInsertions([r], symbols)).toEqual([r]);
  });

  test("a blank line inside an inserted annotation block is ignored", () => {
    expect(attributeAnnotationInsertions([{ start: 11, end: 10, inserted: ["    @Deprecated", "   "] }], symbols)).toEqual([
      { start: 11, end: 11 },
    ]);
  });

  test("a blank-only insertion above a method stays an insertion point", () => {
    const r = { start: 11, end: 10, inserted: ["", "  "] };
    expect(attributeAnnotationInsertions([r], symbols)).toEqual([r]);
  });

  test("an annotation inserted where no symbol starts stays an insertion point", () => {
    const r = { start: 10, end: 9, inserted: ["    @Deprecated"] };
    expect(attributeAnnotationInsertions([r], symbols)).toEqual([r]);
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
