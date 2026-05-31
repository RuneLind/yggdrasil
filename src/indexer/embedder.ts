import { getSymbolsWithoutEmbeddings, updateSymbolEmbedding } from "../db/symbols.ts";
import {
  generateEmbedding,
  symbolEmbeddingText,
  warmupEmbeddings,
} from "../embeddings.ts";

const BATCH_SIZE = 50;

export interface EmbedResult {
  embedded: number;
  failed: number;
  durationMs: number;
}

/** Injectable seams so the drain loop's termination can be unit-tested without a DB or model. */
export interface EmbedDeps {
  fetch: typeof getSymbolsWithoutEmbeddings;
  embed: typeof generateEmbedding;
  update: typeof updateSymbolEmbedding;
  warmup: typeof warmupEmbeddings;
}

const defaultDeps: EmbedDeps = {
  fetch: getSymbolsWithoutEmbeddings,
  embed: generateEmbedding,
  update: updateSymbolEmbedding,
  warmup: warmupEmbeddings,
};

/**
 * Idempotent — safe to re-run. Scoped to `repoId` when provided.
 *
 * Pages by an id cursor rather than a bare LIMIT: each batch starts after the previous
 * batch's last id, so a symbol that keeps failing to embed stays NULL but is never
 * re-fetched. The loop therefore always advances through the id space and terminates —
 * the old `while(true)` + `LIMIT` form spun forever on any persistently-failing row.
 */
export async function embedSymbols(
  repoId?: string,
  deps: EmbedDeps = defaultDeps,
): Promise<EmbedResult> {
  const start = performance.now();
  await deps.warmup();

  let embedded = 0;
  let failed = 0;
  let afterId: string | undefined;

  while (true) {
    const batch = await deps.fetch(BATCH_SIZE, repoId, afterId);
    if (batch.length === 0) break;

    for (const sym of batch) {
      const vec = await deps.embed(symbolEmbeddingText(sym));
      if (vec) {
        await deps.update(sym.id, vec);
        embedded++;
      } else {
        failed++;
      }
    }

    // Advance past this page regardless of per-symbol success (batch is ordered by id),
    // so failed rows can't be re-fetched and stall the loop.
    afterId = batch[batch.length - 1].id;

    process.stdout.write(
      `\r[yggdrasil] Embedded ${embedded} symbols (${failed} failed)`,
    );
  }

  if (embedded > 0 || failed > 0) process.stdout.write("\n");

  return { embedded, failed, durationMs: Math.round(performance.now() - start) };
}
