import { sql } from "../db/connection.ts";
import type postgres from "postgres";
import { CONTAINER_KINDS } from "./symbol-extractor.ts";
import type { CallGraphResult } from "./call-graph.ts";
import type { ExtractedSymbol } from "./symbol-extractor.ts";

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["method", "function", "constructor"]);

/**
 * Index of the outermost method, function or constructor that contains `position` and
 * lies inside the innermost class, interface, enum or object containing it, or null.
 * Anonymous classes and object expressions are not container symbols, so their calls
 * belong to the host callable: their own methods have no callers. Crediting a local
 * function's calls to its host is a choice: one owner, a shorter impact path. A local
 * named class is a container, so its methods keep their calls and resolve `this` against
 * it. A source range, not a line span, so two callables on one line each keep their calls.
 */
export function outermostCallableIndex(symbols: ExtractedSymbol[], position: number): number | null {
  const contains = (sym: ExtractedSymbol) => position >= sym.startIndex && position < sym.endIndex;
  let containerStart = -1;
  for (const sym of symbols) {
    if (CONTAINER_KINDS.has(sym.kind) && contains(sym)) containerStart = Math.max(containerStart, sym.startIndex);
  }
  let best: number | null = null;
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (!CALLABLE_KINDS.has(sym.kind) || !contains(sym) || sym.startIndex <= containerStart) continue;
    if (best === null || sym.startIndex < symbols[best].startIndex) best = i;
  }
  return best;
}

/**
 * Store a file's call sites and inheritance references (ci_call_sites,
 * ci_inheritance_refs). Phase 2 resolves edges from these rows for the whole repo.
 */
export async function storeCallGraph(
  fileId: string,
  symbols: ExtractedSymbol[],
  callGraph: CallGraphResult,
  symbolDbIds: string[],
): Promise<void> {
  const callRows = [];
  for (const call of callGraph.calls) {
    const owner = outermostCallableIndex(symbols, call.startIndex);
    const sourceId = owner === null ? undefined : symbolDbIds[owner];
    if (!sourceId) continue;
    callRows.push({
      file_id: fileId,
      source_symbol_id: sourceId,
      receiver: call.receiver,
      receiver_kind: call.receiverKind,
      method_name: call.methodName,
      arg_count: call.argCount,
      line: call.line,
    });
  }

  const refRows = [];
  for (const ih of callGraph.inheritance) {
    const sourceId = symbolDbIds[ih.symbolIndex];
    if (!sourceId) continue;
    refRows.push({ file_id: fileId, source_symbol_id: sourceId, kind: ih.kind, type_name: ih.typeName });
  }

  for (let i = 0; i < callRows.length; i += 1000) {
    await sql`INSERT INTO ci_call_sites ${sql(callRows.slice(i, i + 1000))}`;
  }
  for (let i = 0; i < refRows.length; i += 1000) {
    await sql`INSERT INTO ci_inheritance_refs ${sql(refRows.slice(i, i + 1000))}`;
  }
}

export interface RebuildResult {
  inheritanceEdges: number;
  callEdges: number;
}

/**
 * Delete every calls/extends/implements edge whose source is in the repo and rebuild
 * them from ci_call_sites and ci_inheritance_refs, in one transaction. It reads neither
 * ci_import_map nor import edges, so it does not depend on resolveImports running first.
 *
 * Resolution rules:
 * - Inheritance: the top-level container in the repo named `type_name`.
 * - Call with a `static-type` receiver: a method whose parent's qualified name is the
 *   receiver or ends with `.<receiver>`.
 * - Call with no receiver or `this`: a method whose parent has the same qualified name
 *   as the caller's parent.
 * - Other receivers need type inference and produce no edge.
 *
 * The source itself is never a target. When several targets match, the first by
 * (caller's own file, qualified name, line, id) wins; the own file first because the
 * same class can exist in two Gradle modules. The earlier in-memory resolver also kept
 * one match, but in DB row order, so ties fell arbitrarily.
 */
export async function rebuildEdges(repoId: string): Promise<RebuildResult> {
  return sql.begin(async (tx) => {
    await deleteResolvedEdges(tx, repoId);
    const inheritanceEdges = await insertInheritanceEdges(tx, repoId);
    const callEdges = await insertCallEdges(tx, repoId);
    return { inheritanceEdges, callEdges };
  });
}

type Tx = postgres.TransactionSql<Record<string, unknown>>;

async function deleteResolvedEdges(tx: Tx, repoId: string): Promise<void> {
  await tx`
    DELETE FROM ci_edges e
    USING ci_symbols s, ci_files f
    WHERE e.source_id = s.id
      AND s.file_id = f.id
      AND f.repo_id = ${repoId}
      AND e.kind IN ('calls', 'extends', 'implements')
  `;
}

async function insertInheritanceEdges(tx: Tx, repoId: string): Promise<number> {
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line)
    SELECT source_id, target_id, kind, NULL
    FROM (
      SELECT DISTINCT ON (ir.source_symbol_id, ir.kind, ir.type_name)
        ir.source_symbol_id AS source_id, t.id AS target_id, ir.kind
      FROM ci_inheritance_refs ir
      JOIN ci_files f ON f.id = ir.file_id
      JOIN ci_symbols t ON t.name = ir.type_name
        AND t.kind = ANY(${[...CONTAINER_KINDS]})
        AND t.parent_id IS NULL
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = f.repo_id
      WHERE f.repo_id = ${repoId}
        AND t.id <> ir.source_symbol_id
      ORDER BY ir.source_symbol_id, ir.kind, ir.type_name, t.qualified_name, t.id
    ) picked
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}

async function insertCallEdges(tx: Tx, repoId: string): Promise<number> {
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line)
    SELECT DISTINCT source_id, target_id, 'calls', line
    FROM (
      SELECT DISTINCT ON (cs.id)
        cs.source_symbol_id AS source_id, t.id AS target_id, cs.line
      FROM ci_call_sites cs
      JOIN ci_files f ON f.id = cs.file_id
      JOIN ci_symbols src ON src.id = cs.source_symbol_id
      LEFT JOIN ci_symbols srcp ON srcp.id = src.parent_id
      JOIN ci_symbols t ON t.name = cs.method_name
        AND t.kind = ANY(${[...CALLABLE_KINDS]})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = f.repo_id
      JOIN ci_symbols tp ON tp.id = t.parent_id
      WHERE f.repo_id = ${repoId}
        AND t.id <> cs.source_symbol_id
        AND (
          (cs.receiver_kind = 'static-type'
            AND (tp.qualified_name = cs.receiver
              OR right(tp.qualified_name, length(cs.receiver) + 1) = '.' || cs.receiver))
          OR (cs.receiver_kind IN ('none', 'this')
            AND tp.qualified_name = srcp.qualified_name)
        )
      ORDER BY cs.id, (t.file_id = cs.file_id) DESC,
        t.qualified_name, t.start_line, t.id
    ) picked
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}
