/**
 * Pure Reciprocal Rank Fusion + kind weighting for hybrid search.
 *
 * Kept I/O-free so the ranking math can be table-driven without a DB. The caller
 * (hybrid-search.ts) supplies the per-leg ranked id lists and a id→kind map for the
 * *whole* candidate pool, so the kind boost is applied before the pool is sliced to
 * `limit` — otherwise a high-value kind (class, 1.5) just below the cutoff could never
 * overtake a low-value kind (property, 0.7) just above it.
 */

export const RRF_K = 60;

/** Per-kind multiplier applied to the fused RRF score before final ranking. */
export const DEFAULT_KIND_BOOST: Record<string, number> = {
  class: 1.5,
  interface: 1.5,
  enum: 1.4,
  method: 1.2,
  function: 1.2,
  constructor: 1.1,
  object: 1.3,
  type: 1.3,
  property: 0.7,
  field: 0.7,
};

export interface RankedId {
  id: string;
  rank: number;
}

export interface FuseLeg {
  results: RankedId[];
  weight: number;
}

export interface FusedCandidate {
  id: string;
  /** Pre-boost RRF score (sum of weight/(k+idx+1) across legs). */
  rrfScore: number;
  /** Post kind-boost score used for the final ranking. */
  score: number;
}

export interface FuseResult {
  /** All candidates ordered by raw RRF score (the pre-boost ranking). */
  rrfRanked: FusedCandidate[];
  /** All candidates ordered by post-boost score (slice to `limit` for the result). */
  boosted: FusedCandidate[];
}

/**
 * Fuse the legs via RRF, then apply the per-kind boost over the entire candidate
 * pool. Returns both orderings (pre-boost for tracing, post-boost for the result).
 * Ties break by id ascending so the output is deterministic.
 */
export function fuseAndRank(
  legs: FuseLeg[],
  kindById: Map<string, string>,
  opts?: { k?: number; kindBoost?: Record<string, number> },
): FuseResult {
  const k = opts?.k ?? RRF_K;
  const kindBoost = opts?.kindBoost ?? DEFAULT_KIND_BOOST;

  const rrf = new Map<string, number>();
  for (const leg of legs) {
    leg.results.forEach((r, idx) => {
      const inc = leg.weight / (k + idx + 1);
      rrf.set(r.id, (rrf.get(r.id) ?? 0) + inc);
    });
  }

  const candidates: FusedCandidate[] = [...rrf.entries()].map(([id, rrfScore]) => ({
    id,
    rrfScore,
    score: rrfScore * (kindBoost[kindById.get(id) ?? ""] ?? 1.0),
  }));

  const rrfRanked = [...candidates].sort(
    (a, b) => b.rrfScore - a.rrfScore || a.id.localeCompare(b.id),
  );
  const boosted = [...candidates].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );

  return { rrfRanked, boosted };
}
