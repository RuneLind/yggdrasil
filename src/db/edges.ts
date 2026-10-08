import { sql } from "./connection.ts";

export type EdgeKind = "calls" | "extends" | "implements" | "imports";

export interface CiEdge {
  id: string;
  source_id: string;
  target_id: string;
  kind: EdgeKind;
  line: number | null;
  resolution: EdgeResolution | null;
}

/** How a calls edge was resolved (see rebuildEdges); null for other edge kinds. */
export type EdgeResolution = "local" | "static" | "typed";

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

/** Blast radius — transitive closure of incoming edges up to maxDepth */
export async function getImpact(
  symbolId: string,
  maxDepth = 3,
): Promise<{ id: string; name: string; qualified_name: string; kind: string; file_path: string; repo_name: string; depth: number; edge_kind: string; resolution: EdgeResolution | null }[]> {
  return sql`
    WITH RECURSIVE impact AS (
      -- Direct callers seed at depth 1 (depth 0 is the changed symbol itself), and
      -- recursing WHERE i.depth < maxDepth yields hops 1..maxDepth — i.e. exactly
      -- maxDepth hops of callers. (The old seed of 0 yielded 0..maxDepth: one hop too
      -- deep, and it scored direct callers 1.0 — indistinguishable from the changed
      -- symbol itself. This change is intentionally both a relabel *and* a one-hop
      -- reach correction, so maxDepth now means precisely that many caller hops.)
      SELECT
        s.id, s.name, s.qualified_name, s.kind,
        f.path as file_path, r.name as repo_name,
        1 as depth, e.kind as edge_kind, e.resolution
      FROM ci_edges e
      JOIN ci_symbols s ON s.id = e.source_id
      JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE e.target_id = ${symbolId}

      UNION

      SELECT
        s.id, s.name, s.qualified_name, s.kind,
        f.path as file_path, r.name as repo_name,
        i.depth + 1, e.kind as edge_kind, e.resolution
      FROM ci_edges e
      JOIN ci_symbols s ON s.id = e.source_id
      JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      JOIN impact i ON e.target_id = i.id
      WHERE i.depth < ${maxDepth}
    )
    SELECT DISTINCT ON (id) * FROM impact ORDER BY id, depth, edge_kind, resolution
  `;
}
