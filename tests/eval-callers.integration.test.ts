import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { runEval, tempFixture } from "./helpers/run-eval.ts";

/**
 * `bun run eval:callers` end to end against a fixture repo indexed through the real indexer.
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 (needs Postgres with the ci_* schema).
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const MAIN = "src/main/kotlin/no/nav/test/Tjeneste.kt";
const TEST = "src/test/kotlin/no/nav/test/TjenesteTest.kt";
const PAREN_NAME = "lagre med LAV parent og HØY child skal beholde child sin HØY (typen vinner)";
const DOT_NAME = "versjon 2.0 skal lagres";

describe.skipIf(!RUN)("eval-callers on a fixture repo", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      [MAIN]: `package no.nav.test

object Tjeneste {
    fun lagre(a: Int) = a
}
`,
      [TEST]: `package no.nav.test

class TjenesteTest {
    fun \`${PAREN_NAME}\`() {
        Tjeneste.lagre(1)
    }

    fun \`${DOT_NAME}\`() {
        Tjeneste.lagre(2)
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  const fixture = (repoName: string, file: string) =>
    JSON.stringify({
      repo: repoName,
      symbols: [
        {
          qualified_name: "no.nav.test.Tjeneste.lagre",
          intellij_signature: "lagre(Int)",
          file,
          callers: [
            // IntelliJ renders a backticked Kotlin name both ways; cover both.
            { signature: `TjenesteTest.${PAREN_NAME}()`, file: TEST },
            { signature: `TjenesteTest.\`${DOT_NAME}\`()`, file: TEST },
          ],
        },
      ],
    });

  test("test names containing ( and . match their callers", async () => {
    const r = await runEval(await tempFixture(fixture(repo.name, MAIN)));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/all callers\s+recall 100% \(2\/2\)/);
  });

  test("a fixture file that matches no candidate prints a note", async () => {
    const r = await runEval(await tempFixture(fixture(repo.name, "src/main/kotlin/Feil.kt")));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("file src/main/kotlin/Feil.kt matches no candidate");
  });

  test("repo not in the index → exit 1", async () => {
    const r = await runEval(await tempFixture(fixture(`itest-missing-${crypto.randomUUID().slice(0, 8)}`, MAIN)));
    expect(r.code).toBe(1);
  });
});
