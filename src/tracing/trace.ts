export const TRACE_SCHEMA_VERSION = 1;

// =============================================================================
// Discriminated union over per-tool trace shapes.
//
// The `tool` field on typed variants doubles as the discriminator. Any tool not
// covered by a typed variant uses TraceGenericV1, which carries a separate
// `shape: "generic"` discriminator so TypeScript can narrow cleanly even when
// the generic `tool` happens to equal a typed one (which it shouldn't, but TS
// can't prove that).
//
// Note: the `tool` value is the bare yggdrasil tool name ("search", "impact",
// "search_pattern", "detect_changes") — NOT the MCP-prefixed form
// ("mcp__yggdrasil__search" / "yggdrasil-search"). Connector-side renderers
// canonicalise prefixes before dispatching to per-tool panels.
// =============================================================================

export type TraceV1 =
  | TraceSearchV1
  | TraceImpactV1
  | TracePatternV1
  | TraceDetectChangesV1
  | TraceGenericV1;

// -----------------------------------------------------------------------------
// search
// -----------------------------------------------------------------------------

export type TraceSearchStage = "fts" | "semantic" | "name" | "rrf" | "final";
export type TraceSearchTiming = "embedding" | "fts" | "semantic" | "name" | "rrf";

export interface TraceSearchV1 {
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
    stages: Partial<Record<TraceSearchStage, { rank: number; score: number }>>;
  }>;
  timingsMs: Partial<Record<TraceSearchTiming, number>> & { total: number };
}

interface SearchCandidateRecord {
  qualifiedName: string | null;
  kind: string | null;
  stages: Partial<Record<TraceSearchStage, { rank: number; score: number }>>;
}

export class SearchTracer {
  private readonly tStart = performance.now();
  private queryRaw = "";
  private queryFilters: { repo?: string; kind?: string; language?: string } | undefined;
  private readonly candidates = new Map<string, SearchCandidateRecord>();
  private readonly timings: Partial<Record<TraceSearchTiming, number>> = {};

  setQuery(raw: string, filters?: { repo?: string; kind?: string; language?: string }): void {
    this.queryRaw = raw;
    if (filters && Object.values(filters).some((v) => v !== undefined)) {
      this.queryFilters = filters;
    }
  }

  recordStage(stage: TraceSearchStage, symbolId: string, rank: number, score: number): void {
    this.ensure(symbolId).stages[stage] = { rank, score };
  }

  annotate(symbolId: string, qualifiedName: string, kind: string): void {
    const c = this.ensure(symbolId);
    c.qualifiedName = qualifiedName;
    c.kind = kind;
  }

  recordTiming(label: TraceSearchTiming, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TraceSearchV1 {
    const candidates = [...this.candidates.entries()].map(([symbolId, c]) => ({
      symbolId,
      qualifiedName: c.qualifiedName,
      kind: c.kind,
      stages: { ...c.stages },
    }));
    const trace: TraceSearchV1 = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "search",
      query: { raw: this.queryRaw },
      candidates,
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
    if (this.queryFilters) trace.query.filters = this.queryFilters;
    return trace;
  }

  private ensure(symbolId: string): SearchCandidateRecord {
    let c = this.candidates.get(symbolId);
    if (!c) {
      c = { qualifiedName: null, kind: null, stages: {} };
      this.candidates.set(symbolId, c);
    }
    return c;
  }
}

// -----------------------------------------------------------------------------
// impact
// -----------------------------------------------------------------------------

export type TraceImpactTiming = "lookup" | "traversal" | "scoring";

export interface TraceImpactV1 {
  schemaVersion: 1;
  tool: "impact";
  query: { qualifiedName: string; repo?: string; maxDepth: number };
  start: { symbolId: string; qualifiedName: string; kind: string } | null;
  hops: Array<{ depth: number; candidateCount: number }>;
  confidenceBuckets: Array<{ min: number; max: number; count: number }>;
  finalCount: number;
  topResults: Array<{
    symbolId: string;
    qualifiedName: string;
    kind: string;
    depth: number;
    confidence: number;
  }>;
  timingsMs: Partial<Record<TraceImpactTiming, number>> & { total: number };
}

const IMPACT_TOP_RESULTS_CAP = 20;

export class ImpactTracer {
  private readonly tStart = performance.now();
  private query: TraceImpactV1["query"] = { qualifiedName: "", maxDepth: 0 };
  private start: TraceImpactV1["start"] = null;
  private readonly hops: TraceImpactV1["hops"] = [];
  private readonly confidenceBuckets: TraceImpactV1["confidenceBuckets"] = [];
  private finalCount = 0;
  private readonly topResults: TraceImpactV1["topResults"] = [];
  private readonly timings: Partial<Record<TraceImpactTiming, number>> = {};

  setQuery(qualifiedName: string, maxDepth: number, repo?: string): void {
    this.query = { qualifiedName, maxDepth };
    if (repo !== undefined) this.query.repo = repo;
  }

  setStart(symbolId: string, qualifiedName: string, kind: string): void {
    this.start = { symbolId, qualifiedName, kind };
  }

  recordHop(depth: number, candidateCount: number): void {
    this.hops.push({ depth, candidateCount });
  }

  recordConfidenceBucket(min: number, max: number, count: number): void {
    this.confidenceBuckets.push({ min, max, count });
  }

  setFinal(count: number, top: TraceImpactV1["topResults"]): void {
    this.finalCount = count;
    this.topResults.length = 0;
    this.topResults.push(...top.slice(0, IMPACT_TOP_RESULTS_CAP));
  }

  recordTiming(label: TraceImpactTiming, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TraceImpactV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "impact",
      query: { ...this.query },
      start: this.start ? { ...this.start } : null,
      hops: this.hops.map((h) => ({ ...h })),
      confidenceBuckets: this.confidenceBuckets.map((b) => ({ ...b })),
      finalCount: this.finalCount,
      topResults: this.topResults.map((r) => ({ ...r })),
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
  }
}

// -----------------------------------------------------------------------------
// search_pattern
// -----------------------------------------------------------------------------

export type TracePatternTiming = "rg" | "parse";

export interface TracePatternV1 {
  schemaVersion: 1;
  tool: "search_pattern";
  query: {
    pattern: string;
    repo?: string;
    pathGlob?: string;
    maxResults: number;
    contextLines: number;
  };
  invocation: {
    rgArgs: string[];
    repoCount: number;
    repos: string[];
  };
  perRepo: Array<{ repo: string; matchCount: number }>;
  totals: { preTrim: number; returned: number; truncated: boolean };
  timingsMs: Partial<Record<TracePatternTiming, number>> & { total: number };
}

export class PatternTracer {
  private readonly tStart = performance.now();
  private query: TracePatternV1["query"] = {
    pattern: "",
    maxResults: 0,
    contextLines: 0,
  };
  private invocation: TracePatternV1["invocation"] = {
    rgArgs: [],
    repoCount: 0,
    repos: [],
  };
  private readonly perRepo = new Map<string, number>();
  private totals: TracePatternV1["totals"] = { preTrim: 0, returned: 0, truncated: false };
  private readonly timings: Partial<Record<TracePatternTiming, number>> = {};

  setQuery(query: TracePatternV1["query"]): void {
    this.query = { ...query };
  }

  setInvocation(rgArgs: string[], repos: string[]): void {
    this.invocation = { rgArgs: [...rgArgs], repoCount: repos.length, repos: [...repos] };
  }

  incrementRepoMatch(repo: string): void {
    this.perRepo.set(repo, (this.perRepo.get(repo) ?? 0) + 1);
  }

  setTotals(preTrim: number, returned: number, truncated: boolean): void {
    this.totals = { preTrim, returned, truncated };
  }

  recordTiming(label: TracePatternTiming, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TracePatternV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "search_pattern",
      query: { ...this.query },
      invocation: {
        rgArgs: [...this.invocation.rgArgs],
        repoCount: this.invocation.repoCount,
        repos: [...this.invocation.repos],
      },
      perRepo: [...this.perRepo.entries()].map(([repo, matchCount]) => ({ repo, matchCount })),
      totals: { ...this.totals },
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
  }
}

// -----------------------------------------------------------------------------
// detect_changes
// -----------------------------------------------------------------------------

export type TraceDetectChangesTiming = "diff" | "symbolResolution" | "impact";

export interface TraceDetectChangesV1 {
  schemaVersion: 1;
  tool: "detect_changes";
  query: { repo: string; ref?: string };
  diff: { fileCount: number; addedLines: number; removedLines: number };
  symbolsExtracted: Array<{ file: string; symbolCount: number }>;
  impactExpansion: Array<{
    symbolId: string;
    qualifiedName: string;
    affectedCount: number;
  }>;
  totals: { changedSymbols: number; affected: number };
  timingsMs: Partial<Record<TraceDetectChangesTiming, number>> & { total: number };
}

export class DetectChangesTracer {
  private readonly tStart = performance.now();
  private query: TraceDetectChangesV1["query"] = { repo: "" };
  private diff: TraceDetectChangesV1["diff"] = { fileCount: 0, addedLines: 0, removedLines: 0 };
  private readonly symbolsExtracted: TraceDetectChangesV1["symbolsExtracted"] = [];
  private readonly impactExpansion: TraceDetectChangesV1["impactExpansion"] = [];
  private totals: TraceDetectChangesV1["totals"] = { changedSymbols: 0, affected: 0 };
  private readonly timings: Partial<Record<TraceDetectChangesTiming, number>> = {};

  setQuery(repo: string, ref?: string): void {
    this.query = { repo };
    if (ref !== undefined) this.query.ref = ref;
  }

  setDiff(fileCount: number, addedLines: number, removedLines: number): void {
    this.diff = { fileCount, addedLines, removedLines };
  }

  recordFileSymbols(file: string, symbolCount: number): void {
    this.symbolsExtracted.push({ file, symbolCount });
  }

  recordImpact(symbolId: string, qualifiedName: string, affectedCount: number): void {
    this.impactExpansion.push({ symbolId, qualifiedName, affectedCount });
  }

  setTotals(changedSymbols: number, affected: number): void {
    this.totals = { changedSymbols, affected };
  }

  recordTiming(label: TraceDetectChangesTiming, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TraceDetectChangesV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "detect_changes",
      query: { ...this.query },
      diff: { ...this.diff },
      symbolsExtracted: this.symbolsExtracted.map((s) => ({ ...s })),
      impactExpansion: this.impactExpansion.map((i) => ({ ...i })),
      totals: { ...this.totals },
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
  }
}

// -----------------------------------------------------------------------------
// generic (escape hatch for any tool not typed above)
// -----------------------------------------------------------------------------

export interface TraceGenericV1 {
  schemaVersion: 1;
  shape: "generic";
  tool: string;
  events: Array<{ stage: string; durationMs?: number; data?: Record<string, unknown> }>;
  timingsMs: Record<string, number> & { total: number };
}

export class GenericTracer {
  private readonly tStart = performance.now();
  private readonly toolName: string;
  private readonly events: TraceGenericV1["events"] = [];
  private readonly timings: Record<string, number> = {};

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  addEvent(stage: string, opts?: { durationMs?: number; data?: Record<string, unknown> }): void {
    const ev: TraceGenericV1["events"][number] = { stage };
    if (opts?.durationMs !== undefined) ev.durationMs = Math.round(opts.durationMs);
    if (opts?.data !== undefined) ev.data = opts.data;
    this.events.push(ev);
  }

  recordTiming(label: string, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  toJSON(): TraceGenericV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      shape: "generic",
      tool: this.toolName,
      events: this.events.map((e) => ({ ...e })),
      timingsMs: { ...this.timings, total: Math.round(performance.now() - this.tStart) },
    };
  }
}

// -----------------------------------------------------------------------------
// shared
// -----------------------------------------------------------------------------

export function shouldTrace(traceArg: boolean | undefined): boolean {
  if (traceArg !== undefined) return traceArg;
  return process.env.YGGDRASIL_TRACE_DEFAULT === "1";
}
