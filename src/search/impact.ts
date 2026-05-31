import { findSymbolByQualifiedName, getSymbolById, type CiSymbol } from "../db/symbols.ts";
import { getImpact as getImpactEdges } from "../db/edges.ts";
import { timed, type ImpactTracer } from "../tracing/trace.ts";
import { classifyArchetype, filterByArchetypeExclude, type Archetype } from "./archetype.ts";

export interface ImpactResult {
  symbol: {
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    repo_name: string;
    archetype: Archetype;
  };
  affected: ImpactEntry[];
  archetype_counts: Partial<Record<Archetype, number>>;
}

export interface ImpactEntry {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  repo_name: string;
  depth: number;
  edge_kind: string;
  confidence: number;
  archetype: Archetype;
}

/** Confidence scoring by depth. Structural edges (extends/implements) get a boost. */
function confidenceScore(depth: number, edgeKind: string): number {
  const baseScore: Record<number, number> = { 0: 1.0, 1: 0.7, 2: 0.4, 3: 0.2 };
  const base = baseScore[depth] ?? 0.1;
  const structuralBoost =
    edgeKind === "extends" || edgeKind === "implements" ? 0.2 : 0;
  return Math.min(1.0, base + structuralBoost);
}

const CONFIDENCE_BUCKETS: Array<{ min: number; max: number }> = [
  { min: 0.8, max: 1.0 },
  { min: 0.6, max: 0.8 },
  { min: 0.4, max: 0.6 },
  { min: 0.2, max: 0.4 },
  { min: 0.0, max: 0.2 },
];

type ResolvedTarget = CiSymbol & { file_path: string; repo_name: string };

interface ImpactCoreOptions {
  tracer?: ImpactTracer;
  archetypeExclude?: Archetype[];
}

/** Analyze blast radius for a symbol, resolving it by qualified name (takes the
 *  deterministic first match — see findSymbolByQualifiedName). */
export async function analyzeImpact(
  qualifiedName: string,
  options?: { repo?: string; maxDepth?: number; tracer?: ImpactTracer; archetypeExclude?: Archetype[] },
): Promise<ImpactResult | null> {
  const maxDepth = options?.maxDepth ?? 3;
  const tracer = options?.tracer;
  tracer?.setQuery(qualifiedName, maxDepth, options?.repo);

  const symbols = await timed(tracer, "lookup", findSymbolByQualifiedName(qualifiedName, options?.repo));
  if (symbols.length === 0) return null;

  return impactForTarget(symbols[0], maxDepth, {
    tracer,
    archetypeExclude: options?.archetypeExclude,
  });
}

/** Analyze blast radius for an already-resolved symbol id. Avoids the lossy
 *  re-resolution by qualified_name (overloads / multi-repo collisions) for callers
 *  that already hold a concrete id, so target, edges, and blast radius all describe
 *  the same symbol. */
export async function analyzeImpactBySymbolId(
  symbolId: string,
  options?: { maxDepth?: number; tracer?: ImpactTracer; archetypeExclude?: Archetype[] },
): Promise<ImpactResult | null> {
  const maxDepth = options?.maxDepth ?? 3;
  const tracer = options?.tracer;

  const target = await timed(tracer, "lookup", getSymbolById(symbolId));
  if (!target) return null;
  tracer?.setQuery(target.qualified_name, maxDepth);

  return impactForTarget(target, maxDepth, {
    tracer,
    archetypeExclude: options?.archetypeExclude,
  });
}

/** Shared blast-radius core: traverse incoming edges from a resolved target, score
 *  by depth, tag archetypes, and (optionally) record the trace. */
async function impactForTarget(
  target: ResolvedTarget,
  maxDepth: number,
  options: ImpactCoreOptions,
): Promise<ImpactResult> {
  const tracer = options.tracer;
  tracer?.setStart(target.id, target.qualified_name, target.kind);

  const raw = await timed(tracer, "traversal", getImpactEdges(target.id, maxDepth));

  if (tracer) {
    const hopCounts = new Map<number, number>();
    for (const r of raw) hopCounts.set(r.depth, (hopCounts.get(r.depth) ?? 0) + 1);
    [...hopCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([depth, count]) => tracer.recordHop(depth, count));
  }

  const tScoringStart = performance.now();
  const taggedAll: ImpactEntry[] = raw.map((r) => ({
    id: r.id,
    name: r.name,
    qualified_name: r.qualified_name,
    kind: r.kind,
    file_path: r.file_path,
    repo_name: r.repo_name,
    depth: r.depth,
    edge_kind: r.edge_kind,
    confidence: confidenceScore(r.depth, r.edge_kind),
    archetype: classifyArchetype(r),
  }));

  // Compute archetype distribution over the pre-filter set so callers can see what
  // got excluded (vital for "why did my filter return 0 hits?" diagnostics).
  const archetype_counts: Partial<Record<Archetype, number>> = {};
  for (const e of taggedAll) {
    archetype_counts[e.archetype] = (archetype_counts[e.archetype] ?? 0) + 1;
  }

  const affected = filterByArchetypeExclude(taggedAll, options.archetypeExclude);
  affected.sort((a, b) => b.confidence - a.confidence || a.depth - b.depth);
  tracer?.recordTiming("scoring", performance.now() - tScoringStart);

  if (tracer) {
    for (const bucket of CONFIDENCE_BUCKETS) {
      const count = affected.filter((a) => {
        // Top bucket [0.8, 1.0] is closed on the right; others half-open [min, max).
        return bucket.max === 1.0
          ? a.confidence >= bucket.min && a.confidence <= bucket.max
          : a.confidence >= bucket.min && a.confidence < bucket.max;
      }).length;
      tracer.recordConfidenceBucket(bucket.min, bucket.max, count);
    }
    tracer.setFinal(
      affected.length,
      affected.map((a) => ({
        symbolId: a.id,
        qualifiedName: a.qualified_name,
        kind: a.kind,
        depth: a.depth,
        confidence: a.confidence,
      })),
    );
  }

  return {
    symbol: {
      name: target.name,
      qualified_name: target.qualified_name,
      kind: target.kind,
      file_path: target.file_path,
      repo_name: target.repo_name,
      archetype: classifyArchetype(target),
    },
    affected,
    archetype_counts,
  };
}
