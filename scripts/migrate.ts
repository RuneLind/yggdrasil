import { sql } from "../src/db/connection.ts";
import { join } from "path";
import { readdirSync, readFileSync } from "fs";

const MIGRATIONS_DIR = join(import.meta.dir, "../db/migrations");

async function migrate() {
  // Ensure migrations table exists
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Get applied migrations
  const applied = new Set(
    (await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`).map(
      (r) => r.version,
    ),
  );

  // Get migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace(".sql", "");
    if (applied.has(version)) continue;

    console.log(`Applying migration: ${file}`);
    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${version}, ${file})`;
    });

    count++;
  }

  if (count === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(`Applied ${count} migration(s).`);
  }

  await sql.end();
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
