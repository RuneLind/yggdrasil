import { hybridSearch, type SearchResult } from "./hybrid-search.ts";
import { analyzeImpactBySymbolId, type ImpactEntry } from "./impact.ts";
import { getSymbolById } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges, type EdgeNeighbor } from "../db/edges.ts";
import { edgeBuckets, withDispatchedCallers, type CallerNeighbor } from "./symbol-context.ts";

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
  /** Direct callers, then callers that reach this method by dispatch (with `via`). */
  callers: CallerNeighbor[];
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
    // Drive everything off the candidate's concrete id — the edges (getIncoming/Outgoing)
    // and blast radius then describe the SAME symbol as `target`, instead of re-resolving
    // by qualified_name and risking a different overload for each.
    const [target, incoming, outgoing, impact] = await Promise.all([
      getSymbolById(c.id),
      getIncomingEdges(c.id),
      getOutgoingEdges(c.id),
      analyzeImpactBySymbolId(c.id, { maxDepth }),
    ]);

    if (!target) return null;

    const affected = impact?.affected ?? [];
    const b = edgeBuckets(incoming, outgoing);
    const cap = <T>(xs: T[]) => xs.slice(0, MAX_PER_BUCKET);
    const callers = cap(withDispatchedCallers(b.callers, affected));
    const callees = cap(b.callees);
    const ext = cap(b.extends);
    const impl = cap(b.implements);
    const extBy = cap(b.extended_by);
    const implBy = cap(b.implemented_by);

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
