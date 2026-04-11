import { sql } from "../db/connection.ts";
import { insertEdgesInBatches, type EdgeInsert } from "../db/edges.ts";
import { CONTAINER_KINDS } from "./symbol-extractor.ts";
import type { CallGraphResult } from "./call-graph.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";

/**
 * Resolve extracted calls and inheritance to ci_symbols IDs and create edges.
 *
 * Resolution strategy for method calls:
 * - PascalCase receiver → static call, resolve to that type's method
 * - No receiver / "this" → local call, resolve to same class's method
 * - Instance calls (variable receivers) need type inference — skipped for MVP
 */
export async function resolveAndStoreEdges(
  fileId: string,
  repoId: string,
  extraction: ExtractionResult,
  callGraph: CallGraphResult,
  symbolDbIds: string[],
  qualifiedNames: string[],
): Promise<number> {
  const edges: EdgeInsert[] = [];

  // ── Inheritance ──
  if (callGraph.inheritance.length > 0) {
    const typeNames = [...new Set(callGraph.inheritance.map((ih) => ih.typeName))];

    const targetSymbols = await sql<{ id: string; name: string }[]>`
      SELECT s.id, s.name
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      WHERE f.repo_id = ${repoId}
        AND s.name = ANY(${typeNames})
        AND s.kind = ANY(${[...CONTAINER_KINDS]})
        AND s.parent_id IS NULL
    `;

    const targetByName = new Map<string, string>();
    for (const t of targetSymbols) {
      targetByName.set(t.name, t.id);
    }

    for (const ih of callGraph.inheritance) {
      const sourceId = symbolDbIds[ih.symbolIndex];
      const targetId = targetByName.get(ih.typeName);
      if (sourceId && targetId && sourceId !== targetId) {
        edges.push({ source_id: sourceId, target_id: targetId, kind: ih.kind });
      }
    }
  }

  // ── Method calls ──
  if (callGraph.calls.length > 0) {
    const methodNames = [...new Set(callGraph.calls.map((c) => c.methodName))];
    const candidateMethods = await sql<{
      id: string;
      name: string;
      parent_qualified: string | null;
    }[]>`
      SELECT s.id, s.name, parent.qualified_name as parent_qualified
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      LEFT JOIN ci_symbols parent ON parent.id = s.parent_id
      WHERE f.repo_id = ${repoId}
        AND s.name = ANY(${methodNames})
        AND s.kind IN ('method', 'function', 'constructor')
    `;

    const methodLookup = new Map<string, { id: string; parentQualified: string | null }[]>();
    for (const m of candidateMethods) {
      const arr = methodLookup.get(m.name) || [];
      arr.push({ id: m.id, parentQualified: m.parent_qualified });
      methodLookup.set(m.name, arr);
    }

    for (let i = 0; i < extraction.symbols.length; i++) {
      const sym = extraction.symbols[i];
      if (!["method", "function", "constructor"].includes(sym.kind)) continue;

      const sourceId = symbolDbIds[i];

      for (const call of callGraph.calls) {
        if (call.line < sym.startLine || call.line > sym.endLine) continue;

        const candidates = methodLookup.get(call.methodName);
        if (!candidates) continue;

        if (call.receiver && /^[A-Z]/.test(call.receiver)) {
          // Static call: Receiver.method
          const match = candidates.find((c) =>
            c.parentQualified?.endsWith(`.${call.receiver}`) ||
            c.parentQualified === call.receiver,
          );
          if (match && match.id !== sourceId) {
            edges.push({ source_id: sourceId, target_id: match.id, kind: "calls", line: call.line });
          }
        } else if (call.receiver === null || call.receiver === "this") {
          // Local call: find method in same class
          const parentIdx = sym.parentIndex;
          if (parentIdx !== null) {
            const parentQN = qualifiedNames[parentIdx];
            const match = candidates.find((c) => c.parentQualified === parentQN);
            if (match && match.id !== sourceId) {
              edges.push({ source_id: sourceId, target_id: match.id, kind: "calls", line: call.line });
            }
          }
        }
      }
    }
  }

  // DB ON CONFLICT handles duplicates, so no in-memory dedup needed
  if (edges.length > 0) {
    await insertEdgesInBatches(edges);
  }

  return edges.length;
}
