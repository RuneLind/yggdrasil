import { findSymbolByQualifiedName } from "../db/symbols.ts";
import { getImpact as getImpactEdges } from "../db/edges.ts";

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

/** Analyze blast radius for a symbol. */
export async function analyzeImpact(
  qualifiedName: string,
  options?: { repo?: string; maxDepth?: number },
): Promise<ImpactResult | null> {
  const maxDepth = options?.maxDepth ?? 3;

  // Find the target symbol
  const symbols = await findSymbolByQualifiedName(qualifiedName, options?.repo);
  if (symbols.length === 0) return null;

  const target = symbols[0];

  // Get transitive incoming edges
  const raw = await getImpactEdges(target.id, maxDepth);

  const affected: ImpactEntry[] = raw.map((r) => ({
    name: r.name,
    qualified_name: r.qualified_name,
    kind: r.kind,
    file_path: r.file_path,
    repo_name: r.repo_name,
    depth: r.depth,
    edge_kind: r.edge_kind,
    confidence: confidenceScore(r.depth, r.edge_kind),
  }));

  // Sort by confidence desc, then depth asc
  affected.sort((a, b) => b.confidence - a.confidence || a.depth - b.depth);

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
