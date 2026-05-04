import { indexRepo } from "./indexer/index.ts";
import { hybridSearch } from "./search/hybrid-search.ts";
import { loadRepoConfigs, repoConfigFromArgs } from "./config.ts";
import { closeDb } from "./db/connection.ts";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.slice(1).filter((a) => !a.startsWith("--"));

async function main() {
  switch (command) {
    case "index": {
      const target = positional[0];
      const full = flags.has("--full");
      const skipEmbeddings = flags.has("--no-embed");
      if (!target) {
        const configs = await loadRepoConfigs();
        if (configs.length === 0) {
          console.error("Usage: bun run src/cli.ts index [--full] [--no-embed] <repo-path>");
          console.error("  or create a repos.json with repo configurations");
          process.exit(1);
        }
        for (const config of configs) {
          await indexRepo(config, { full, skipEmbeddings });
        }
      } else {
        const name = positional[1];
        const config = repoConfigFromArgs(target, name);
        await indexRepo(config, { full, skipEmbeddings });
      }
      break;
    }

    case "embed": {
      const { embedSymbols } = await import("./indexer/embedder.ts");
      const result = await embedSymbols();
      console.log(
        `[yggdrasil] Done. Embedded ${result.embedded} symbols (${result.failed} failed) in ${result.durationMs}ms`,
      );
      break;
    }

    case "search": {
      const query = process.argv.slice(3).join(" ");
      if (!query) {
        console.error("Usage: bun run src/cli.ts search <query>");
        process.exit(1);
      }
      const results = await hybridSearch(query, { limit: 10 });
      for (const r of results) {
        console.log(
          `  ${r.kind.padEnd(10)} ${r.qualified_name}`,
        );
        console.log(
          `           ${r.repo_name}/${r.file_path}:${r.start_line} (score: ${r.score.toFixed(4)})`,
        );
      }
      break;
    }

    default:
      console.log("Yggdrasil — Code Intelligence Engine");
      console.log("");
      console.log("Commands:");
      console.log("  index [--full] [--no-embed] <repo-path> [name]  Index a codebase");
      console.log("  index [--full] [--no-embed]                     Index all repos from repos.json");
      console.log("  embed                                           Backfill embeddings for all symbols");
      console.log("  search <query>                                  Search indexed symbols");
      console.log("");
      console.log("MCP server:");
      console.log("  bun run start              Start MCP server (port 9130)");
      console.log("  bun run dev                Start MCP server with --watch");
  }

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
