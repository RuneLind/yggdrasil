import { describe, test, expect } from "bun:test";
import { compareAffected, dropEnclosingContainers } from "../src/search/detect-changes.ts";

/** G7: the enclosing class always overlaps a method edit; it must not drown the method's callers. */
describe("dropEnclosingContainers", () => {
  const cls = { id: "c", kind: "class", parent_id: null, file_path: "A.kt" };
  const method = { id: "m", kind: "method", parent_id: "c", file_path: "A.kt" };
  const field = { id: "f", kind: "property", parent_id: "c", file_path: "A.kt" };

  test("drops the class when one of its methods also overlaps", () => {
    const { kept, dropped } = dropEnclosingContainers([cls, method]);
    expect(kept.map((s) => s.id)).toEqual(["m"]);
    expect(dropped.map((s) => s.id)).toEqual(["c"]);
  });

  test("keeps the class when only the header changed", () => {
    expect(dropEnclosingContainers([cls]).kept.map((s) => s.id)).toEqual(["c"]);
  });

  test("keeps the class when only a field changed", () => {
    expect(dropEnclosingContainers([cls, field]).kept.map((s) => s.id)).toEqual(["c", "f"]);
  });

  test("keeps a method whose local function overlaps (only container kinds drop)", () => {
    const local = { id: "l", kind: "function", parent_id: "m", file_path: "A.kt" };
    expect(dropEnclosingContainers([method, local]).kept.map((s) => s.id)).toEqual(["m", "l"]);
  });

  test("drops every enclosing level for a method in a nested class", () => {
    const inner = { id: "i", kind: "class", parent_id: "c", file_path: "A.kt" };
    const innerMethod = { id: "im", kind: "function", parent_id: "i", file_path: "A.kt" };
    expect(dropEnclosingContainers([cls, inner, innerMethod]).kept.map((s) => s.id)).toEqual(["im"]);
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
});
