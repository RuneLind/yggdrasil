import { indexRepo } from "./indexer/index.ts";
import { hybridSearch } from "./search/hybrid-search.ts";
import { loadRepoConfigs, repoConfigFromArgs } from "./config.ts";
import { closeDb } from "./db/connection.ts";

const command = process.argv[2];

async function main() {
  switch (command) {
    case "index": {
      const target = process.argv[3];
      if (!target) {
        // Index all repos from repos.json
        const configs = await loadRepoConfigs();
        if (configs.length === 0) {
          console.error("Usage: bun run src/cli.ts index <repo-path>");
          console.error("  or create a repos.json with repo configurations");
          process.exit(1);
        }
        for (const config of configs) {
          await indexRepo(config);
        }
      } else {
        // Index a single repo by path
        const name = process.argv[4]; // optional name override
        const config = repoConfigFromArgs(target, name);
        await indexRepo(config);
      }
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
      console.log("  index <repo-path> [name]   Index a codebase");
      console.log("  index                      Index all repos from repos.json");
      console.log("  search <query>             Search indexed symbols");
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
