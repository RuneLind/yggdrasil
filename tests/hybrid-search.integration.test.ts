import { describe, test, expect } from "bun:test";
import { hybridSearch } from "../src/search/hybrid-search.ts";
import { SearchTracer } from "../src/tracing/trace.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Integration test for the FTS OR-fallback (F2) in hybrid search.
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 because it needs:
 *   - a running Postgres with the ci_* schema migrated
 *   - melosys-api indexed *with embeddings*
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/hybrid-search.integration.test.ts`
 *
 * Regression guard for the 2026-05-04 "natural-language search returns []" bug:
 * plainto_tsquery ANDs every token, so a 6-word query matches no single symbol's
 * search_vector. The fix is two-fold — embeddings now exist (so the semantic leg
 * works) and the FTS leg retries with the tokens ORed together when the strict AND
 * yields nothing.
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

// 6-word NL query. The strict-AND FTS leg returns 0; the OR-fallback must kick in.
const NL_QUERY = "søknad journalføring eksisterende sak opprett behandling";

describe.skipIf(!RUN)("hybrid search FTS OR-fallback against real melosys-api index", () => {
  // No closeDb() here: bun runs every test file in one process on one shared pool,
  // so ending it in this file's afterAll failed the integration files that ran after it.

  test("multi-word natural-language query returns relevant results", async () => {
    const results = await hybridSearch(NL_QUERY, { repo: "melosys-api", limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    // Top hits should be søknad/behandling domain symbols, not random noise.
    expect(results.some((r) => /Søknad|Behandling/i.test(r.qualified_name))).toBe(true);
  });

  test("FTS leg contributes via the OR-fallback (not the semantic leg alone)", async () => {
    // First prove the precondition the fallback exists for: the strict-AND FTS
    // query returns 0 for this NL query (same predicate + repo filter hybridSearch
    // uses). Without this, the candidate assertion below could pass on an AND hit
    // and never exercise the fallback at all.
    const andRows = await sql`
      SELECT s.id
      FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE s.search_vector @@ plainto_tsquery('simple', ${NL_QUERY})
        AND r.name = 'melosys-api'
      LIMIT 1
    `;
    expect(andRows.length).toBe(0);

    const tracer = new SearchTracer();
    await hybridSearch(NL_QUERY, { repo: "melosys-api", limit: 10, tracer });
    const trace = tracer.toJSON();
    const ftsCandidates = trace.candidates.filter((c) => c.stages.fts);
    // Strict AND is empty (asserted above), so any FTS candidate can only have come
    // from the OR-fallback. Without F2 this is 0 and the semantic leg carries search.
    expect(ftsCandidates.length).toBeGreaterThan(0);
  });
});
