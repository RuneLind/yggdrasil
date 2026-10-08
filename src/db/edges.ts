import { sql } from "./connection.ts";

export type EdgeKind = "calls" | "extends" | "implements" | "imports" | "overrides";

export interface CiEdge {
  id: string;
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  line: number | null;
  resolution: EdgeResolution | null;
}

/** How a calls edge was resolved (see rebuildEdges); null for other edge kinds. */
export type EdgeResolution = "local" | "static" | "typed" | "chain";

export interface EdgeInsert {
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  line?: number | null;
}

export async function insertEdgesBatch(edges: EdgeInsert[]): Promise<void> {
  if (edges.length === 0) return;

  await sql`
    INSERT INTO ci_edges ${sql(
      edges.map((e) => ({
        source_id: e.source_id,
        target_id: e.target_id,
        kind: e.kind,
        line: e.line ?? null,
      })),
      "source_id",
      "target_id",
      "kind",
      "line",
    )}
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
}

export async function insertEdgesInBatches(edges: EdgeInsert[], batchSize = 500): Promise<void> {
  for (let i = 0; i < edges.length; i += batchSize) {
    await insertEdgesBatch(edges.slice(i, i + batchSize));
  }
}

export interface EdgeNeighbor {
  symbol_id: string;
  kind: EdgeKind;
  name: string;
  qualified_name: string;
  file_path: string;
  repo_name: string;
}

export async function getIncomingEdges(symbolId: string): Promise<EdgeNeighbor[]> {
  return sql`
    SELECT e.source_id AS symbol_id, e.kind, s.name, s.qualified_name, f.path as file_path, r.name as repo_name
    FROM ci_edges e
    JOIN ci_symbols s ON s.id = e.source_id
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE e.target_id = ${symbolId}
  `;
}

export async function getOutgoingEdges(symbolId: string): Promise<EdgeNeighbor[]> {
  return sql`
    SELECT e.target_id AS symbol_id, e.kind, s.name, s.qualified_name, f.path as file_path, r.name as repo_name
    FROM ci_edges e
    JOIN ci_symbols s ON s.id = e.target_id
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    WHERE e.source_id = ${symbolId}
  `;
}

export interface ImpactRow {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  repo_name: string;
  depth: number;
  edge_kind: string;
  resolution: EdgeResolution | null;
  /** The ancestor method a dispatched call went through (see getImpact); null otherwise. */
  via_id: string | null;
  via: string | null;
}

/**
 * Blast radius: incoming edges, transitively, up to maxDepth hops. Direct callers are at
 * depth 1 (the changed symbol itself is depth 0 and never listed).
 *
 * Dispatch: at each step the reached symbol also stands for every ancestor method it
 * overrides, whose incoming `calls` edges count as if they pointed at it, with `via` set
 * to that ancestor. Overrides edges run from each method to every ancestor declaration,
 * so this is one hop. Incoming `overrides` edges are ordinary edges: impact of an
 * interface method lists each implementation with edge_kind `overrides`.
 *
 * PostgreSQL allows one recursive reference, so the dispatch step is a LATERAL inside the
 * recursive term. The join stays an equality on target_id, which keeps
 * idx_ci_edges_target; an `OR target_id IN (…)` join measured 756 ms against 1.2 ms
 * (ÅrsavregningService class seed, depth 3, melosys-api).
 */
export async function getImpact(symbolId: string, maxDepth = 3): Promise<ImpactRow[]> {
  return sql<ImpactRow[]>`
    WITH RECURSIVE impact AS (
      SELECT e.source_id AS id, 1 AS depth, e.kind AS edge_kind, e.resolution,
        CASE WHEN t.via THEN t.tid END AS via_id
      FROM (
        SELECT ${symbolId}::uuid AS tid, false AS via
        UNION ALL
        SELECT o.target_id, true FROM ci_edges o WHERE o.kind = 'overrides' AND o.source_id = ${symbolId}
      ) t
      JOIN ci_edges e ON e.target_id = t.tid AND (NOT t.via OR e.kind = 'calls')

      UNION

      SELECT e.source_id, i.depth + 1, e.kind, e.resolution, CASE WHEN t.via THEN t.tid END
      FROM impact i
      CROSS JOIN LATERAL (
        SELECT i.id AS tid, false AS via
        UNION ALL
        SELECT o.target_id, true FROM ci_edges o WHERE o.kind = 'overrides' AND o.source_id = i.id
      ) t
      JOIN ci_edges e ON e.target_id = t.tid AND (NOT t.via OR e.kind = 'calls')
      WHERE i.depth < ${maxDepth}
    ),
    shallowest AS (
      SELECT DISTINCT ON (id) * FROM impact
      ORDER BY id, depth, (via_id IS NOT NULL), edge_kind, resolution
    )
    SELECT s.id, s.name, s.qualified_name, s.kind, f.path AS file_path, r.name AS repo_name,
      i.depth, i.edge_kind, i.resolution, i.via_id, v.qualified_name AS via
    FROM shallowest i
    JOIN ci_symbols s ON s.id = i.id
    JOIN ci_files f ON f.id = s.file_id
    JOIN ci_repos r ON r.id = f.repo_id
    LEFT JOIN ci_symbols v ON v.id = i.via_id
    ORDER BY s.id
  `;
}
