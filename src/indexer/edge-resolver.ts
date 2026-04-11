import { sql } from "../db/connection.ts";
import { insertEdgesBatch, type EdgeInsert } from "../db/edges.ts";
import type { CallGraphResult } from "./call-graph.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";

/**
 * Resolve extracted calls and inheritance to actual ci_symbols IDs and create edges.
 *
 * Resolution strategy for method calls:
 * 1. If receiver matches a local variable whose type is a known symbol → resolve to that type's method
 * 2. If receiver matches an imported class name → resolve to that class's method
 * 3. If no receiver (direct call) → resolve to a same-file or same-package function
 *
 * For inheritance:
 * - Match the simple type name against imported symbols or same-package symbols
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

  // Build a map of symbol name → DB IDs for this file
  const fileSymbolsByName = new Map<string, { id: string; kind: string; qualifiedName: string }>();
  for (let i = 0; i < extraction.symbols.length; i++) {
    fileSymbolsByName.set(extraction.symbols[i].name, {
      id: symbolDbIds[i],
      kind: extraction.symbols[i].kind,
      qualifiedName: qualifiedNames[i],
    });
  }

  // Get container symbols (classes/interfaces) — these are the "source" for edges
  const containerIds = symbolDbIds.filter((_, i) =>
    ["class", "interface", "enum", "object"].includes(extraction.symbols[i].kind) &&
    extraction.symbols[i].parentIndex === null,
  );

  // ── Resolve inheritance ──
  if (callGraph.inheritance.length > 0) {
    const typeNames = [...new Set(callGraph.inheritance.map((ih) => ih.typeName))];

    // Look up these type names in the same repo's symbols
    const targetSymbols = await sql<{ id: string; name: string; qualified_name: string }[]>`
      SELECT s.id, s.name, s.qualified_name
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      WHERE f.repo_id = ${repoId}
        AND s.name = ANY(${typeNames})
        AND s.kind IN ('class', 'interface', 'enum', 'object')
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
        edges.push({
          source_id: sourceId,
          target_id: targetId,
          kind: ih.kind,
        });
      }
    }
  }

  // ── Resolve method calls ──
  // Strategy: for calls with a receiver that looks like a type name (PascalCase),
  // try to resolve receiver.method as QualifiedTypeName.method in the symbol table.
  // For calls without receiver, try to find the method in the same file's parent class.
  if (callGraph.calls.length > 0) {
    // Collect unique receiver.method combinations
    const callTargets = new Map<string, { receiver: string | null; methodName: string; line: number }>();
    for (const call of callGraph.calls) {
      const key = `${call.receiver ?? ""}::${call.methodName}`;
      if (!callTargets.has(key)) {
        callTargets.set(key, call);
      }
    }

    // Batch-resolve: look for methods in the repo matching the method names
    const methodNames = [...new Set(callGraph.calls.map((c) => c.methodName))];
    const candidateMethods = await sql<{
      id: string;
      name: string;
      qualified_name: string;
      parent_qualified: string | null;
    }[]>`
      SELECT s.id, s.name, s.qualified_name,
             parent.qualified_name as parent_qualified
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      LEFT JOIN ci_symbols parent ON parent.id = s.parent_id
      WHERE f.repo_id = ${repoId}
        AND s.name = ANY(${methodNames})
        AND s.kind IN ('method', 'function', 'constructor')
    `;

    // Build lookup: methodName → list of (id, parentQualifiedName)
    const methodLookup = new Map<string, { id: string; parentQualified: string | null }[]>();
    for (const m of candidateMethods) {
      const arr = methodLookup.get(m.name) || [];
      arr.push({ id: m.id, parentQualified: m.parent_qualified });
      methodLookup.set(m.name, arr);
    }

    // For each container symbol in this file, find calls it makes
    // and try to resolve them
    for (let i = 0; i < extraction.symbols.length; i++) {
      const sym = extraction.symbols[i];
      if (!["method", "function", "constructor"].includes(sym.kind)) continue;

      const sourceId = symbolDbIds[i];
      const sourceStart = sym.startLine;
      const sourceEnd = sym.endLine;

      // Find calls within this method's line range
      for (const call of callGraph.calls) {
        if (call.line < sourceStart || call.line > sourceEnd) continue;

        const candidates = methodLookup.get(call.methodName);
        if (!candidates || candidates.length === 0) continue;

        // If receiver looks like a class name (PascalCase), match against parent class
        if (call.receiver && /^[A-Z]/.test(call.receiver)) {
          // Static call: Receiver.method → find method whose parent matches Receiver
          const match = candidates.find((c) =>
            c.parentQualified?.endsWith(`.${call.receiver}`) ||
            c.parentQualified === call.receiver,
          );
          if (match && match.id !== sourceId) {
            edges.push({
              source_id: sourceId,
              target_id: match.id,
              kind: "calls",
              line: call.line,
            });
          }
        } else if (call.receiver === null || call.receiver === "this") {
          // Local call: find method in the same class
          const parentIdx = sym.parentIndex;
          if (parentIdx !== null) {
            const parentQN = qualifiedNames[parentIdx];
            const match = candidates.find((c) => c.parentQualified === parentQN);
            if (match && match.id !== sourceId) {
              edges.push({
                source_id: sourceId,
                target_id: match.id,
                kind: "calls",
                line: call.line,
              });
            }
          }
        }
        // Instance calls (receiver is a variable name like "service") are harder to resolve
        // without type inference — skip for now (Phase 2 MVP)
      }
    }
  }

  // Deduplicate edges before inserting
  const uniqueEdges = deduplicateEdges(edges);

  if (uniqueEdges.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < uniqueEdges.length; i += BATCH_SIZE) {
      await insertEdgesBatch(uniqueEdges.slice(i, i + BATCH_SIZE));
    }
  }

  return uniqueEdges.length;
}

function deduplicateEdges(edges: EdgeInsert[]): EdgeInsert[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source_id}:${e.target_id}:${e.kind}:${e.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
