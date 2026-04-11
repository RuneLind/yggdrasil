/**
 * Batch generate embeddings for all symbols that don't have one yet.
 */
import { getSymbolsWithoutEmbeddings, updateSymbolEmbedding } from "../src/db/symbols.ts";
import { generateEmbedding, warmupEmbeddings, symbolEmbeddingText } from "../src/embeddings.ts";
import { closeDb } from "../src/db/connection.ts";

const BATCH_SIZE = 50;

async function main() {
  console.log("[yggdrasil] Warming up embedding model...");
  await warmupEmbeddings();
  console.log("[yggdrasil] Model ready.\n");

  let totalProcessed = 0;
  let totalFailed = 0;

  while (true) {
    const batch = await getSymbolsWithoutEmbeddings(BATCH_SIZE);
    if (batch.length === 0) break;

    for (const sym of batch) {
      const embedding = await generateEmbedding(symbolEmbeddingText(sym));
      if (embedding) {
        await updateSymbolEmbedding(sym.id, embedding);
        totalProcessed++;
      } else {
        totalFailed++;
      }
    }

    process.stdout.write(`\r[yggdrasil] Embedded ${totalProcessed} symbols (${totalFailed} failed)`);
  }

  console.log(`\n[yggdrasil] Done. ${totalProcessed} embedded, ${totalFailed} failed.`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
