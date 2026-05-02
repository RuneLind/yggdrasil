export const TRACE_SCHEMA_VERSION = 1;

export type TraceStage = "fts" | "semantic" | "name" | "rrf" | "final";

export type TraceTiming = "embedding" | "fts" | "semantic" | "name" | "rrf";

export interface TraceV1 {
  schemaVersion: 1;
  tool: "search";
  query: {
    raw: string;
    filters?: { repo?: string; kind?: string; language?: string };
  };
  candidates: Array<{
    symbolId: string;
    qualifiedName: string | null;
    kind: string | null;
    stages: Partial<Record<TraceStage, { rank: number; score: number }>>;
  }>;
  timingsMs: Partial<Record<TraceTiming, number>> & { total: number };
}

interface CandidateRecord {
  qualifiedName: string | null;
  kind: string | null;
  stages: Partial<Record<TraceStage, { rank: number; score: number }>>;
}

export class Tracer {
  private readonly tStart = performance.now();
  private queryRaw = "";
  private queryFilters: { repo?: string; kind?: string; language?: string } | undefined;
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly timings: Partial<Record<TraceTiming, number>> = {};

  setQuery(raw: string, filters?: { repo?: string; kind?: string; language?: string }): void {
    this.queryRaw = raw;
    if (filters && Object.values(filters).some((v) => v !== undefined)) {
      this.queryFilters = filters;
    }
  }

  recordStage(stage: TraceStage, symbolId: string, rank: number, score: number): void {
    this.ensure(symbolId).stages[stage] = { rank, score };
  }

  annotate(symbolId: string, qualifiedName: string, kind: string): void {
    const c = this.ensure(symbolId);
    c.qualifiedName = qualifiedName;
    c.kind = kind;
  }

  recordTiming(label: TraceTiming, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TraceV1 {
    const candidates = [...this.candidates.entries()].map(([symbolId, c]) => ({
      symbolId,
      qualifiedName: c.qualifiedName,
      kind: c.kind,
      stages: { ...c.stages },
    }));
    const trace: TraceV1 = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "search",
      query: { raw: this.queryRaw },
      candidates,
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
    if (this.queryFilters) trace.query.filters = this.queryFilters;
    return trace;
  }

  private ensure(symbolId: string): CandidateRecord {
    let c = this.candidates.get(symbolId);
    if (!c) {
      c = { qualifiedName: null, kind: null, stages: {} };
      this.candidates.set(symbolId, c);
    }
    return c;
  }
}

export function shouldTrace(traceArg: boolean | undefined): boolean {
  if (traceArg !== undefined) return traceArg;
  return process.env.YGGDRASIL_TRACE_DEFAULT === "1";
}
