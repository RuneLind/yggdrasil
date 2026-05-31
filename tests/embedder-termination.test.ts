import { describe, test, expect } from "bun:test";
import { embedSymbols, type EmbedDeps } from "../src/indexer/embedder.ts";

/**
 * Regression guard for the embedder infinite-loop bug: the old `while(true)` + bare
 * `LIMIT` drain re-fetched the same NULL-embedding rows forever whenever embedding
 * generation kept failing (poison input / model outage), hanging `bun run embed` and
 * pinning CPU. The fix pages by an id cursor that advances past every row regardless of
 * embed success. These tests stub the DB/model seams and assert the loop terminates.
 */
type Row = { id: string; qualified_name: string; signature: string | null; doc_comment: string | null };

function rows(ids: string[]): Row[] {
  return ids.map((id) => ({ id, qualified_name: id, signature: null, doc_comment: null }));
}

/** A fetch that pages a fixed in-memory set by the id cursor — it deliberately ignores
 *  "embedding IS NULL", mimicking rows that never get an embedding because embed() fails. */
function cursorFetch(all: Row[]): EmbedDeps["fetch"] {
  return async (limit, _repoId, afterId) => {
    const startIdx = afterId ? all.findIndex((r) => r.id === afterId) + 1 : 0;
    return all.slice(startIdx, startIdx + limit);
  };
}

describe("embedSymbols drain loop", () => {
  test("terminates when every symbol fails to embed (the infinite-loop case)", async () => {
    const all = rows(["a", "b", "c", "d", "e"]);
    const seenCursors: (string | undefined)[] = [];
    const deps: EmbedDeps = {
      warmup: async () => {},
      embed: async () => null, // always fail
      update: async () => {
        throw new Error("update must not run when embed returns null");
      },
      fetch: async (limit, repoId, afterId) => {
        seenCursors.push(afterId);
        return cursorFetch(all)(limit, repoId, afterId);
      },
    };

    const result = await embedSymbols(undefined, deps);

    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(5);
    expect(seenCursors[0]).toBeUndefined(); // first page starts with no cursor
    expect(seenCursors).toContain("e"); // cursor advanced to the last id, then drained
  });

  test("embeds every row across multiple pages, each exactly once", async () => {
    const all = rows(Array.from({ length: 120 }, (_, i) => `id-${String(i).padStart(3, "0")}`));
    const embeddedIds: string[] = [];
    const deps: EmbedDeps = {
      warmup: async () => {},
      embed: async () => [0.1, 0.2, 0.3],
      update: async (id) => {
        embeddedIds.push(id);
      },
      fetch: cursorFetch(all),
    };

    const result = await embedSymbols(undefined, deps);

    expect(result.embedded).toBe(120);
    expect(result.failed).toBe(0);
    expect(new Set(embeddedIds).size).toBe(120); // no row processed twice
  });

  test("a poison row among good rows does not stall the rest", async () => {
    const all = rows(["g1", "g2", "BAD", "g3", "g4"]);
    const deps: EmbedDeps = {
      warmup: async () => {},
      // symbolEmbeddingText(sym) is just the qualified_name here, so "BAD" fails.
      embed: async (text) => (text === "BAD" ? null : [1, 2, 3]),
      update: async () => {},
      fetch: cursorFetch(all),
    };

    const result = await embedSymbols(undefined, deps);

    expect(result.embedded).toBe(4);
    expect(result.failed).toBe(1);
  });
});
