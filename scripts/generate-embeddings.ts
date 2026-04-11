/**
 * Batch generate embeddings for all symbols that don't have one yet.
 */
import { getSymbolsWithoutEmbeddings, updateSymbolEmbedding } from "../src/db/symbols.ts";
import { generateEmbedding, warmupEmbeddings } from "../src/embeddings.ts";
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
      // Build embedding input: qualified_name + signature + doc_comment
      const parts = [sym.qualified_name];
      if (sym.signature) parts.push(sym.signature);
      if (sym.doc_comment) parts.push(sym.doc_comment);
      const text = parts.join(" ");

      const embedding = await generateEmbedding(text);
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
