import type { EdgeNeighbor } from "../db/edges.ts";
import type { ImpactEntry } from "./impact.ts";

/** A caller; `via` is the ancestor method it calls when the call reaches the symbol by dispatch. */
export type CallerNeighbor = EdgeNeighbor & { via?: string };

/** A symbol's edges by kind. overrides: the ancestor methods it overrides; overridden_by: its implementations. */
export function edgeBuckets(incoming: EdgeNeighbor[], outgoing: EdgeNeighbor[]) {
  const of = (edges: EdgeNeighbor[], kind: string) => edges.filter((e) => e.kind === kind);
  return {
    callers: of(incoming, "calls") as CallerNeighbor[],
    callees: of(outgoing, "calls"),
    extends: of(outgoing, "extends"),
    implements: of(outgoing, "implements"),
    extended_by: of(incoming, "extends"),
    implemented_by: of(incoming, "implements"),
    overrides: of(outgoing, "overrides"),
    overridden_by: of(incoming, "overrides"),
  };
}

/**
 * Direct callers plus the depth-1 callers impact reached by dispatch (they call an
 * ancestor method this one overrides), each once.
 */
export function withDispatchedCallers(direct: EdgeNeighbor[], affected: ImpactEntry[]): CallerNeighbor[] {
  const seen = new Set(direct.map((e) => e.symbol_id));
  const dispatched: CallerNeighbor[] = affected
    .filter((a) => a.depth === 1 && a.via !== null && !seen.has(a.id))
    .map((a) => ({
      symbol_id: a.id, kind: "calls", name: a.name, qualified_name: a.qualified_name,
      file_path: a.file_path, repo_name: a.repo_name, via: a.via!,
    }));
  return [...direct, ...dispatched];
}
