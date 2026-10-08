import { sql } from "../db/connection.ts";
import type postgres from "postgres";
import { CONTAINER_KINDS } from "./symbol-extractor.ts";
import type { CallGraphResult } from "./call-graph.ts";
import type { ExtractedSymbol } from "./symbol-extractor.ts";
import { canonicalType, fitOf, narrowOverloads, type TypeContext } from "./overloads.ts";

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
  // Ids are assigned here so a call can point at its receiver step's row.
  const siteIds = callGraph.calls.map((call) => {
    const owner = outermostCallableIndex(symbols, call.startIndex);
    const sourceId = owner === null ? undefined : symbolDbIds[owner];
    return sourceId ? { id: crypto.randomUUID(), sourceId } : null;
  });
  const callRows = [];
  for (let i = 0; i < callGraph.calls.length; i++) {
    const call = callGraph.calls[i];
    const site = siteIds[i];
    if (!site) continue;
    const sourceId = site.sourceId;
    callRows.push({
      id: site.id,
      file_id: fileId,
      source_symbol_id: sourceId,
      receiver: call.receiver,
      receiver_kind: call.receiverKind,
      receiver_type: call.receiverType,
      method_name: call.methodName,
      arg_count: call.argCount,
      arg_types: call.argTypes,
      arg_names: call.argNames,
      implicit_receiver_type: call.implicitReceiverType,
      receiver_site_id: call.receiverStep === null ? null : siteIds[call.receiverStep]?.id ?? null,
      is_navigation: call.navigation,
      receiver_declared: call.receiverDeclared,
      line: call.line,
    });
  }

  const refRows = [];
  for (const ih of callGraph.inheritance) {
    const sourceId = symbolDbIds[ih.symbolIndex];
    if (!sourceId) continue;
    refRows.push({ file_id: fileId, source_symbol_id: sourceId, kind: ih.kind, type_name: ih.typeName, type_args: ih.typeArgs });
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
  overrideEdges: number;
  callEdges: number;
}

/**
 * Delete every calls/extends/implements/overrides edge whose source is in the repo and rebuild
 * them from ci_call_sites and ci_inheritance_refs, in one transaction. It reads
 * ci_import_map but not import edges, so it does not depend on resolveImports.
 *
 * 1. Type names resolve to one class: a member type of an enclosing class or of one of
 *    its supertypes (innermost class first, its own member types before inherited ones),
 *    else an explicit import (it claims the name even when the class is outside the
 *    repo), else the same package, else a wildcard import, else the name as a qualified
 *    name. Same-qualified-name duplicates (two Gradle modules) prefer the referring file.
 *    Inheritance clauses and extension receivers resolve first, without inherited member
 *    types (the hierarchy is built from them); call receivers resolve after.
 * 2. Inheritance edges, then the class hierarchy from them (kept in ci_class_ancestors),
 *    then overrides edges.
 * 3. Calls. Each site looks for a method of its name in lookup classes, in groups: the
 *    receiver of an enclosing with/apply/run lambda (0); the receiver's class, or for a
 *    receiverless or `this` call the caller's class (1); for a receiverless call, each
 *    lexically enclosing class outward (2, 3, …). Each lookup class contributes every
 *    method of its hierarchy whose parameter range admits the argument count and that
 *    is visible (a private method only from its own top-level class, or its own file for
 *    a top-level function); a method overridden in a subclass of its owner (same group)
 *    drops out. The first group with a candidate that the known argument types do not
 *    rule out wins, else the first group with a candidate (narrowCandidates). Sites with
 *    no member candidate try functions: imported, same-package, then wildcard-imported,
 *    one owner (file or class) per site; an extension function when its receiver class
 *    is in the hierarchy of the call's receiver, or for a receiverless call, of a lookup
 *    class or the caller's own extension receiver, or when it is the only reachable
 *    extension of that name. Argument types then narrow same-site overloads
 *    (narrowOverloads). The resolution is `implicit`'s and the receiver rule's: typed (a
 *    variable's or lambda receiver's type), static (a class name), local (receiverless or
 *    `this`), super (the superclass, else in Kotlin the interfaces; or the type `super`
 *    names). Each edge keeps its lookup class as receiver_class_id.
 * 4. Chains and inherited-property receivers, typed through a symbol's declared_type
 *    (resolveDerivedReceivers).
 *
 * The caller itself is never a target.
 */
export async function rebuildEdges(repoId: string): Promise<RebuildResult> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL work_mem = '64MB'`;
    // JIT compilation costs more than these queries run (measured on melosys-api).
    await tx`SET LOCAL jit = off`;
    await deleteResolvedEdges(tx, repoId);
    await createWorkTables(tx, repoId);
    await resolveTypeNames(tx, repoId, "declarations");
    const inheritanceEdges = await insertInheritanceEdges(tx);
    await buildHierarchy(tx, repoId);
    const overrideEdges = await insertOverrideEdges(tx);
    await resolveTypeNames(tx, repoId, "calls");
    const callEdges = await insertCallEdges(tx, repoId);
    return { inheritanceEdges, overrideEdges, callEdges };
  });
}

type Tx = postgres.TransactionSql<Record<string, unknown>>;

/** Bounds the supertype and enclosing-class walks; inheritance cycles in broken code would otherwise loop. */
const MAX_HIERARCHY_DEPTH = 10;

async function deleteResolvedEdges(tx: Tx, repoId: string): Promise<void> {
  await tx`
    DELETE FROM ci_edges e
    USING ci_symbols s, ci_files f
    WHERE e.source_id = s.id
      AND s.file_id = f.id
      AND f.repo_id = ${repoId}
      AND e.kind IN ('calls', 'extends', 'implements', 'overrides')
  `;
}

/**
 * ci_tmp_classes (the repo's containers), ci_tmp_imports (non-wildcard imports with the
 * simple name they bind), ci_tmp_hierarchy holding each class at depth 0 until
 * buildHierarchy, and an empty ci_tmp_type_resolved.
 */
async function createWorkTables(tx: Tx, repoId: string): Promise<void> {
  await tx`
    CREATE TEMP TABLE ci_tmp_classes ON COMMIT DROP AS
    SELECT s.id, s.name, s.qualified_name, s.kind, s.file_id, f.path
    FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
    WHERE f.repo_id = ${repoId} AND s.kind = ANY(${[...CONTAINER_KINDS]})
  `;
  await tx`CREATE INDEX ON ci_tmp_classes (qualified_name)`;
  await tx`CREATE INDEX ON ci_tmp_classes (id)`;
  await tx`
    CREATE TEMP TABLE ci_tmp_imports ON COMMIT DROP AS
    SELECT im.file_id, coalesce(im.alias, substring(im.import_path FROM '[^.]+$')) AS nm, im.import_path
    FROM ci_import_map im JOIN ci_files f ON f.id = im.file_id
    WHERE f.repo_id = ${repoId} AND NOT im.is_wildcard
  `;
  await tx`CREATE INDEX ON ci_tmp_imports (file_id, nm)`;
  await tx`
    CREATE TEMP TABLE ci_tmp_hierarchy ON COMMIT DROP AS
    SELECT id AS class_id, id AS ancestor_id, 0 AS depth FROM ci_tmp_classes
  `;
  await tx`CREATE TEMP TABLE ci_tmp_type_resolved (ref_kind text, ref_id uuid, class_id uuid) ON COMMIT DROP`;
  await tx`ANALYZE ci_tmp_classes`;
  await tx`ANALYZE ci_tmp_imports`;
}

/**
 * Appends to ci_tmp_type_resolved(ref_kind, ref_id, class_id). `declarations`: inherit
 * (ci_inheritance_refs.id) and ext (the extension function's symbol id); `calls`:
 * static, typed, implicit and super (ci_call_sites.id; super: the type a `super` names);
 * `derived`: decl (the symbol id of a chain step's target or an inherited property, by
 * its declared_type).
 */
async function resolveTypeNames(tx: Tx, repoId: string, phase: "declarations" | "calls" | "derived"): Promise<void> {
  // scope_id: the container whose enclosing classes' member types are in scope.
  if (phase === "declarations") {
    await tx`
      CREATE TEMP TABLE ci_tmp_type_refs ON COMMIT DROP AS
      SELECT 'inherit'::text AS ref_kind, ir.id AS ref_id, ir.file_id, f.package_name,
        own.parent_id AS scope_id, ir.type_name AS type_text
      FROM ci_inheritance_refs ir
      JOIN ci_files f ON f.id = ir.file_id
      JOIN ci_symbols own ON own.id = ir.source_symbol_id
      WHERE f.repo_id = ${repoId}
      UNION ALL
      SELECT 'ext', s.id, s.file_id, f.package_name, s.parent_id, s.extension_receiver
      FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
      WHERE f.repo_id = ${repoId} AND s.extension_receiver IS NOT NULL
    `;
  } else if (phase === "derived") {
    // A receiver step's target or an inherited property: its declared type, read in the
    // declaring file (its imports, package and enclosing classes), not the caller's.
    await tx`DROP TABLE ci_tmp_type_refs`;
    await tx`
      CREATE TEMP TABLE ci_tmp_type_refs ON COMMIT DROP AS
      SELECT DISTINCT 'decl'::text AS ref_kind, t.id AS ref_id, t.file_id, f.package_name,
        t.parent_id AS scope_id, t.declared_type AS type_text
      FROM ci_tmp_derived d
      JOIN ci_symbols t ON t.id = d.typed_by
      JOIN ci_files f ON f.id = t.file_id
      WHERE t.declared_type IS NOT NULL
    `;
  } else {
    await tx`DROP TABLE ci_tmp_type_refs`;
    await tx`
      CREATE TEMP TABLE ci_tmp_type_refs ON COMMIT DROP AS
      SELECT CASE WHEN cs.receiver_type IS NOT NULL THEN 'typed' ELSE 'static' END AS ref_kind,
        cs.id AS ref_id, cs.file_id, f.package_name, src.parent_id AS scope_id,
        coalesce(cs.receiver_type, cs.receiver) AS type_text
      FROM ci_call_sites cs
      JOIN ci_files f ON f.id = cs.file_id
      JOIN ci_symbols src ON src.id = cs.source_symbol_id
      WHERE f.repo_id = ${repoId} AND cs.receiver_kind <> 'super'
        AND (cs.receiver_type IS NOT NULL OR cs.receiver_kind = 'static-type')
      UNION ALL
      SELECT 'super', cs.id, cs.file_id, f.package_name, src.parent_id, cs.receiver_type
      FROM ci_call_sites cs
      JOIN ci_files f ON f.id = cs.file_id
      JOIN ci_symbols src ON src.id = cs.source_symbol_id
      WHERE f.repo_id = ${repoId} AND cs.receiver_kind = 'super' AND cs.receiver_type IS NOT NULL
      UNION ALL
      SELECT 'implicit', cs.id, cs.file_id, f.package_name, src.parent_id, cs.implicit_receiver_type
      FROM ci_call_sites cs
      JOIN ci_files f ON f.id = cs.file_id
      JOIN ci_symbols src ON src.id = cs.source_symbol_id
      WHERE f.repo_id = ${repoId} AND cs.implicit_receiver_type IS NOT NULL
    `;
  }
  await tx`ANALYZE ci_tmp_type_refs`;

  await tx`
    INSERT INTO ci_tmp_type_resolved (ref_kind, ref_id, class_id)
    WITH refs AS (
      SELECT r.*, split_part(r.type_text, '.', 1) AS head,
        substr(r.type_text, length(split_part(r.type_text, '.', 1)) + 1) AS tail,
        sc.qualified_name AS scope_qn
      FROM ci_tmp_type_refs r LEFT JOIN ci_symbols sc ON sc.id = r.scope_id
    ),
    member_type AS (
      SELECT r.ref_kind, r.ref_id, 0 AS prio, length(e.qualified_name) AS nesting, h.depth,
        a.qualified_name || '.' || r.type_text AS qn
      FROM refs r
      JOIN ci_tmp_classes e ON e.file_id = r.file_id
        AND (r.scope_qn = e.qualified_name OR starts_with(r.scope_qn, e.qualified_name || '.'))
      JOIN ci_tmp_hierarchy h ON h.class_id = e.id
      JOIN ci_tmp_classes a ON a.id = h.ancestor_id
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = a.qualified_name || '.' || r.type_text)
    ),
    explicit_import AS (
      SELECT r.ref_kind, r.ref_id, 1, 0, 0, im.import_path || r.tail
      FROM refs r JOIN ci_tmp_imports im ON im.file_id = r.file_id AND im.nm = r.head
    ),
    same_package AS (
      SELECT r.ref_kind, r.ref_id, 2, 0, 0, coalesce(r.package_name || '.', '') || r.type_text
      FROM refs r
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = coalesce(r.package_name || '.', '') || r.type_text)
    ),
    wildcard_import AS (
      SELECT r.ref_kind, r.ref_id, 3, 0, 0, im.import_path || '.' || r.type_text
      FROM refs r
      JOIN ci_import_map im ON im.file_id = r.file_id AND im.is_wildcard
      WHERE EXISTS (SELECT 1 FROM ci_tmp_classes c WHERE c.qualified_name = im.import_path || '.' || r.type_text)
    ),
    fully_qualified AS (
      SELECT r.ref_kind, r.ref_id, 4, 0, 0, r.type_text
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
      ORDER BY ref_kind, ref_id, prio, nesting DESC, depth, qn
    )
    SELECT DISTINCT ON (b.ref_kind, b.ref_id) b.ref_kind, b.ref_id, c.id AS class_id
    FROM best b
    JOIN refs r ON r.ref_kind = b.ref_kind AND r.ref_id = b.ref_id
    JOIN ci_tmp_classes c ON c.qualified_name = b.qn
    ORDER BY b.ref_kind, b.ref_id, (c.file_id = r.file_id) DESC, c.path, c.id
  `;
  if (phase === "calls") {
    await tx`CREATE INDEX ON ci_tmp_type_resolved (ref_kind, ref_id)`;
    await tx`ANALYZE ci_tmp_type_resolved`;
  }
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

/**
 * ci_tmp_hierarchy(class_id, ancestor_id, depth): every class with itself at depth 0; also
 * stored in ci_class_ancestors for impact's dispatch step.
 */
async function buildHierarchy(tx: Tx, repoId: string): Promise<void> {
  await tx`DROP TABLE ci_tmp_hierarchy`;
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
  await tx`ANALYZE ci_tmp_hierarchy`;
  await tx`DELETE FROM ci_class_ancestors WHERE repo_id = ${repoId}`;
  await tx`
    INSERT INTO ci_class_ancestors (repo_id, class_id, ancestor_id)
    SELECT ${repoId}, class_id, ancestor_id FROM ci_tmp_hierarchy
  `;
}

const CALLABLES = [...CALLABLE_KINDS];

/**
 * Same signature for removing overridden call candidates: equal parameter types when both
 * are fully known, else the same parameter range.
 */
function sameSignature(tx: Tx, a: string, b: string) {
  const [x, y] = [tx(a), tx(b)];
  return tx`CASE
    WHEN ${x}.param_types IS NOT NULL AND ${y}.param_types IS NOT NULL
      AND array_position(${x}.param_types, NULL) IS NULL AND array_position(${y}.param_types, NULL) IS NULL
    THEN ${x}.param_types = ${y}.param_types
    ELSE ${x}.min_params IS NOT DISTINCT FROM ${y}.min_params AND ${x}.max_params IS NOT DISTINCT FROM ${y}.max_params
  END`;
}

/** Kotlin's mapped twins of Java types, folded for override matching. */
const OVERRIDE_TWINS: Record<string, string> = {
  Any: "Object", MutableList: "List", MutableSet: "Set", MutableMap: "Map", MutableCollection: "Collection",
  MutableIterable: "Iterable", MutableIterator: "Iterator", MutableListIterator: "ListIterator", MutableEntry: "Entry",
};
const twin = (t: string) => OVERRIDE_TWINS[t] ?? t;

interface OverridePair {
  m_id: string; a_id: string; class_id: string; ancestor_id: string;
  m_types: (string | null)[] | null; a_types: (string | null)[] | null; a_vars: (string | null)[] | null;
  m_min: number | null; m_max: number | null; a_min: number | null; a_max: number | null;
  m_ext: string | null; a_ext: string | null;
}

/**
 * An `overrides` edge from each method to every ancestor method of the same name and
 * signature, over the whole extends/implements closure: impact's dispatch step is then
 * one hop. Kotlin interfaces are `class` symbols, so the owner's kind is not checked.
 * Constructors, static (Java `static`, Kotlin companion) and private methods, and
 * methods declared inside a callable, object literal or anonymous class, never override.
 *
 * Signature: the same extension receiver and parameter count, and at each position where
 * both types are known, the same type (Kotlin's Any/Mutable* twins folded). An ancestor
 * parameter typed with its class's type parameter takes the type argument the clauses
 * from the method's class up to it bind (`FooRepo implements Repo<Foo>`: T is Foo);
 * unbound, it matches anything.
 */
async function insertOverrideEdges(tx: Tx): Promise<number> {
  const pairs = await tx<OverridePair[]>`
    SELECT m.id AS m_id, a.id AS a_id, h.class_id, h.ancestor_id,
      to_json(m.param_types) AS m_types, to_json(a.param_types) AS a_types, to_json(a.param_type_vars) AS a_vars,
      m.min_params AS m_min, m.max_params AS m_max, a.min_params AS a_min, a.max_params AS a_max,
      m.extension_receiver AS m_ext, a.extension_receiver AS a_ext
    FROM ci_tmp_hierarchy h
    JOIN ci_symbols m ON m.parent_id = h.class_id
    JOIN ci_symbols a ON a.parent_id = h.ancestor_id AND a.name = m.name
    WHERE h.depth > 0
      AND m.kind IN ('method', 'function') AND a.kind IN ('method', 'function')
      AND NOT coalesce(m.is_static, false) AND NOT coalesce(a.is_static, false)
      AND NOT m.is_local AND NOT a.is_local
      AND m.visibility IS DISTINCT FROM 'private' AND a.visibility IS DISTINCT FROM 'private'
  `;
  if (pairs.length === 0) return 0;

  const typeParams = new Map<string, string[]>();
  for (const r of await tx<{ id: string; tp: string[] }[]>`
    SELECT s.id, to_json(s.type_params) AS tp FROM ci_symbols s JOIN ci_tmp_classes c ON c.id = s.id
    WHERE cardinality(s.type_params) > 0
  `) typeParams.set(r.id, r.tp);
  const clauses = new Map<string, { parent: string; args: (string | null)[] }[]>();
  for (const r of await tx<{ child: string; parent: string; args: (string | null)[] | null }[]>`
    SELECT ir.source_symbol_id AS child, t.class_id AS parent, to_json(ir.type_args) AS args
    FROM ci_inheritance_refs ir JOIN ci_tmp_type_resolved t ON t.ref_kind = 'inherit' AND t.ref_id = ir.id
    WHERE t.class_id <> ir.source_symbol_id
  `) {
    let list = clauses.get(r.child);
    if (!list) clauses.set(r.child, (list = []));
    list.push({ parent: r.parent, args: r.args ?? [] });
  }
  const bindings = new Map<string, Map<string, Map<string, string | null>>>();
  const bindingsOf = (cls: string) => {
    let out = bindings.get(cls);
    if (!out) bindings.set(cls, (out = typeBindings(cls, typeParams, clauses)));
    return out;
  };

  const sources: string[] = [];
  const targets: string[] = [];
  for (const p of pairs) {
    const generic = p.a_vars?.some((v) => v !== null && v !== "*");
    const bound = generic ? bindingsOf(p.class_id).get(p.ancestor_id) : undefined;
    if (!overrideMatches(p, typeParams.get(p.ancestor_id) ?? [], bound)) continue;
    sources.push(p.m_id);
    targets.push(p.a_id);
  }
  if (sources.length === 0) return 0;
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line)
    SELECT DISTINCT s, t, 'overrides', NULL::int
    FROM unnest(${tx.array(sources)}::uuid[], ${tx.array(targets)}::uuid[]) AS x(s, t)
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}

/**
 * Per ancestor of `cls`, its type parameters → the type the clauses on the way bind them
 * to (null: unknown, as for `cls`'s own type parameters, or bound differently on two paths).
 */
function typeBindings(
  cls: string,
  typeParams: Map<string, string[]>,
  clauses: Map<string, { parent: string; args: (string | null)[] }[]>,
): Map<string, Map<string, string | null>> {
  const out = new Map<string, Map<string, string | null>>();
  const queue: Array<[string, Map<string, string | null>, number]> = [[cls, new Map(), 0]];
  while (queue.length > 0) {
    const [x, env, depth] = queue.shift()!;
    if (depth >= MAX_HIERARCHY_DEPTH) continue;
    const own = typeParams.get(x) ?? [];
    for (const { parent, args } of clauses.get(x) ?? []) {
      const next = new Map<string, string | null>();
      (typeParams.get(parent) ?? []).forEach((tp, i) => {
        const arg = args[i] ?? null;
        next.set(tp, arg === null ? null : own.includes(arg) ? env.get(arg) ?? null : arg);
      });
      const seen = out.get(parent);
      if (seen) {
        for (const [k, v] of next) if (seen.get(k) !== v) seen.set(k, null);
        continue;
      }
      out.set(parent, next);
      queue.push([parent, next, depth + 1]);
    }
  }
  return out;
}

function overrideMatches(p: OverridePair, ancestorTypeParams: string[], bound: Map<string, string | null> | undefined): boolean {
  const ext = (e: string | null) => (e === null ? null : twin(canonicalType(e)));
  if ((p.m_ext === null) !== (p.a_ext === null)) return false;
  if (p.a_ext !== null && !ancestorTypeParams.includes(p.a_ext) && ext(p.m_ext) !== ext(p.a_ext)) return false;
  if (p.m_types === null || p.a_types === null) return p.m_min === p.a_min && p.m_max === p.a_max;
  if (p.m_types.length !== p.a_types.length) return false;
  return p.a_types.every((at, i) => {
    const v = p.a_vars?.[i] ?? null;
    const a = at ?? (v !== null && v !== "*" ? bound?.get(v) ?? null : null);
    const m = p.m_types![i];
    return a === null || m === null || twin(a) === twin(m);
  });
}

async function insertCallEdges(tx: Tx, repoId: string): Promise<number> {
  // A NULL count (spread argument) or unknown parameters admit every overload.
  const arityFits = tx`(s.arg_count IS NULL OR t.min_params IS NULL
    OR (s.arg_count >= t.min_params AND (t.max_params IS NULL OR s.arg_count <= t.max_params)))`;
  // A private target only from its own file, and for a class member, from its own
  // top-level class (the first qualified-name segment after the package).
  const visible = tx`(t.visibility IS DISTINCT FROM 'private' OR (t.file_id = s.file_id AND (t.parent_id IS NULL
    OR split_part(substr(t.qualified_name, length(coalesce(s.package_name || '.', '')) + 1), '.', 1)
     = split_part(substr(s.caller_qn, length(coalesce(s.package_name || '.', '')) + 1), '.', 1))))`;

  await tx`
    CREATE TEMP TABLE ci_tmp_sites ON COMMIT DROP AS
    SELECT cs.id, cs.source_symbol_id, cs.file_id, cs.line, cs.method_name, cs.arg_count,
      cs.receiver_kind, cs.receiver, cs.receiver_type, cs.receiver_declared, cs.receiver_site_id, cs.is_navigation,
      src.parent_id AS caller_class_id, src.qualified_name AS caller_qn, f.package_name, f.language
    FROM ci_call_sites cs
    JOIN ci_files f ON f.id = cs.file_id
    JOIN ci_symbols src ON src.id = cs.source_symbol_id
    WHERE f.repo_id = ${repoId}
  `;
  await tx`CREATE INDEX ON ci_tmp_sites (id)`;
  await tx`ANALYZE ci_tmp_sites (id, receiver_kind)`;

  // Lookup classes per site, by group (see rebuildEdges).
  await tx`
    CREATE TEMP TABLE ci_tmp_starts ON COMMIT DROP AS
    WITH RECURSIVE enclosing(site_id, grp, class_id, receiver_kind) AS (
      SELECT id, 1, caller_class_id, receiver_kind FROM ci_tmp_sites WHERE receiver_kind IN ('none', 'this')
      UNION ALL
      SELECT e.site_id, e.grp + 1, c.parent_id, e.receiver_kind
      FROM enclosing e JOIN ci_symbols c ON c.id = e.class_id
      WHERE e.receiver_kind = 'none' AND c.parent_id IS NOT NULL AND e.grp < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT site_id, grp, class_id, 'local'::text AS resolution FROM enclosing
    UNION ALL
    SELECT ref_id, CASE ref_kind WHEN 'implicit' THEN 0 ELSE 1 END, class_id,
      CASE ref_kind WHEN 'static' THEN 'static' ELSE 'typed' END
    FROM ci_tmp_type_resolved WHERE ref_kind IN ('static', 'typed', 'implicit')
    UNION ALL
    -- super<I>.foo(), I.super.foo(), super in an object literal or anonymous class: the
    -- type it names.
    SELECT ref_id, 1, class_id, 'super' FROM ci_tmp_type_resolved WHERE ref_kind = 'super'
    UNION ALL
    -- super.foo(): the superclass, whose hierarchy minus overridden methods leaves the
    -- nearest ancestor's foo; in Kotlin, else the implemented interfaces (a default method).
    SELECT s.id, CASE e.kind WHEN 'extends' THEN 1 ELSE 2 END, e.target_id, 'super'
    FROM ci_tmp_sites s JOIN ci_edges e ON e.source_id = s.caller_class_id AND e.kind IN ('extends', 'implements')
    WHERE s.receiver_kind = 'super' AND s.receiver_type IS NULL AND (e.kind = 'extends' OR s.language = 'kotlin')
  `;
  await tx`ANALYZE ci_tmp_starts (site_id, grp)`;

  await tx`
    CREATE TEMP TABLE ci_tmp_cands (site_id uuid, grp int, resolution text, owner_id uuid, target_id uuid,
      param_types text[], min_params int, max_params int, recv_class_id uuid) ON COMMIT DROP
  `;
  await insertMemberCandidates(tx, "ci_tmp_starts", arityFits, visible);
  await tx`CREATE INDEX ON ci_tmp_cands (site_id)`;
  await tx`ANALYZE ci_tmp_cands`;
  await removeOverridden(tx, null);

  await insertFunctionCandidates(tx, repoId, arityFits, visible);
  await narrowCandidates(tx, null);
  await keepFirstGroup(tx);

  await resolveDerivedReceivers(tx, repoId, arityFits, visible);

  // receiver_class_id: the lookup class, when every candidate row behind the edge agrees.
  const result = await tx`
    INSERT INTO ci_edges (source_id, target_id, kind, line, resolution, receiver_class_id)
    SELECT DISTINCT ON (s.source_symbol_id, c.target_id, s.line)
      s.source_symbol_id, c.target_id, 'calls', s.line, c.resolution,
      CASE WHEN bool_and(c.recv_class_id IS NOT NULL) OVER w
        AND min(c.recv_class_id::text) OVER w = max(c.recv_class_id::text) OVER w THEN c.recv_class_id END
    FROM ci_tmp_cands c
    JOIN ci_tmp_sites s ON s.id = c.site_id
    WHERE c.target_id <> s.source_symbol_id AND NOT s.is_navigation
    WINDOW w AS (PARTITION BY s.source_symbol_id, c.target_id, s.line)
    ORDER BY s.source_symbol_id, c.target_id, s.line,
      CASE c.resolution WHEN 'typed' THEN 0 WHEN 'static' THEN 1 WHEN 'local' THEN 2 WHEN 'chain' THEN 3 ELSE 4 END
    ON CONFLICT (source_id, target_id, kind, line) DO NOTHING
  `;
  return result.count;
}

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * Member candidates of the lookup classes in `starts` (see rebuildEdges), each with its
 * lookup class. A navigation step `x.b` matches a member property `b` (a Kotlin property
 * symbol not declared locally: function-local vals are stored with the class as parent)
 * or a Java getter `getB()` without parameters (an `isB()` getter returns a boolean,
 * which types nothing).
 */
async function insertMemberCandidates(tx: Tx, starts: string, arityFits: Fragment, visible: Fragment): Promise<void> {
  await tx`
    INSERT INTO ci_tmp_cands (site_id, grp, resolution, owner_id, target_id, param_types, min_params, max_params, recv_class_id)
    SELECT st.site_id, st.grp, st.resolution, h.ancestor_id, t.id, t.param_types, t.min_params, t.max_params, st.class_id
    FROM ${tx(starts)} st
    JOIN ci_tmp_sites s ON s.id = st.site_id AND NOT s.is_navigation
    JOIN ci_tmp_hierarchy h ON h.class_id = st.class_id
    JOIN ci_symbols t ON t.parent_id = h.ancestor_id AND t.name = s.method_name
    WHERE t.kind = ANY(${CALLABLES}) AND ${arityFits} AND ${visible}
    UNION ALL
    SELECT st.site_id, st.grp, st.resolution, h.ancestor_id, t.id, t.param_types, t.min_params, t.max_params, st.class_id
    FROM ${tx(starts)} st
    JOIN ci_tmp_sites s ON s.id = st.site_id AND s.is_navigation
    JOIN ci_tmp_hierarchy h ON h.class_id = st.class_id
    JOIN ci_symbols t ON t.parent_id = h.ancestor_id
    WHERE ${arityFits} AND ${visible}
      AND ((t.kind = 'property' AND t.name = s.method_name AND NOT t.is_local)
        OR (t.kind = 'method' AND t.max_params = 0 AND t.name IN (
          'get' || upper(left(s.method_name, 1)) || substr(s.method_name, 2),
          -- url → getURL, urlSak → getURLSak (Kotlin's name for an acronym getter)
          'get' || upper(substring(s.method_name FROM '^[[:lower:]]+')) || substring(s.method_name FROM '^[[:lower:]]+(.*)$'))))
  `;
}

/**
 * An override in a subclass of the owner hides the owner's method (same group). Scoped to
 * the sites in `sites` when given.
 */
async function removeOverridden(tx: Tx, sites: string | null): Promise<void> {
  const scope = sites ? tx`AND a.site_id IN (SELECT site_id FROM ${tx(sites)})` : tx``;
  await tx`
    DELETE FROM ci_tmp_cands a
    USING ci_tmp_cands b, ci_tmp_hierarchy h
    WHERE b.site_id = a.site_id AND b.grp = a.grp AND b.owner_id <> a.owner_id
      AND h.class_id = b.owner_id AND h.ancestor_id = a.owner_id
      AND ${sameSignature(tx, "a", "b")} ${scope}
  `;
}

/** Sites narrowCandidates left alone keep their first group. */
async function keepFirstGroup(tx: Tx): Promise<void> {
  await tx`
    DELETE FROM ci_tmp_cands c
    USING (SELECT site_id, min(grp) AS grp FROM ci_tmp_cands GROUP BY site_id) f
    WHERE c.site_id = f.site_id AND c.grp > f.grp
  `;
}

/**
 * Receivers whose type comes from a symbol rather than from the call site, resolved after
 * every other site so their inputs are final:
 * - a chain `a.b().c()` / `a.b.c()`: the declared type of each target the receiver step
 *   resolved to (resolution `chain`). The step itself is never a chain site, so a chain
 *   stops after one hop;
 * - an identifier the file's scope does not declare: the nearest non-private property of
 *   that name in the caller class's supertypes (resolution `typed`), since a base class in
 *   another file is outside the per-file scope walk.
 * Each receiver class is its own lookup group, narrowed on its own, and every group keeps
 * its candidates. Extension functions are not tried on these receivers.
 */
async function resolveDerivedReceivers(tx: Tx, repoId: string, arityFits: Fragment, visible: Fragment): Promise<void> {
  await tx`
    CREATE TEMP TABLE ci_tmp_derived ON COMMIT DROP AS
    SELECT DISTINCT s.id AS site_id, c.target_id AS typed_by, 'chain'::text AS resolution
    FROM ci_tmp_sites s JOIN ci_tmp_cands c ON c.site_id = s.receiver_site_id
    WHERE s.receiver_site_id IS NOT NULL
    UNION ALL
    (SELECT DISTINCT ON (s.id) s.id, t.id, 'typed'
    FROM ci_tmp_sites s
    JOIN ci_tmp_hierarchy h ON h.class_id = s.caller_class_id
    JOIN ci_symbols t ON t.parent_id = h.ancestor_id AND t.kind = 'property' AND t.name = s.receiver
    WHERE s.receiver_kind = 'identifier' AND s.receiver_type IS NULL AND NOT s.receiver_declared
      AND t.declared_type IS NOT NULL AND NOT t.is_local
      AND (h.depth = 0 OR t.visibility IS DISTINCT FROM 'private')
    ORDER BY s.id, h.depth)
  `;
  await resolveTypeNames(tx, repoId, "derived");
  // One lookup group per receiver class: the step may have resolved to unrelated classes.
  await tx`
    CREATE TEMP TABLE ci_tmp_starts2 ON COMMIT DROP AS
    SELECT site_id, dense_rank() OVER (PARTITION BY site_id ORDER BY class_id)::int AS grp, class_id, resolution
    FROM (
      SELECT DISTINCT d.site_id, x.class_id, d.resolution
      FROM ci_tmp_derived d
      JOIN ci_tmp_type_resolved x ON x.ref_kind = 'decl' AND x.ref_id = d.typed_by
    ) r
  `;
  await insertMemberCandidates(tx, "ci_tmp_starts2", arityFits, visible);
  await removeOverridden(tx, "ci_tmp_starts2");
  await narrowCandidates(tx, "ci_tmp_starts2", true);
}

/**
 * Functions for sites without a member candidate: receiverless calls reach top-level
 * functions and Java static imports; extension functions need their receiver class in
 * the site's context, or to be the only one of the name (see rebuildEdges). One owner per site: rank, the caller's file,
 * owner id. A top-level function's owner is its file.
 */
async function insertFunctionCandidates(
  tx: Tx,
  repoId: string,
  arityFits: Fragment,
  visible: Fragment,
): Promise<void> {
  await tx`
    CREATE TEMP TABLE ci_tmp_fsites ON COMMIT DROP AS
    SELECT s.*, CASE WHEN s.receiver_kind = 'none' THEN 'local' ELSE 'typed' END AS resolution
    FROM ci_tmp_sites s
    WHERE (s.receiver_kind = 'none'
        OR EXISTS (SELECT 1 FROM ci_tmp_type_resolved x WHERE x.ref_kind = 'typed' AND x.ref_id = s.id))
      AND NOT s.is_navigation
      AND NOT EXISTS (SELECT 1 FROM ci_tmp_cands c WHERE c.site_id = s.id)
  `;
  await tx`CREATE INDEX ON ci_tmp_fsites (id)`;
  await tx`ANALYZE ci_tmp_fsites (id)`;
  // Classes an extension receiver may be in: the hierarchies of the lookup classes and
  // of the caller's own extension receiver.
  await tx`
    CREATE TEMP TABLE ci_tmp_ext_ctx ON COMMIT DROP AS
    SELECT DISTINCT fs.id AS site_id, h.ancestor_id AS class_id
    FROM ci_tmp_fsites fs
    JOIN (
      SELECT st.site_id, st.class_id FROM ci_tmp_starts st
      UNION ALL
      SELECT fs2.id, x.class_id FROM ci_tmp_fsites fs2
      JOIN ci_tmp_type_resolved x ON x.ref_kind = 'ext' AND x.ref_id = fs2.source_symbol_id
      WHERE fs2.receiver_kind = 'none'
    ) ctx ON ctx.site_id = fs.id
    JOIN ci_tmp_hierarchy h ON h.class_id = ctx.class_id
  `;
  await tx`CREATE INDEX ON ci_tmp_ext_ctx (site_id, class_id)`;

  await tx`
    INSERT INTO ci_tmp_cands (site_id, grp, resolution, owner_id, target_id, param_types, min_params, max_params, recv_class_id)
    WITH fn AS (
      SELECT s.id AS site_id, 100 AS rank, t.id AS target_id, t.file_id AS target_file,
        coalesce(t.parent_id, t.file_id) AS owner_id
      FROM ci_tmp_fsites s
      JOIN ci_tmp_imports im ON im.file_id = s.file_id AND im.nm = s.method_name
      JOIN ci_symbols t ON t.qualified_name = im.import_path AND t.kind = ANY(${CALLABLES})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE ${arityFits} AND ${visible}
      UNION ALL
      SELECT s.id, 101, t.id, t.file_id, t.file_id
      FROM ci_tmp_fsites s
      JOIN ci_symbols t ON t.qualified_name = coalesce(s.package_name || '.', '') || s.method_name
        AND t.parent_id IS NULL AND t.kind = ANY(${CALLABLES})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE ${arityFits} AND ${visible}
      UNION ALL
      SELECT s.id, 102, t.id, t.file_id, coalesce(t.parent_id, t.file_id)
      FROM ci_tmp_fsites s
      JOIN ci_import_map im ON im.file_id = s.file_id AND im.is_wildcard
      JOIN ci_symbols t ON t.qualified_name = im.import_path || '.' || s.method_name
        AND t.kind = ANY(${CALLABLES})
      JOIN ci_files tf ON tf.id = t.file_id AND tf.repo_id = ${repoId}
      WHERE ${arityFits} AND ${visible}
    ),
    eligible AS (
      SELECT fn.*, s.resolution
      FROM fn
      JOIN ci_tmp_fsites s ON s.id = fn.site_id
      JOIN ci_symbols t ON t.id = fn.target_id
      WHERE CASE WHEN t.extension_receiver IS NULL THEN s.receiver_kind = 'none'
        ELSE EXISTS (
          SELECT 1 FROM ci_tmp_type_resolved x
          JOIN ci_tmp_ext_ctx c ON c.class_id = x.class_id AND c.site_id = fn.site_id
          WHERE x.ref_kind = 'ext' AND x.ref_id = fn.target_id)
        -- Lambda receivers (DSL builders) are not modelled: a receiverless call reaches
        -- the one reachable extension of its name, never one of several.
        OR (s.receiver_kind = 'none' AND (
          SELECT count(DISTINCT f2.target_id) FROM fn f2 JOIN ci_symbols t2 ON t2.id = f2.target_id
          WHERE f2.site_id = fn.site_id AND t2.extension_receiver IS NOT NULL) = 1)
      END
    ),
    picked AS (
      SELECT DISTINCT ON (e.site_id) e.site_id, e.owner_id
      FROM eligible e JOIN ci_tmp_fsites s ON s.id = e.site_id
      ORDER BY e.site_id, e.rank, (e.target_file = s.file_id) DESC, e.owner_id
    )
    SELECT DISTINCT e.site_id, 1, e.resolution, e.owner_id, e.target_id, t.param_types, t.min_params, t.max_params, NULL::uuid
    FROM eligible e
    JOIN picked p ON p.site_id = e.site_id AND p.owner_id = e.owner_id
    JOIN ci_symbols t ON t.id = e.target_id
  `;
}

/**
 * At sites with known argument types or names and more than one candidate, keep the
 * first lookup group with a candidate that is not certainly incompatible, and in it the
 * best fits (narrowOverloads); when no group has one, the first group whole. `perGroup`:
 * narrow each group the same way and keep every group.
 */
async function narrowCandidates(tx: Tx, sites: string | null, perGroup = false): Promise<void> {
  const scope = sites ? tx`AND c.site_id IN (SELECT site_id FROM ${tx(sites)})` : tx``;
  const rows = await tx<{
    site_id: string; grp: number; target_id: string; language: string;
    arg_types: (string | null)[] | null; arg_names: (string | null)[] | null;
    param_types: (string | null)[] | null; param_names: (string | null)[] | null;
    param_type_vars: (string | null)[] | null; vararg: boolean;
  }[]>`
    -- to_json: postgres.js parses a NULL array element as the string "NULL".
    SELECT c.site_id, c.grp, c.target_id, f.language, to_json(cs.arg_types) AS arg_types, to_json(cs.arg_names) AS arg_names,
      to_json(t.param_types) AS param_types, to_json(t.param_names) AS param_names,
      to_json(t.param_type_vars) AS param_type_vars, (t.max_params IS NULL AND t.min_params IS NOT NULL) AS vararg
    FROM ci_tmp_cands c
    JOIN ci_call_sites cs ON cs.id = c.site_id
    JOIN ci_files f ON f.id = cs.file_id
    JOIN ci_symbols t ON t.id = c.target_id
    WHERE c.site_id IN (SELECT site_id FROM ci_tmp_cands GROUP BY site_id HAVING count(DISTINCT target_id) > 1)
      AND (cs.arg_names IS NOT NULL OR EXISTS (SELECT 1 FROM unnest(cs.arg_types) a WHERE a IS NOT NULL))
      ${scope}
    ORDER BY c.site_id, c.grp
  `;
  if (rows.length === 0) return;
  const classNames = new Set((await tx<{ name: string }[]>`SELECT DISTINCT name FROM ci_tmp_classes`).map((r) => r.name));
  // Simple names of every supertype: resolved ancestors, and every clause entry of the
  // class and its ancestors (an external supertype has no symbol but is named there).
  const supers = byName(await tx<NamePair[]>`
    SELECT DISTINCT c.name, a.name AS super_name
    FROM ci_tmp_hierarchy h
    JOIN ci_tmp_classes c ON c.id = h.class_id
    JOIN ci_tmp_classes a ON a.id = h.ancestor_id
    WHERE h.depth > 0
    UNION
    SELECT DISTINCT c.name, substring(ir.type_name FROM '[^.]+$')
    FROM ci_tmp_hierarchy h
    JOIN ci_tmp_classes c ON c.id = h.class_id
    JOIN ci_inheritance_refs ir ON ir.source_symbol_id = h.ancestor_id
  `);
  // Names in `extends` clauses along a class's superclass line only: never an interface's
  // extended interfaces (a Java interface may extend several) or an implemented interface.
  const extendsChain = byName(await tx<NamePair[]>`
    WITH RECURSIVE ch(class_id, anc_id, depth) AS (
      SELECT id, id, 0 FROM ci_tmp_classes WHERE kind <> 'interface'
      UNION ALL
      SELECT ch.class_id, e.target_id, ch.depth + 1
      FROM ch JOIN ci_edges e ON e.source_id = ch.anc_id AND e.kind = 'extends'
      WHERE ch.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT DISTINCT c.name, substring(ir.type_name FROM '[^.]+$') AS super_name
    FROM ch
    JOIN ci_tmp_classes c ON c.id = ch.class_id
    JOIN ci_inheritance_refs ir ON ir.source_symbol_id = ch.anc_id AND ir.kind = 'extends'
  `);
  const ctx: TypeContext = {
    isRepoClass: (n) => classNames.has(n),
    supertypes: (n) => supers.get(n),
    extendsChain: (n) => extendsChain.get(n),
  };

  const dropSites: string[] = [];
  const dropTargets: string[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].site_id === rows[i].site_id) j++;
    const site = { argTypes: rows[i].arg_types, argNames: rows[i].arg_names, language: rows[i].language };
    const all = rows.slice(i, j).map((r) => ({
      id: r.target_id, grp: r.grp, paramTypes: r.param_types, paramNames: r.param_names, paramTypeVars: r.param_type_vars, vararg: r.vararg,
    }));
    const groups = [...new Set(all.map((c) => c.grp))].map((g) => all.filter((c) => c.grp === g));
    const fitsSome = (g: typeof all) => g.some((c) => fitOf(site, c, ctx) > 0);
    const keptList = perGroup
      ? groups.flatMap((g) => (fitsSome(g) ? narrowOverloads(site, g, ctx) : g))
      : (() => {
        const applicable = groups.find(fitsSome);
        return applicable ? narrowOverloads(site, applicable, ctx) : groups[0];
      })();
    const kept = new Set(keptList.map((c) => `${c.grp}:${c.id}`));
    for (const c of all) {
      if (!kept.has(`${c.grp}:${c.id}`)) {
        dropSites.push(rows[i].site_id);
        dropTargets.push(`${c.grp}:${c.id}`);
      }
    }
    i = j;
  }
  if (dropSites.length === 0) return;
  await tx`
    DELETE FROM ci_tmp_cands c
    USING (SELECT unnest(${tx.array(dropSites)}::uuid[]) AS site_id, unnest(${tx.array(dropTargets)}::text[]) AS key) d
    WHERE c.site_id = d.site_id AND c.grp || ':' || c.target_id = d.key
  `;
}

type NamePair = { name: string; super_name: string };

/** Class simple name → the supertype simple names paired with it. */
function byName(pairs: NamePair[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of pairs) {
    let set = out.get(p.name);
    if (!set) out.set(p.name, (set = new Set()));
    set.add(p.super_name);
  }
  return out;
}
