import { findSymbolByQualifiedName } from "../db/symbols.ts";
import { getImpact as getImpactEdges } from "../db/edges.ts";
import { timed, type ImpactTracer } from "../tracing/trace.ts";

export interface ImpactResult {
  symbol: {
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    repo_name: string;
  };
  affected: ImpactEntry[];
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

/** Analyze blast radius for a symbol. */
export async function analyzeImpact(
  qualifiedName: string,
  options?: { repo?: string; maxDepth?: number; tracer?: ImpactTracer },
): Promise<ImpactResult | null> {
  const maxDepth = options?.maxDepth ?? 3;
  const tracer = options?.tracer;
  tracer?.setQuery(qualifiedName, maxDepth, options?.repo);

  const symbols = await timed(tracer, "lookup", findSymbolByQualifiedName(qualifiedName, options?.repo));
  if (symbols.length === 0) return null;

  const target = symbols[0];
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
  const affected: ImpactEntry[] = raw.map((r) => ({
    id: r.id,
    name: r.name,
    qualified_name: r.qualified_name,
    kind: r.kind,
    file_path: r.file_path,
    repo_name: r.repo_name,
    depth: r.depth,
    edge_kind: r.edge_kind,
    confidence: confidenceScore(r.depth, r.edge_kind),
  }));
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
    },
    affected,
  };
}
