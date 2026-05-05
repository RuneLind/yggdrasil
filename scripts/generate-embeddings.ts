/**
 * Backfill embeddings for every symbol that doesn't have one yet, across all
 * repos. Indexing now embeds inline (see src/indexer/embedder.ts) so this is a
 * recovery / migration tool for indexes that pre-date that wiring.
 */
import { embedSymbols } from "../src/indexer/embedder.ts";
import { closeDb } from "../src/db/connection.ts";

async function main() {
  const result = await embedSymbols();
  console.log(
    `[yggdrasil] Done. ${result.embedded} embedded, ${result.failed} failed in ${result.durationMs}ms.`,
  );
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
