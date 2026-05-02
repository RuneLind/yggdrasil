import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { TraceStore, tracePointerLine } from "../src/tracing/trace-store.ts";
import { Tracer } from "../src/tracing/trace.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let store: TraceStore;
let baseUrl: string;

beforeAll(() => {
  store = new TraceStore({ ttlSeconds: 60 });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/trace/")) {
        const id = url.pathname.slice("/api/trace/".length);
        const trace = store.get(id);
        if (!trace) {
          return Response.json({ detail: "trace not found or expired" }, { status: 404 });
        }
        return Response.json(trace);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

describe("/api/trace/<id> endpoint", () => {
  test("round-trip: put a tracer's JSON, fetch it back unchanged", async () => {
    const tracer = new Tracer();
    tracer.setQuery("hva er LA_BUC_02", { repo: "melosys-eessi" });
    tracer.recordStage("fts", "sym1", 1, 0.42);
    tracer.recordStage("semantic", "sym1", 3, 0.88);
    tracer.recordStage("rrf", "sym1", 1, 0.033);
    tracer.recordStage("final", "sym1", 1, 0.05);
    tracer.annotate("sym1", "com.foo.Bar", "class");
    tracer.recordTiming("total", 38);
    const traceJson = tracer.toJSON();

    const id = store.put(traceJson);
    const res = await fetch(`${baseUrl}/api/trace/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(traceJson);
  });

  test("missing id returns 404 with {detail}", async () => {
    const res = await fetch(`${baseUrl}/api/trace/0000000000000000`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("detail");
    expect(typeof body.detail).toBe("string");
  });

  test("get is non-consumptive: same id can be fetched twice", async () => {
    const tracer = new Tracer();
    tracer.setQuery("retry me");
    const id = store.put(tracer.toJSON());
    const a = await fetch(`${baseUrl}/api/trace/${id}`);
    const b = await fetch(`${baseUrl}/api/trace/${id}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });
});

describe("pointer line format", () => {
  test("matches the contract muninn parser expects", () => {
    const id = "abcdef0123456789";
    const line = tracePointerLine(id, 9130);
    expect(line.startsWith("\n\n")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(2, -1)).toBe(`yggdrasil-trace-url: http://127.0.0.1:9130/api/trace/${id}`);
  });
});
