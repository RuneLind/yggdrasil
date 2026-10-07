import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { detectChanges } from "../src/search/detect-changes.ts";

/**
 * detect_changes end to end on a fixture git repo with a non-ASCII file name (G8).
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 (needs Postgres with the ci_* schema).
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/detect-changes.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const FILE = "src/main/kotlin/no/nav/test/Årsavregning.kt";

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

describe.skipIf(!RUN)("detect_changes on a fixture repo", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      [FILE]: `package no.nav.test

object Årsavregning {
    fun lagNy() = 1
}
`,
    });
    await git(repo.path, "init", "-q");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "init");
    // Uncommitted edit inside lagNy; detectChanges diffs the working tree.
    await writeFile(
      join(repo.path, FILE),
      `package no.nav.test

object Årsavregning {
    fun lagNy() = 2
}
`,
    );
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a changed file with Å in its path maps to its indexed symbols", async () => {
    const result = await detectChanges(repo.name);
    expect(result?.changedFiles).toEqual([FILE]);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toContain("no.nav.test.Årsavregning.lagNy");
  });
});
