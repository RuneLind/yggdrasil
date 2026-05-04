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

/**
 * Generate embeddings for every symbol in `repoId` (or every repo when omitted)
 * that doesn't already have one. Idempotent — safe to re-run.
 *
 * The embedding model is warmed up once per call (~hundreds of ms cold) and
 * reused for the whole batch loop, so per-call overhead is amortised across
 * symbols.
 */
export async function embedSymbols(repoId?: string): Promise<EmbedResult> {
  const start = performance.now();
  await warmupEmbeddings();

  let embedded = 0;
  let failed = 0;

  while (true) {
    const batch = await getSymbolsWithoutEmbeddings(BATCH_SIZE, repoId);
    if (batch.length === 0) break;

    for (const sym of batch) {
      const vec = await generateEmbedding(symbolEmbeddingText(sym));
      if (vec) {
        await updateSymbolEmbedding(sym.id, vec);
        embedded++;
      } else {
        failed++;
      }
    }

    process.stdout.write(
      `\r[yggdrasil] Embedded ${embedded} symbols (${failed} failed)`,
    );
  }

  if (embedded > 0 || failed > 0) process.stdout.write("\n");

  return { embedded, failed, durationMs: Math.round(performance.now() - start) };
}
