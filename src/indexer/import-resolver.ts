import { sql } from "../db/connection.ts";
import { insertEdgesInBatches, type EdgeInsert } from "../db/edges.ts";
import type { ExtractedImport } from "./symbol-extractor.ts";

/** Store raw imports for a file in ci_import_map. */
export async function storeImports(
  fileId: string,
  imports: ExtractedImport[],
): Promise<void> {
  if (imports.length === 0) return;
  await sql`
    INSERT INTO ci_import_map ${sql(
      imports.map((imp) => ({
        file_id: fileId,
        import_path: imp.importPath,
        alias: imp.alias,
        is_wildcard: imp.isWildcard,
      })),
      "file_id",
      "import_path",
      "alias",
      "is_wildcard",
    )}
  `;
}

/**
 * Resolve imports for an entire repo after all files have been indexed.
 * Creates ci_edges with kind="imports" from each file's class/interface/object
 * to the symbols they import.
 *
 * Strategy:
 * - Exact imports: match import_path against ci_symbols.qualified_name
 * - Wildcard imports: match all symbols whose qualified_name starts with the package prefix
 *   and are top-level (class, interface, enum, object)
 */
export async function resolveImports(repoId: string): Promise<number> {
  // Step 1: Resolve exact (non-wildcard) imports
  // For each import, find the matching symbol and link the importing file's
  // container symbol (class/object) to the imported symbol
  const exactEdges = await sql<EdgeInsert[]>`
    WITH resolved AS (
      SELECT DISTINCT
        im.file_id,
        im.import_path,
        target.id as target_id
      FROM ci_import_map im
      JOIN ci_files f ON f.id = im.file_id
      JOIN ci_symbols target ON target.qualified_name = im.import_path
      JOIN ci_files tf ON tf.id = target.file_id
      WHERE f.repo_id = ${repoId}
        AND im.is_wildcard = false
        AND tf.repo_id = ${repoId}
    )
    SELECT
      source.id as source_id,
      r.target_id,
      'imports' as kind,
      null::int as line
    FROM resolved r
    JOIN ci_symbols source ON source.file_id = r.file_id
      AND source.kind IN ('class', 'interface', 'enum', 'object')
      AND source.parent_id IS NULL
  `;

  // Step 2: Resolve wildcard imports
  // import no.nav.melosys.domain.* → match all top-level symbols in that package
  const wildcardEdges = await sql<EdgeInsert[]>`
    WITH wildcard_imports AS (
      SELECT DISTINCT
        im.file_id,
        im.import_path as package_prefix
      FROM ci_import_map im
      JOIN ci_files f ON f.id = im.file_id
      WHERE f.repo_id = ${repoId}
        AND im.is_wildcard = true
    ),
    resolved AS (
      SELECT DISTINCT
        wi.file_id,
        target.id as target_id
      FROM wildcard_imports wi
      JOIN ci_symbols target ON target.qualified_name LIKE wi.package_prefix || '.%'
        AND target.kind IN ('class', 'interface', 'enum', 'object')
        AND target.parent_id IS NULL
      JOIN ci_files tf ON tf.id = target.file_id
      WHERE tf.repo_id = ${repoId}
        -- Only match direct children of the package, not nested classes
        AND target.qualified_name NOT LIKE wi.package_prefix || '.%.%'
    )
    SELECT
      source.id as source_id,
      r.target_id,
      'imports' as kind,
      null::int as line
    FROM resolved r
    JOIN ci_symbols source ON source.file_id = r.file_id
      AND source.kind IN ('class', 'interface', 'enum', 'object')
      AND source.parent_id IS NULL
    WHERE source.id != r.target_id
  `;

  const allEdges = [...exactEdges, ...wildcardEdges];

  if (allEdges.length > 0) {
    await insertEdgesInBatches(allEdges);
  }

  return allEdges.length;
}

/** Delete all import edges for a repo (before re-resolving). */
export async function deleteImportEdges(repoId: string): Promise<number> {
  const result = await sql`
    DELETE FROM ci_edges e
    USING ci_symbols s, ci_files f
    WHERE e.source_id = s.id
      AND s.file_id = f.id
      AND f.repo_id = ${repoId}
      AND e.kind = 'imports'
  `;
  return result.count;
}
