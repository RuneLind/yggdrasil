import { describe, test, expect } from "bun:test";
import {
  ImpactTracer,
  PatternTracer,
  DetectChangesTracer,
  GenericTracer,
  TRACE_SCHEMA_VERSION,
  type TraceV1,
} from "../src/tracing/trace.ts";

describe("ImpactTracer", () => {
  test("toJSON has expected shape with hops, buckets, and capped topResults", () => {
    const t = new ImpactTracer();
    t.setQuery("com.foo.Bar.baz", 3, "melosys-api");
    t.setStart("sym0", "com.foo.Bar.baz", "method");
    t.recordHop(0, 12);
    t.recordHop(1, 5);
    t.recordHop(2, 1);
    t.recordConfidenceBucket(0.8, 1.0, 8);
    t.recordConfidenceBucket(0.6, 0.8, 4);
    t.recordConfidenceBucket(0.4, 0.6, 6);

    const top = Array.from({ length: 25 }, (_, i) => ({
      symbolId: `s${i}`,
      qualifiedName: `com.foo.S${i}`,
      kind: "method",
      depth: i % 3,
      confidence: 1.0 - i * 0.02,
    }));
    t.setFinal(40, top);
    t.recordTiming("lookup", 12);
    t.recordTiming("traversal", 80);
    t.recordTiming("scoring", 4);

    const out = t.toJSON();
    expect(out.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
    expect(out.tool).toBe("impact");
    expect(out.query).toEqual({ qualifiedName: "com.foo.Bar.baz", maxDepth: 3, repo: "melosys-api" });
    expect(out.start).toEqual({ symbolId: "sym0", qualifiedName: "com.foo.Bar.baz", kind: "method" });
    expect(out.hops).toEqual([
      { depth: 0, candidateCount: 12 },
      { depth: 1, candidateCount: 5 },
      { depth: 2, candidateCount: 1 },
    ]);
    expect(out.confidenceBuckets).toHaveLength(3);
    expect(out.finalCount).toBe(40);
    expect(out.topResults).toHaveLength(20);
    expect(out.topResults[0]?.symbolId).toBe("s0");
    expect(out.topResults[19]?.symbolId).toBe("s19");
    expect(out.timingsMs.lookup).toBe(12);
    expect(out.timingsMs.traversal).toBe(80);
    expect(out.timingsMs.scoring).toBe(4);
    expect(out.timingsMs.total).toBeGreaterThanOrEqual(0);
  });

  test("query.repo omitted when not set", () => {
    const t = new ImpactTracer();
    t.setQuery("com.foo.Bar", 2);
    const out = t.toJSON();
    expect(out.query.repo).toBeUndefined();
    expect(out.query.maxDepth).toBe(2);
    expect(out.start).toBeNull();
  });
});

describe("PatternTracer", () => {
  test("toJSON has expected shape with invocation, perRepo, totals", () => {
    const t = new PatternTracer();
    t.setQuery({
      pattern: "BigDecimal\\.ZERO",
      repo: "melosys-api",
      pathGlob: "*.kt",
      maxResults: 20,
      contextLines: 2,
    });
    t.setInvocation(
      ["--json", "-C", "2", "--max-count", "40", "--glob", "*.kt", "BigDecimal\\.ZERO"],
      ["melosys-api", "melosys-eessi"],
    );
    t.incrementRepoMatch("melosys-api");
    t.incrementRepoMatch("melosys-api");
    t.incrementRepoMatch("melosys-api");
    t.incrementRepoMatch("melosys-eessi");
    t.setTotals(4, 4, false);
    t.recordTiming("rg", 28);
    t.recordTiming("parse", 3);

    const out = t.toJSON();
    expect(out.tool).toBe("search_pattern");
    expect(out.query.pattern).toBe("BigDecimal\\.ZERO");
    expect(out.query.repo).toBe("melosys-api");
    expect(out.query.pathGlob).toBe("*.kt");
    expect(out.invocation.repos).toEqual(["melosys-api", "melosys-eessi"]);
    expect(out.invocation.rgArgs).toContain("--glob");
    expect(out.perRepo).toEqual([
      { repo: "melosys-api", matchCount: 3 },
      { repo: "melosys-eessi", matchCount: 1 },
    ]);
    expect(out.totals).toEqual({ preTrim: 4, returned: 4, truncated: false });
  });
});

describe("DetectChangesTracer", () => {
  test("toJSON captures diff, per-file symbols, impact expansion, totals", () => {
    const t = new DetectChangesTracer();
    t.setQuery("melosys-api", "HEAD~1");
    t.setDiff(3, 42, 11);
    t.recordFileSymbols("src/Foo.kt", 2);
    t.recordFileSymbols("src/Bar.kt", 1);
    t.recordFileSymbols("src/Baz.kt", 0);
    t.recordImpact("symA", "com.foo.Foo.method1", 12);
    t.recordImpact("symB", "com.foo.Bar.method2", 3);
    t.setTotals(3, 14);
    t.recordTiming("diff", 8);
    t.recordTiming("symbolResolution", 22);
    t.recordTiming("impact", 110);

    const out = t.toJSON();
    expect(out.tool).toBe("detect_changes");
    expect(out.query).toEqual({ repo: "melosys-api", ref: "HEAD~1" });
    expect(out.diff).toEqual({ fileCount: 3, addedLines: 42, removedLines: 11 });
    expect(out.symbolsExtracted).toHaveLength(3);
    expect(out.impactExpansion).toEqual([
      { symbolId: "symA", qualifiedName: "com.foo.Foo.method1", affectedCount: 12 },
      { symbolId: "symB", qualifiedName: "com.foo.Bar.method2", affectedCount: 3 },
    ]);
    expect(out.totals).toEqual({ changedSymbols: 3, affected: 14 });
    expect(out.timingsMs.diff).toBe(8);
  });

  test("ref omitted when not set", () => {
    const t = new DetectChangesTracer();
    t.setQuery("melosys-api");
    const out = t.toJSON();
    expect(out.query.ref).toBeUndefined();
  });
});

describe("GenericTracer", () => {
  test("uses shape:'generic' discriminator and accepts arbitrary tool names", () => {
    const t = new GenericTracer("symbol_context");
    t.addEvent("disambiguation", { data: { candidates: 3 } });
    t.addEvent("edge_fetch", { durationMs: 12, data: { incoming: 5, outgoing: 2 } });
    t.recordTiming("custom_phase", 7);

    const out = t.toJSON();
    expect(out.shape).toBe("generic");
    expect(out.tool).toBe("symbol_context");
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toEqual({ stage: "disambiguation", data: { candidates: 3 } });
    expect(out.events[1]?.durationMs).toBe(12);
    expect(out.timingsMs.custom_phase).toBe(7);
    expect(out.timingsMs.total).toBeGreaterThanOrEqual(0);
  });
});

describe("TraceV1 discriminated union", () => {
  test("can narrow on tool / shape", () => {
    const tracers: TraceV1[] = [
      new ImpactTracer().toJSON(),
      new PatternTracer().toJSON(),
      new DetectChangesTracer().toJSON(),
      new GenericTracer("foo").toJSON(),
    ];

    for (const t of tracers) {
      if ("shape" in t && t.shape === "generic") {
        // narrowed to TraceGenericV1
        expect(t.events).toBeDefined();
      } else if (t.tool === "impact") {
        expect(t.hops).toBeDefined();
      } else if (t.tool === "search_pattern") {
        expect(t.invocation).toBeDefined();
      } else if (t.tool === "detect_changes") {
        expect(t.diff).toBeDefined();
      }
    }
  });
});
