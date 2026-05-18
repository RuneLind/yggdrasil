import { hybridSearch, type SearchResult } from "./hybrid-search.ts";
import { analyzeImpact, type ImpactEntry } from "./impact.ts";
import { findSymbolByQualifiedName } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges, type EdgeNeighbor } from "../db/edges.ts";

export interface AnalyzeTicketOptions {
  repo?: string;
  topK?: number;
  maxDepth?: number;
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
  callers: EdgeNeighbor[];
  callees: EdgeNeighbor[];
  inheritance: {
    extends: EdgeNeighbor[];
    implements: EdgeNeighbor[];
    extended_by: EdgeNeighbor[];
    implemented_by: EdgeNeighbor[];
  };
  blast_radius: {
    total: number;
    by_repo: Record<string, number>;
    top: ImpactEntry[];
  };
  affected_tests: {
    total: number;
    top: ImpactEntry[];
  };
}

export interface AnalyzeTicketResult {
  ticket: { text: string };
  candidates: SearchResult[];
  symbols: AnalyzedSymbol[];
  summary: {
    total_candidates: number;
    total_blast_radius: number;
    total_affected_tests: number;
    repos: string[];
  };
}

const MAX_PER_BUCKET = 25;

export async function analyzeTicket(
  ticketText: string,
  options?: AnalyzeTicketOptions,
): Promise<AnalyzeTicketResult> {
  const topK = options?.topK ?? 5;
  const maxDepth = options?.maxDepth ?? 2;
  const repo = options?.repo;

  const candidates = await hybridSearch(ticketText, { repo, limit: topK });

  const perCandidate = await Promise.all(candidates.map(async (c): Promise<AnalyzedSymbol | null> => {
    const [details, incoming, outgoing, impact] = await Promise.all([
      findSymbolByQualifiedName(c.qualified_name, repo),
      getIncomingEdges(c.id),
      getOutgoingEdges(c.id),
      analyzeImpact(c.qualified_name, { repo, maxDepth }),
    ]);

    const target = details[0];
    if (!target) return null;

    const callers = incoming.filter((e) => e.kind === "calls").slice(0, MAX_PER_BUCKET);
    const callees = outgoing.filter((e) => e.kind === "calls").slice(0, MAX_PER_BUCKET);
    const ext = outgoing.filter((e) => e.kind === "extends").slice(0, MAX_PER_BUCKET);
    const impl = outgoing.filter((e) => e.kind === "implements").slice(0, MAX_PER_BUCKET);
    const extBy = incoming.filter((e) => e.kind === "extends").slice(0, MAX_PER_BUCKET);
    const implBy = incoming.filter((e) => e.kind === "implements").slice(0, MAX_PER_BUCKET);

    const affected = impact?.affected ?? [];
    const byRepo: Record<string, number> = {};
    for (const a of affected) byRepo[a.repo_name] = (byRepo[a.repo_name] ?? 0) + 1;
    const tests = affected.filter((a) => a.archetype === "test");

    return {
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
        top: affected.slice(0, MAX_PER_BUCKET),
      },
      affected_tests: {
        total: tests.length,
        top: tests.slice(0, MAX_PER_BUCKET),
      },
    };
  }));

  const symbols = perCandidate.filter((s): s is AnalyzedSymbol => s !== null);
  const reposTouched = new Set(candidates.map((c) => c.repo_name));
  let totalBlast = 0;
  let totalTests = 0;
  for (const s of symbols) {
    totalBlast += s.blast_radius.total;
    totalTests += s.affected_tests.total;
  }

  return {
    ticket: { text: ticketText },
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
