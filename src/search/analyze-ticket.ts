import { hybridSearch, type SearchResult } from "./hybrid-search.ts";
import { analyzeImpact, type ImpactEntry } from "./impact.ts";
import { findSymbolByQualifiedName } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges } from "../db/edges.ts";

export interface AnalyzeTicketOptions {
  repo?: string;
  topK?: number;
  maxDepth?: number;
}

interface EdgeRef {
  kind: string;
  qualified_name: string;
  name: string;
  file_path: string;
  repo_name: string;
}

export interface AnalyzedSymbol {
  target: {
    name: string;
    qualified_name: string;
    kind: string;
    file: string;
    lines: string;
    signature: string | null;
    visibility: string | null;
    doc_comment: string | null;
  };
  callers: EdgeRef[];
  callees: EdgeRef[];
  inheritance: {
    extends: EdgeRef[];
    implements: EdgeRef[];
    extended_by: EdgeRef[];
    implemented_by: EdgeRef[];
  };
  blast_radius: {
    total: number;
    by_repo: Record<string, number>;
    top: ImpactEntry[];
  };
  affected_tests: ImpactEntry[];
}

export interface AnalyzeTicketResult {
  ticket: { text: string; repo?: string };
  candidates: SearchResult[];
  symbols: AnalyzedSymbol[];
  summary: {
    total_candidates: number;
    total_blast_radius: number;
    total_affected_tests: number;
    repos: string[];
  };
}

const TOP_BLAST_PER_SYMBOL = 25;
const MAX_EDGES_PER_BUCKET = 25;

/** A path is test-like if it lives under a conventional test directory or matches a *Test/*Spec filename. */
function isTestPath(filePath: string): boolean {
  if (/(^|\/)(test|tests|__tests__|src\/test)\//i.test(filePath)) return true;
  return /(?:Test|Spec|IT)\.(?:java|kt|kts|ts|tsx)$/.test(filePath)
    || /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(filePath);
}

function toEdgeRef(e: { kind: string; qualified_name: string; name: string; file_path: string; repo_name: string }): EdgeRef {
  return {
    kind: e.kind,
    qualified_name: e.qualified_name,
    name: e.name,
    file_path: e.file_path,
    repo_name: e.repo_name,
  };
}

/**
 * Bundle search → per-symbol context + impact + test filter into one structured response.
 * Pure orchestration over existing primitives; no schema changes, no new DB queries.
 */
export async function analyzeTicket(
  ticketText: string,
  options?: AnalyzeTicketOptions,
): Promise<AnalyzeTicketResult> {
  const topK = options?.topK ?? 5;
  const maxDepth = options?.maxDepth ?? 2;
  const repo = options?.repo;

  const candidates = await hybridSearch(ticketText, { repo, limit: topK });

  const symbols: AnalyzedSymbol[] = [];
  const reposTouched = new Set<string>();
  let totalBlast = 0;
  let totalTests = 0;

  for (const c of candidates) {
    reposTouched.add(c.repo_name);

    const matches = await findSymbolByQualifiedName(c.qualified_name, repo);
    if (matches.length === 0) continue;
    const target = matches[0];

    const [incoming, outgoing, impact] = await Promise.all([
      getIncomingEdges(target.id),
      getOutgoingEdges(target.id),
      analyzeImpact(c.qualified_name, { repo, maxDepth }),
    ]);

    const callers = incoming.filter((e) => e.kind === "calls").slice(0, MAX_EDGES_PER_BUCKET).map(toEdgeRef);
    const callees = outgoing.filter((e) => e.kind === "calls").slice(0, MAX_EDGES_PER_BUCKET).map(toEdgeRef);
    const ext = outgoing.filter((e) => e.kind === "extends").map(toEdgeRef);
    const impl = outgoing.filter((e) => e.kind === "implements").map(toEdgeRef);
    const extBy = incoming.filter((e) => e.kind === "extends").map(toEdgeRef);
    const implBy = incoming.filter((e) => e.kind === "implements").map(toEdgeRef);

    const affected = impact?.affected ?? [];
    const byRepo: Record<string, number> = {};
    for (const a of affected) byRepo[a.repo_name] = (byRepo[a.repo_name] ?? 0) + 1;
    const tests = affected.filter((a) => isTestPath(a.file_path));

    totalBlast += affected.length;
    totalTests += tests.length;

    symbols.push({
      target: {
        name: target.name,
        qualified_name: target.qualified_name,
        kind: target.kind,
        file: `${target.repo_name}/${target.file_path}`,
        lines: `${target.start_line}-${target.end_line}`,
        signature: target.signature,
        visibility: target.visibility,
        doc_comment: target.doc_comment,
      },
      callers,
      callees,
      inheritance: { extends: ext, implements: impl, extended_by: extBy, implemented_by: implBy },
      blast_radius: {
        total: affected.length,
        by_repo: byRepo,
        top: affected.slice(0, TOP_BLAST_PER_SYMBOL),
      },
      affected_tests: tests.slice(0, TOP_BLAST_PER_SYMBOL),
    });
  }

  return {
    ticket: { text: ticketText, ...(repo ? { repo } : {}) },
    candidates,
    symbols,
    summary: {
      total_candidates: candidates.length,
      total_blast_radius: totalBlast,
      total_affected_tests: totalTests,
      repos: [...reposTouched].sort(),
    },
  };
}
