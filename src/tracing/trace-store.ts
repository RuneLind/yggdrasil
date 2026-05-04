import { randomBytes } from "node:crypto";

const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_MAX_ENTRIES = 10_000;

function ttlFromEnv(fallback = DEFAULT_TTL_SECONDS): number {
  const raw = process.env.YGGDRASIL_TRACE_TTL_SECONDS;
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function pointerModeEnabled(): boolean {
  return process.env.YGGDRASIL_TRACE_POINTER === "1";
}

export function tracePointerLine(traceId: string, port: number): string {
  return `\n\nyggdrasil-trace-url: http://127.0.0.1:${port}/api/trace/${traceId}\n`;
}

interface Entry {
  trace: unknown;
  expiresAt: number;
}

export class TraceStore {
  private readonly ttlSeconds: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts?: { ttlSeconds?: number; maxEntries?: number; clock?: () => number }) {
    this.ttlSeconds = opts?.ttlSeconds ?? ttlFromEnv();
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = opts?.clock ?? (() => performance.now() / 1000);
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  get size(): number {
    return this.entries.size;
  }

  put(trace: unknown): string {
    this.gc();
    if (this.entries.size >= this.maxEntries) {
      let oldestId: string | null = null;
      let oldestExpiry = Infinity;
      for (const [id, entry] of this.entries) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestId = id;
        }
      }
      if (oldestId !== null) this.entries.delete(oldestId);
    }
    const id = randomBytes(8).toString("hex");
    this.entries.set(id, { trace, expiresAt: this.clock() + this.ttlSeconds });
    return id;
  }

  get(id: string): unknown | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(id);
      return null;
    }
    return entry.trace;
  }

  private gc(): void {
    const now = this.clock();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

let _default: TraceStore | null = null;

export function defaultTraceStore(): TraceStore {
  if (_default === null) _default = new TraceStore();
  return _default;
}
