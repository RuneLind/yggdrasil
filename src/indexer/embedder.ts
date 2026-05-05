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

/** Idempotent — safe to re-run. Scoped to `repoId` when provided. */
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
