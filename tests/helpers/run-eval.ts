import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/eval-callers.ts");
const ROOT = resolve(import.meta.dir, "../..");

/** Write `content` to a temp fixture file (never under eval/fixtures/) and return its path. */
export async function tempFixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yggdrasil-eval-"));
  const path = join(dir, "fixture.json");
  await writeFile(path, content);
  return path;
}

export async function runEval(fixturePath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, fixturePath], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
