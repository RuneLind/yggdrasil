import { describe, test, expect, afterAll } from "bun:test";
import postgres from "postgres";

/**
 * Focused test for the FTS OR-fallback (F2) swap mechanism in hybrid search.
 *
 * The fallback in `src/search/hybrid-search.ts` turns a strict-AND tsquery into an
 * all-OR one by swapping '&'→'|' on the *parsed* tsquery text:
 *
 *     replace(plainto_tsquery('simple', $q)::text, ' & ', ' | ')::tsquery
 *
 * That swap happens inside Postgres (it reuses Postgres's lexing — diacritics,
 * punctuation, stop-words — rather than re-tokenizing in JS), so the unit under
 * test is the SQL expression, not a JS function. This test exercises exactly that
 * expression against a real Postgres, but needs ONLY a connection — no ci_* schema,
 * no index, no embeddings. It therefore runs as part of the default `bun test`
 * wherever a DB is reachable (and self-skips otherwise), unlike the heavier
 * `hybrid-search.integration.test.ts` which needs melosys-api fully indexed.
 *
 * Keep the swap expression here in sync with hybrid-search.ts.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://muninn:muninn@127.0.0.1:5435/muninn";

// Dedicated short-lived connection so a missing DB skips fast (3s) instead of
// hanging on the shared pool's longer connect timeout.
const db = postgres(DATABASE_URL, { max: 1, connect_timeout: 3, idle_timeout: 5 });

let DB_AVAILABLE = false;
try {
  await db`SELECT 1`;
  DB_AVAILABLE = true;
} catch {
  DB_AVAILABLE = false;
}

// Mirrors the swap expression in src/search/hybrid-search.ts.
const orFallback = (q: string) =>
  db`SELECT replace(plainto_tsquery('simple', ${q})::text, ' & ', ' | ')::tsquery::text AS t`;

describe.skipIf(!DB_AVAILABLE)("FTS OR-fallback swap (needs only Postgres)", () => {
  afterAll(async () => {
    await db.end();
  });

  test("plainto_tsquery only ANDs tokens — the precondition the swap relies on", async () => {
    // The swap is only safe because plainto_tsquery emits nothing but '&' between
    // lexemes (never '|', phrase '<->', or negation '!'). If a future Postgres
    // changes that, this assertion fails before the swap can silently misbehave.
    const [{ t }] = await db`
      SELECT plainto_tsquery('simple', ${"søknad journalføring eksisterende sak"})::text AS t
    `;
    expect(t).toContain("&");
    expect(t).not.toContain("|");
    expect(t).not.toContain("<->");
    expect(t).not.toContain("!");
  });

  test("swaps every AND into an OR, preserving lexed tokens and diacritics", async () => {
    const [{ t }] = await orFallback("søknad journalføring eksisterende sak");
    expect(t).toBe("'søknad' | 'journalføring' | 'eksisterende' | 'sak'");
  });

  test("OR-fallback widens recall: matches a doc with only one of the tokens", async () => {
    const q = "søknad journalføring eksisterende sak";
    // A document containing just ONE query token — the case that makes a multi-word
    // AND query return 0 (the original 2026-05-04 empty-search bug).
    const [{ and_match, or_match }] = await db`
      SELECT
        to_tsvector('simple', 'noe tekst om søknad og litt mer') @@ plainto_tsquery('simple', ${q}) AS and_match,
        to_tsvector('simple', 'noe tekst om søknad og litt mer')
          @@ replace(plainto_tsquery('simple', ${q})::text, ' & ', ' | ')::tsquery AS or_match
    `;
    expect(and_match).toBe(false);
    expect(or_match).toBe(true);
  });

  test("single-token query: swap is a no-op and stays a valid tsquery", async () => {
    // No '&' to replace, so the fallback text equals the original — and it must
    // still parse as a tsquery (the ::tsquery cast would throw otherwise).
    const [{ t }] = await orFallback("behandling");
    expect(t).toBe("'behandling'");
  });
});
