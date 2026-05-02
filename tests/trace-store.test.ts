import { describe, test, expect } from "bun:test";
import { TraceStore, defaultTraceStore } from "../src/tracing/trace-store.ts";

class FakeClock {
  t = 0;
  fn = () => this.t;
}

describe("TraceStore put/get", () => {
  test("put returns 16-hex id", () => {
    const store = new TraceStore({ ttlSeconds: 60 });
    const id = store.put({ foo: "bar" });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("get returns the stored payload", () => {
    const store = new TraceStore({ ttlSeconds: 60 });
    const payload = { schemaVersion: 1, query: { raw: "hi" } };
    const id = store.put(payload);
    expect(store.get(id)).toEqual(payload);
  });

  test("get is non-consumptive for live entries", () => {
    const store = new TraceStore({ ttlSeconds: 60 });
    const id = store.put({ x: 1 });
    expect(store.get(id)).toEqual({ x: 1 });
    expect(store.get(id)).toEqual({ x: 1 });
  });

  test("get unknown id returns null", () => {
    const store = new TraceStore({ ttlSeconds: 60 });
    expect(store.get("0000000000000000")).toBeNull();
  });

  test("distinct puts produce distinct ids", () => {
    const store = new TraceStore({ ttlSeconds: 60 });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(store.put({ i }));
    expect(ids.size).toBe(50);
  });
});

describe("TraceStore TTL", () => {
  test("expired entry returns null and is evicted on read", () => {
    const clock = new FakeClock();
    clock.t = 1000;
    const store = new TraceStore({ ttlSeconds: 60, clock: clock.fn });
    const id = store.put({ x: 1 });
    clock.t = 1061;
    expect(store.get(id)).toBeNull();
    expect(store.size).toBe(0);
  });

  test("entry alive just before expiry", () => {
    const clock = new FakeClock();
    clock.t = 1000;
    const store = new TraceStore({ ttlSeconds: 60, clock: clock.fn });
    const id = store.put({ x: 1 });
    clock.t = 1059.999;
    expect(store.get(id)).toEqual({ x: 1 });
  });

  test("entry exactly at expiry boundary is dead", () => {
    const clock = new FakeClock();
    clock.t = 1000;
    const store = new TraceStore({ ttlSeconds: 60, clock: clock.fn });
    const id = store.put({ x: 1 });
    clock.t = 1060;
    expect(store.get(id)).toBeNull();
  });

  test("put GCs expired entries", () => {
    const clock = new FakeClock();
    const store = new TraceStore({ ttlSeconds: 10, clock: clock.fn });
    store.put({ a: 1 });
    store.put({ b: 2 });
    clock.t = 11;
    store.put({ c: 3 });
    expect(store.size).toBe(1);
  });
});

describe("TraceStore overflow", () => {
  test("max-entries overflow evicts soonest-to-expire", () => {
    const clock = new FakeClock();
    const store = new TraceStore({ ttlSeconds: 100, maxEntries: 2, clock: clock.fn });
    clock.t = 0;
    const first = store.put({ i: 0 });
    clock.t = 1;
    const second = store.put({ i: 1 });
    clock.t = 2;
    store.put({ i: 2 });
    expect(store.get(first)).toBeNull();
    expect(store.get(second)).toEqual({ i: 1 });
    expect(store.size).toBe(2);
  });
});

describe("TraceStore env", () => {
  test("YGGDRASIL_TRACE_TTL_SECONDS overrides default", () => {
    const orig = process.env.YGGDRASIL_TRACE_TTL_SECONDS;
    process.env.YGGDRASIL_TRACE_TTL_SECONDS = "42";
    try {
      const store = new TraceStore();
      expect(store.ttl).toBe(42);
    } finally {
      if (orig === undefined) delete process.env.YGGDRASIL_TRACE_TTL_SECONDS;
      else process.env.YGGDRASIL_TRACE_TTL_SECONDS = orig;
    }
  });

  test("invalid YGGDRASIL_TRACE_TTL_SECONDS falls back to default", () => {
    const orig = process.env.YGGDRASIL_TRACE_TTL_SECONDS;
    process.env.YGGDRASIL_TRACE_TTL_SECONDS = "not-a-number";
    try {
      const store = new TraceStore();
      expect(store.ttl).toBe(300);
    } finally {
      if (orig === undefined) delete process.env.YGGDRASIL_TRACE_TTL_SECONDS;
      else process.env.YGGDRASIL_TRACE_TTL_SECONDS = orig;
    }
  });

  test("negative YGGDRASIL_TRACE_TTL_SECONDS falls back to default", () => {
    const orig = process.env.YGGDRASIL_TRACE_TTL_SECONDS;
    process.env.YGGDRASIL_TRACE_TTL_SECONDS = "-5";
    try {
      const store = new TraceStore();
      expect(store.ttl).toBe(300);
    } finally {
      if (orig === undefined) delete process.env.YGGDRASIL_TRACE_TTL_SECONDS;
      else process.env.YGGDRASIL_TRACE_TTL_SECONDS = orig;
    }
  });
});

describe("defaultTraceStore", () => {
  test("returns the same singleton", () => {
    expect(defaultTraceStore()).toBe(defaultTraceStore());
  });
});
