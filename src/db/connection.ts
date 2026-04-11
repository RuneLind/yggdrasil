import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://muninn:muninn@127.0.0.1:5435/muninn";

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export async function closeDb(): Promise<void> {
  await sql.end();
}
