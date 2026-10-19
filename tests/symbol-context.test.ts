import { describe, test, expect } from "bun:test";
import { edgeBuckets, withDispatchedCallers } from "../src/search/symbol-context.ts";
import type { EdgeNeighbor } from "../src/db/edges.ts";
import type { ImpactEntry } from "../src/search/impact.ts";

const edge = (id: string, kind: EdgeNeighbor["kind"]): EdgeNeighbor => ({
  symbol_id: id, kind, name: id, qualified_name: `p.${id}`, file_path: `${id}.kt`, repo_name: "r",
});

const entry = (id: string, depth: number, edgeKind: string, via: string | null): ImpactEntry => ({
  id, name: id, qualified_name: `p.${id}`, kind: "method", file_path: `${id}.kt`, repo_name: "r",
  depth, edge_kind: edgeKind, resolution: "typed", via, via_id: via, confidence: 0.7, archetype: "other",
});

describe("edgeBuckets", () => {
  test("overrides: the ancestors a method overrides; overridden_by: its implementations", () => {
    const b = edgeBuckets([edge("impl", "overrides"), edge("caller", "calls")], [edge("iface", "overrides"), edge("callee", "calls")]);
    expect(b.overrides.map((e) => e.symbol_id)).toEqual(["iface"]);
    expect(b.overridden_by.map((e) => e.symbol_id)).toEqual(["impl"]);
    expect(b.callers.map((e) => e.symbol_id)).toEqual(["caller"]);
    expect(b.callees.map((e) => e.symbol_id)).toEqual(["callee"]);
  });
});

describe("withDispatchedCallers", () => {
  test("adds depth-1 dispatched callers with via, once, after the direct ones", () => {
    const got = withDispatchedCallers([edge("direct", "calls")], [
      entry("direct", 1, "calls", "p.I.m"),
      entry("disp", 1, "calls", "p.I.m"),
      entry("deep", 2, "calls", "p.I.m"),
      entry("plain", 1, "calls", null),
      entry("impl", 1, "overrides", null),
    ]);
    expect(got.map((c) => `${c.symbol_id}:${c.via ?? "-"}`)).toEqual(["direct:-", "disp:p.I.m"]);
  });
});
