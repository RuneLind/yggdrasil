import { sql } from "../db/connection.ts";
import type postgres from "postgres";
import { CONTAINER_KINDS } from "./symbol-extractor.ts";
import type { CallGraphResult } from "./call-graph.ts";
import type { ExtractedSymbol } from "./symbol-extractor.ts";

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["method", "function", "constructor"]);

/**
 * Index of the callable that owns a call at `position`, or null (not stored). The owner
 * is the outermost method, function or constructor containing the call inside the
 * innermost class, interface, enum or object containing it; when no callable inside that
 * container contains the call (a local class's field initializer or init block), the
 * outermost one inside the next container out, and so on. A call outside every callable
 * of every enclosing container (a top-level class's initializers) has no owner.
 *
 * Anonymous classes, object expressions and lambdas are not containers, so their calls
 * belong to the host callable; crediting a local function's calls to its host is a
 * choice: one owner, a shorter impact path. A source range, not a line span, so two
 * callables on one line each keep their calls.
 */
export function outermostCallableIndex(symbols: ExtractedSymbol[], position: number): number | null {
  const contains = (sym: ExtractedSymbol) => position >= sym.startIndex && position < sym.endIndex;
  const containerStarts = symbols
    .filter((sym) => CONTAINER_KINDS.has(sym.kind) && contains(sym))
    .map((sym) => sym.startIndex)
    .sort((a, b) => b - a);
  for (const containerStart of [...containerStarts, -1]) {
    let best: number | null = null;
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      if (!CALLABLE_KINDS.has(sym.kind) || !contains(sym) || sym.startIndex <= containerStart) continue;
      if (best === null || sym.startIndex < symbols[best].startIndex) best = i;
    }
    if (best !== null) return best;
  }
  return null;
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
      receiver_type: call.receiverType,
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
 * them from ci_call_sites and ci_inheritance_refs, in one transaction. It reads
 * ci_import_map but not import edges, so it does not depend on resolveImports.
 *
 * 1. Type names (inheritance clauses, class-name receivers, receiver types) resolve to
 *    one class: a member type of an enclosing class, else an explicit import (it claims
 *    the name even when the class is outside the repo), else the same package, else a
 *    wildcard import, else the name as a qualified name. Same-qualified-name duplicates
 *    (two Gradle modules) prefer the referring file.
 * 2. Inheritance edges, then the class hierarchy from them.
 * 3. Calls, one rule per receiver kind; the rule names the edge's resolution:
 *    `local` (no receiver or `this`): the caller's class and its supertypes, then for a
 *    receiverless call an imported, same-package or wildcard-imported function;
 *    `static` (a class name) and `typed` (a variable's declared type): that class and
 *    its supertypes. The nearest class with a method of that name whose parameter range
 *    admits the argument count wins, and every such overload in it gets an edge.
 *
 * The caller itself is never a target.
 */
export async function rebuildEdges(repoId: string): Promise<RebuildResult> {
  return sql.begin(async (tx) => {
    await deleteResolvedEdges(tx, repoId);
    await resolveTypeNames(tx, repoId);
    const inheritanceEdges = await insertInheritanceEdges(tx);
    await buildHierarchy(tx);
    const callEdges = await insertCallEdges(tx, repoId);
    return { inheritanceEdges, callEdges };
  });
}

type Tx = postgres.TransactionSql<Record<string, unknown>>;

/** Bounds the supertype walk; inheritance cycles in broken code would otherwise loop. */
const MAX_HIERARCHY_DEPTH = 10;

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

/** Fills ci_tmp_classes and ci_tmp_type_resolved(ref_kind, ref_id, class_id). */
async function resolveTypeNames(tx: Tx, repoId: string): Promise<void> {
  await tx`
    CREATE TEMP TABLE ci_tmp_classes ON COMMIT DROP AS
    SELECT s.id, s.qualified_name, s.file_id, f.path
    FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
    WHERE f.repo_id = ${repoId} AND s.kind = ANY(${[...CONTAINER_KINDS]})
  `;
  await tx`CREATE INDEX ON ci_tmp_classes (qualified_name)`;

  // scope_id: the container whose enclosing classes' member types are in scope.
  await tx`
    CREATE TEMP TABLE ci_tmp_type_refs ON COMMIT DROP AS
    SELECT 'inherit'::text AS ref_kind, ir.id AS ref_id, ir.file_id, f.package_name,
      own.parent_id AS scope_id, ir.type_name AS type_text
    FROM ci_inheritance_refs ir
    JOIN ci_files f ON f.id = ir.file_id
    JOIN ci_symbols own ON own.id = ir.source_symbol_id
    WHERE f.repo_id = ${repoId}
    UNION ALL
    SELECT CASE WHEN cs.receiver_type IS NOT NULL THEN 'typed' ELSE 'static' END,
      cs.id, cs.file_id, f.package_name, src.parent_id, coalesce(cs.receiver_type, cs.receiver)
    FROM ci_call_sites cs
    JOIN ci_files f ON f.id = cs.file_id
    JOIN ci_symbols src ON src.id = cs.source_symbol_id
    WHERE f.repo_id = ${repoId}
      AND (cs.receiver_type IS NOT NULL OR cs.receiver_kind = 'static-type')
  `;

  await tx`
    CREATE TEMP TABLE ci_tmp_type_resolved ON COMMIT DROP AS
    WITH refs AS (
      SELECT r.*, split_part(r.type_text, '.', 1) AS head,
        substr(r.type_text, length(split_part(r.type_text, '.', 1)) + 1) AS tail,
        sc.qualified_name AS scope_qn
      FROM ci_tmp_type_refs r LEFT JOIN ci_symbols sc ON sc.id = r.scope_id
    ),
    member_type AS (
      SELECT r.ref_kind, r.ref_id, 0 AS prio, length(e.qualified_name) AS nesting,
        e.qualified_name || '.' || r.type_text AS qn
      FROM refs r
      JOIN ci_tmp_classes e ON e.file_id = r.file_id
        AND (r.scope_qn = e.qualified_name OR starts_with(r.scope_qn, e.qualified_name || '.'))
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = e.qualified_name || '.' || r.type_text)
    ),
    explicit_import AS (
      SELECT r.ref_kind, r.ref_id, 1, 0, im.import_path || r.tail
      FROM refs r
      JOIN ci_import_map im ON im.file_id = r.file_id AND NOT im.is_wildcard
        AND coalesce(im.alias, substring(im.import_path FROM '[^.]+$')) = r.head
    ),
    same_package AS (
      SELECT r.ref_kind, r.ref_id, 2, 0, coalesce(r.package_name || '.', '') || r.type_text
      FROM refs r
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = coalesce(r.package_name || '.', '') || r.type_text)
    ),
    wildcard_import AS (
      SELECT r.ref_kind, r.ref_id, 3, 0, im.import_path || '.' || r.type_text
      FROM refs r
      JOIN ci_import_map im ON im.file_id = r.file_id AND im.is_wildcard
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = im.import_path || '.' || r.type_text)
    ),
    fully_qualified AS (
      SELECT r.ref_kind, r.ref_id, 4, 0, r.type_text
      FROM refs r
      WHERE r.tail <> '' AND EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = r.type_text)
    ),
    best AS (
      SELECT DISTINCT ON (ref_kind, ref_id) ref_kind, ref_id, qn
      FROM (
        SELECT * FROM member_type
        UNION ALL SELECT * FROM explicit_import
        UNION ALL SELECT * FROM same_package
        UNION ALL SELECT * FROM wildcard_import
        UNION ALL SELECT * FROM fully_qualified
      ) candidates
      ORDER BY ref_kind, ref_id, prio, nesting DESC, qn
    )
    SELECT DISTINCT ON (b.ref_kind, b.ref_id) b.ref_kind, b.ref_id, c.id AS class_id
    FROM best b
    JOIN refs r ON r.ref_kind = b.ref_kind AND r.ref_id = b.ref_id
    JOIN ci_tmp_classes c ON c.qualified_name = b.qn
    ORDER BY b.ref_kind, b.ref_id, (c.file_id = r.file_id) DESC, c.path, c.id
  `;
  await tx`CREATE INDEX ON ci_tmp_type_resolved (ref_kind, ref_id)`;
}

async function insertInheritanceEdges(tx: Tx): Promise<number> {
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line)
    SELECT DISTINCT ir.source_symbol_id, t.class_id, ir.kind, NULL::int
    FROM ci_inheritance_refs ir
    JOIN ci_tmp_type_resolved t ON t.ref_kind = 'inherit' AND t.ref_id = ir.id
    WHERE t.class_id <> ir.source_symbol_id
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}

/** ci_tmp_hierarchy(class_id, ancestor_id, depth): every class with itself at depth 0. */
async function buildHierarchy(tx: Tx): Promise<void> {
  await tx`
    CREATE TEMP TABLE ci_tmp_hierarchy ON COMMIT DROP AS
    WITH RECURSIVE h(class_id, ancestor_id, depth) AS (
      SELECT id, id, 0 FROM ci_tmp_classes
      UNION ALL
      SELECT h.class_id, e.target_id, h.depth + 1
      FROM h JOIN ci_edges e ON e.source_id = h.ancestor_id AND e.kind IN ('extends', 'implements')
      WHERE h.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT class_id, ancestor_id, min(depth) AS depth FROM h GROUP BY class_id, ancestor_id
  `;
  await tx`CREATE INDEX ON ci_tmp_hierarchy (class_id)`;
}

async function insertCallEdges(tx: Tx, repoId: string): Promise<number> {
  const callables = [...CALLABLE_KINDS];
  // A NULL count (spread or named argument) or unknown parameters admit every overload.
  const arityFits = tx`(s.arg_count IS NULL OR t.min_params IS NULL
    OR (s.arg_count >= t.min_params AND (t.max_params IS NULL OR s.arg_count <= t.max_params)))`;
  const importedName = tx`coalesce(im.alias, substring(im.import_path FROM '[^.]+$'))`;
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line, resolution)
    WITH sites AS (
      SELECT cs.id, cs.source_symbol_id, cs.file_id, cs.line, cs.method_name, cs.arg_count,
        cs.receiver_kind, src.parent_id AS caller_class_id, f.package_name
      FROM ci_call_sites cs
      JOIN ci_files f ON f.id = cs.file_id
      JOIN ci_symbols src ON src.id = cs.source_symbol_id
      WHERE f.repo_id = ${repoId}
    ),
    local_calls AS (
      SELECT id AS site_id, caller_class_id AS class_id FROM sites
      WHERE receiver_kind IN ('none', 'this') AND caller_class_id IS NOT NULL
    ),
    static_calls AS (
      SELECT ref_id AS site_id, class_id FROM ci_tmp_type_resolved WHERE ref_kind = 'static'
    ),
    typed_calls AS (
      SELECT ref_id AS site_id, class_id FROM ci_tmp_type_resolved WHERE ref_kind = 'typed'
    ),
    starts AS (
      SELECT site_id, class_id, 'local' AS resolution FROM local_calls
      UNION ALL SELECT site_id, class_id, 'static' FROM static_calls
      UNION ALL SELECT site_id, class_id, 'typed' FROM typed_calls
    ),
    members AS (
      SELECT st.site_id, st.resolution, h.depth AS rank, h.ancestor_id AS owner_id,
        t.id AS target_id, t.file_id AS target_file
      FROM starts st
      JOIN sites s ON s.id = st.site_id
      JOIN ci_tmp_hierarchy h ON h.class_id = st.class_id
      JOIN ci_symbols t ON t.parent_id = h.ancestor_id AND t.name = s.method_name
        AND t.kind = ANY(${callables})
      WHERE ${arityFits}
    ),
    -- Receiverless calls with no member match: Kotlin top-level functions and Java
    -- static imports. A top-level function's owner is its file.
    functions AS (
      SELECT s.id AS site_id, 100 AS rank, t.id AS target_id, t.file_id AS target_file,
        coalesce(t.parent_id, t.file_id) AS owner_id
      FROM sites s
      JOIN ci_import_map im ON im.file_id = s.file_id AND NOT im.is_wildcard AND ${importedName} = s.method_name
      JOIN ci_symbols t ON t.qualified_name = im.import_path AND t.kind = ANY(${callables})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE s.receiver_kind = 'none' AND ${arityFits}
      UNION ALL
      SELECT s.id, 101, t.id, t.file_id, t.file_id
      FROM sites s
      JOIN ci_symbols t ON t.qualified_name = coalesce(s.package_name || '.', '') || s.method_name
        AND t.parent_id IS NULL AND t.kind = ANY(${callables})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE s.receiver_kind = 'none' AND ${arityFits}
      UNION ALL
      SELECT s.id, 102, t.id, t.file_id, coalesce(t.parent_id, t.file_id)
      FROM sites s
      JOIN ci_import_map im ON im.file_id = s.file_id AND im.is_wildcard
      JOIN ci_symbols t ON t.qualified_name = im.import_path || '.' || s.method_name
        AND t.kind = ANY(${callables})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE s.receiver_kind = 'none' AND ${arityFits}
    ),
    candidates AS (
      SELECT site_id, resolution, rank, owner_id, target_id, target_file FROM members
      UNION ALL
      SELECT site_id, 'local', rank, owner_id, target_id, target_file FROM functions
    ),
    picked AS (
      SELECT DISTINCT ON (c.site_id) c.site_id, c.owner_id
      FROM candidates c JOIN sites s ON s.id = c.site_id
      ORDER BY c.site_id, c.rank, (c.target_file = s.file_id) DESC, c.owner_id
    )
    SELECT DISTINCT ON (s.source_symbol_id, c.target_id, s.line)
      s.source_symbol_id, c.target_id, 'calls', s.line, c.resolution
    FROM candidates c
    JOIN picked p ON p.site_id = c.site_id AND p.owner_id = c.owner_id
    JOIN sites s ON s.id = c.site_id
    WHERE c.target_id <> s.source_symbol_id
    ORDER BY s.source_symbol_id, c.target_id, s.line, c.resolution
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}
