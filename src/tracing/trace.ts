export const TRACE_SCHEMA_VERSION = 1;

// `tool` doubles as the discriminator on typed variants. TraceGenericV1 carries
// a separate `shape: "generic"` field so TS narrowing stays clean even if a
// generic tracer's `tool` happens to collide with a typed variant's name.
//
// `tool` is the bare yggdrasil tool name ("search", "impact", "search_pattern",
// "detect_changes") — NOT the MCP-prefixed form. Connector-side renderers
// canonicalise prefixes before dispatching to per-tool panels.

export type TraceV1 =
  | TraceSearchV1
  | TraceImpactV1
  | TracePatternV1
  | TraceDetectChangesV1
  | TraceGenericV1;

abstract class BaseTracer<TLabel extends string> {
  protected readonly tStart = performance.now();
  protected readonly timings: Partial<Record<TLabel, number>> = {};

  recordTiming(label: TLabel, ms: number): void {
    this.timings[label] = Math.round(ms);
  }

  protected buildTimings(): Partial<Record<TLabel, number>> & { total: number } {
    return { ...this.timings, total: Math.round(performance.now() - this.tStart) };
  }
}

/** Wrap a promise to record its duration on the tracer when present. Zero overhead when tracer is undefined. */
export function timed<TLabel extends string, T>(
  tracer: BaseTracer<TLabel> | undefined,
  label: TLabel,
  p: Promise<T>,
): Promise<T> {
  if (!tracer) return p;
  const t = performance.now();
  return p.then((r) => {
    tracer.recordTiming(label, performance.now() - t);
    return r;
  });
}

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

export class SearchTracer extends BaseTracer<TraceSearchTiming> {
  private queryRaw = "";
  private queryFilters: { repo?: string; kind?: string; language?: string } | undefined;
  private readonly candidates = new Map<string, SearchCandidateRecord>();

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
      timingsMs: this.buildTimings(),
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
    /** ci_edges.resolution of the edge that reached it: local | static | typed, null otherwise. */
    resolution: string | null;
    confidence: number;
  }>;
  timingsMs: Partial<Record<TraceImpactTiming, number>> & { total: number };
}

const IMPACT_TOP_RESULTS_CAP = 20;

export class ImpactTracer extends BaseTracer<TraceImpactTiming> {
  private query: TraceImpactV1["query"] = { qualifiedName: "", maxDepth: 0 };
  private start: TraceImpactV1["start"] = null;
  private readonly hops: TraceImpactV1["hops"] = [];
  private readonly confidenceBuckets: TraceImpactV1["confidenceBuckets"] = [];
  private finalCount = 0;
  private readonly topResults: TraceImpactV1["topResults"] = [];

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
    for (let i = 0; i < top.length && i < IMPACT_TOP_RESULTS_CAP; i++) {
      this.topResults.push(top[i]);
    }
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
      timingsMs: this.buildTimings(),
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
    repos: string[];
  };
  perRepo: Array<{ repo: string; matchCount: number }>;
  totals: { preTrim: number; returned: number; truncated: boolean };
  timingsMs: Partial<Record<TracePatternTiming, number>> & { total: number };
}

export class PatternTracer extends BaseTracer<TracePatternTiming> {
  private query: TracePatternV1["query"] = {
    pattern: "",
    maxResults: 0,
    contextLines: 0,
  };
  private invocation: TracePatternV1["invocation"] = { rgArgs: [], repos: [] };
  private readonly perRepo = new Map<string, number>();
  private totals: TracePatternV1["totals"] = { preTrim: 0, returned: 0, truncated: false };

  setQuery(query: TracePatternV1["query"]): void {
    this.query = { ...query };
  }

  setInvocation(rgArgs: string[], repos: string[]): void {
    this.invocation = { rgArgs: [...rgArgs], repos: [...repos] };
  }

  incrementRepoMatch(repo: string): void {
    this.perRepo.set(repo, (this.perRepo.get(repo) ?? 0) + 1);
  }

  setTotals(preTrim: number, returned: number, truncated: boolean): void {
    this.totals = { preTrim, returned, truncated };
  }

  toJSON(): TracePatternV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "search_pattern",
      query: { ...this.query },
      invocation: { rgArgs: [...this.invocation.rgArgs], repos: [...this.invocation.repos] },
      perRepo: [...this.perRepo.entries()].map(([repo, matchCount]) => ({ repo, matchCount })),
      totals: { ...this.totals },
      timingsMs: this.buildTimings(),
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
  /** side: which diff side's hunk lines were intersected ("base" = review mode). */
  query: { repo: string; ref?: string; side?: "base" | "head" };
  /** Resolved commits; head is null when the diff's head is the working tree. */
  refs?: { base: string; head: string | null };
  warnings?: string[];
  diff: { fileCount: number; addedLines: number; removedLines: number };
  symbolsExtracted: Array<{ file: string; symbolCount: number }>;
  /** Containers dropped from the changed set because a member of theirs changed. */
  droppedContainers?: string[];
  impactExpansion: Array<{
    symbolId: string;
    qualifiedName: string;
    affectedCount: number;
  }>;
  totals: { changedSymbols: number; affected: number };
  /** Affected symbols per edge_kind of the edge that reached them. */
  affectedByEdgeKind?: Record<string, number>;
  timingsMs: Partial<Record<TraceDetectChangesTiming, number>> & { total: number };
}

export class DetectChangesTracer extends BaseTracer<TraceDetectChangesTiming> {
  private query: TraceDetectChangesV1["query"] = { repo: "" };
  private diff: TraceDetectChangesV1["diff"] = { fileCount: 0, addedLines: 0, removedLines: 0 };
  private readonly symbolsExtracted: TraceDetectChangesV1["symbolsExtracted"] = [];
  private readonly impactExpansion: TraceDetectChangesV1["impactExpansion"] = [];
  private totals: TraceDetectChangesV1["totals"] = { changedSymbols: 0, affected: 0 };
  private refs: TraceDetectChangesV1["refs"];
  private readonly warnings: string[] = [];
  private readonly droppedContainers: string[] = [];
  private readonly affectedByEdgeKind: Record<string, number> = {};

  setQuery(repo: string, ref?: string, side?: "base" | "head"): void {
    this.query = { repo };
    if (ref !== undefined) this.query.ref = ref;
    if (side !== undefined) this.query.side = side;
  }

  setRefs(base: string, head: string | null): void {
    this.refs = { base, head };
  }

  recordWarning(warning: string): void {
    this.warnings.push(warning);
  }

  recordDroppedContainer(qualifiedName: string): void {
    this.droppedContainers.push(qualifiedName);
  }

  countAffectedEdgeKind(edgeKind: string): void {
    this.affectedByEdgeKind[edgeKind] = (this.affectedByEdgeKind[edgeKind] ?? 0) + 1;
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

  toJSON(): TraceDetectChangesV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      tool: "detect_changes",
      query: { ...this.query },
      ...(this.refs ? { refs: { ...this.refs } } : {}),
      warnings: [...this.warnings],
      diff: { ...this.diff },
      symbolsExtracted: this.symbolsExtracted.map((s) => ({ ...s })),
      droppedContainers: [...this.droppedContainers],
      impactExpansion: this.impactExpansion.map((i) => ({ ...i })),
      totals: { ...this.totals },
      affectedByEdgeKind: { ...this.affectedByEdgeKind },
      timingsMs: this.buildTimings(),
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

export class GenericTracer extends BaseTracer<string> {
  private readonly toolName: string;
  private readonly events: TraceGenericV1["events"] = [];

  constructor(toolName: string) {
    super();
    this.toolName = toolName;
  }

  addEvent(stage: string, opts?: { durationMs?: number; data?: Record<string, unknown> }): void {
    const ev: TraceGenericV1["events"][number] = { stage };
    if (opts?.durationMs !== undefined) ev.durationMs = Math.round(opts.durationMs);
    if (opts?.data !== undefined) ev.data = opts.data;
    this.events.push(ev);
  }

  toJSON(): TraceGenericV1 {
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      shape: "generic",
      tool: this.toolName,
      events: this.events.map((e) => ({ ...e })),
      timingsMs: this.buildTimings() as Record<string, number> & { total: number },
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
