import { describe, test, expect } from "bun:test";
import { SearchTracer, shouldTrace, TRACE_SCHEMA_VERSION } from "../src/tracing/trace.ts";

describe("SearchTracer", () => {
  test("toJSON returns schema-shaped object", () => {
    const t = new SearchTracer();
    t.setQuery("hello world", { repo: "muninn", language: "kotlin" });
    t.recordStage("fts", "sym1", 1, 0.42);
    t.recordStage("semantic", "sym1", 3, 0.88);
    t.recordStage("name", "sym2", 1, 1.0);
    t.recordStage("rrf", "sym1", 1, 0.033);
    t.recordStage("final", "sym1", 1, 0.05);
    t.annotate("sym1", "com.foo.Bar", "class");
    t.annotate("sym2", "com.foo.Baz", "method");
    t.recordTiming("embedding", 12);
    t.recordTiming("fts", 8);

    const out = t.toJSON();
    expect(out.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
    expect(out.tool).toBe("search");
    expect(out.query.raw).toBe("hello world");
    expect(out.query.filters).toEqual({ repo: "muninn", language: "kotlin" });
    expect(out.timingsMs.total).toBeGreaterThanOrEqual(0);
    expect(out.timingsMs.embedding).toBe(12);
    expect(out.timingsMs.fts).toBe(8);

    const sym1 = out.candidates.find((c) => c.symbolId === "sym1");
    expect(sym1).toBeDefined();
    expect(sym1!.qualifiedName).toBe("com.foo.Bar");
    expect(sym1!.kind).toBe("class");
    expect(sym1!.stages.fts).toEqual({ rank: 1, score: 0.42 });
    expect(sym1!.stages.semantic).toEqual({ rank: 3, score: 0.88 });
    expect(sym1!.stages.rrf).toEqual({ rank: 1, score: 0.033 });
    expect(sym1!.stages.final).toEqual({ rank: 1, score: 0.05 });

    const sym2 = out.candidates.find((c) => c.symbolId === "sym2");
    expect(sym2!.stages.name).toEqual({ rank: 1, score: 1.0 });
    expect(sym2!.stages.fts).toBeUndefined();
  });

  test("setQuery omits undefined filter fields", () => {
    const t = new SearchTracer();
    t.setQuery("q", { repo: undefined, kind: "class", language: undefined });
    const out = t.toJSON();
    expect(out.query.filters).toEqual({ kind: "class" });
  });

  test("setQuery without filters omits the filters key", () => {
    const t = new SearchTracer();
    t.setQuery("q");
    const out = t.toJSON();
    expect(out.query.filters).toBeUndefined();
  });

  test("toJSON always computes total from construction time", () => {
    const t = new SearchTracer();
    t.setQuery("q");
    const out = t.toJSON();
    expect(out.timingsMs.total).toBeGreaterThanOrEqual(0);
  });

  test("annotate before recordStage still produces a candidate", () => {
    const t = new SearchTracer();
    t.annotate("sym1", "com.foo.Bar", "class");
    t.recordStage("fts", "sym1", 1, 0.5);
    const out = t.toJSON();
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]?.qualifiedName).toBe("com.foo.Bar");
  });
});

describe("shouldTrace", () => {
  test("explicit true wins over env", () => {
    const orig = process.env.YGGDRASIL_TRACE_DEFAULT;
    delete process.env.YGGDRASIL_TRACE_DEFAULT;
    try {
      expect(shouldTrace(true)).toBe(true);
    } finally {
      if (orig !== undefined) process.env.YGGDRASIL_TRACE_DEFAULT = orig;
    }
  });

  test("explicit false wins over env=1", () => {
    const orig = process.env.YGGDRASIL_TRACE_DEFAULT;
    process.env.YGGDRASIL_TRACE_DEFAULT = "1";
    try {
      expect(shouldTrace(false)).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.YGGDRASIL_TRACE_DEFAULT;
      else process.env.YGGDRASIL_TRACE_DEFAULT = orig;
    }
  });

  test("undefined defaults to env value", () => {
    const orig = process.env.YGGDRASIL_TRACE_DEFAULT;
    process.env.YGGDRASIL_TRACE_DEFAULT = "1";
    try {
      expect(shouldTrace(undefined)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.YGGDRASIL_TRACE_DEFAULT;
      else process.env.YGGDRASIL_TRACE_DEFAULT = orig;
    }
  });

  test("undefined and env unset defaults off", () => {
    const orig = process.env.YGGDRASIL_TRACE_DEFAULT;
    delete process.env.YGGDRASIL_TRACE_DEFAULT;
    try {
      expect(shouldTrace(undefined)).toBe(false);
    } finally {
      if (orig !== undefined) process.env.YGGDRASIL_TRACE_DEFAULT = orig;
    }
  });
});

describe("optional-chaining no-op", () => {
  test("undefined tracer is a no-op via ?.", () => {
    let tracer: SearchTracer | undefined;
    tracer?.setQuery("q");
    tracer?.recordStage("fts", "sym", 1, 0.5);
    tracer?.recordTiming("embedding", 10);
    tracer?.annotate("sym", "Foo", "class");
    expect(tracer).toBeUndefined();
  });
});
