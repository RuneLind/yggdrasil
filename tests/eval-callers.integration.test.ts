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
const OV = "src/main/java/no/nav/test/Ov.java";
const OV_USER = "src/main/java/no/nav/test/OvBruker.java";
// Over 200 characters, so the stored signature is cut before `f(` and its first `(` is
// the annotation's, which holds two arguments.
const LONG = "x".repeat(220);

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
      [OV]: `package no.nav.test;

public class Ov {
    @Deprecated(since = "${LONG}", forRemoval = false)
    public static void f(int a) {}
    public static void f(int a, int b) {}
    public static void g(int a) {}
    public static void g(int a, int b) {}
    public static void h(String s) {}
    public static void h(long a) {}
}
`,
      [OV_USER]: `package no.nav.test;

public class OvBruker {
    void en() { Ov.f(1); Ov.g(1); }
    void to() { Ov.f(1, 2); Ov.g(1, 2); }
    void str() { Ov.h("a"); }
    void num() { Ov.h(1L); }
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

  test("repo not in the index → exit 1 with the reason on stderr", async () => {
    const r = await runEval(await tempFixture(fixture(`itest-missing-${crypto.randomUUID().slice(0, 8)}`, MAIN)));
    expect(r.stderr).toContain("is not indexed");
    expect(r.code).toBe(1);
  });

  const overloadFixture = (method: string) =>
    JSON.stringify({
      repo: repo.name,
      symbols: [
        {
          qualified_name: `no.nav.test.Ov.${method}`,
          intellij_signature: `${method}(int)`,
          file: OV,
          callers: [{ signature: "en()", file: OV_USER }],
        },
      ],
    });

  // Fails when eval main() stops passing the fixture's IntelliJ parameter count.
  test("overloads are told apart by the fixture's parameter count", async () => {
    const r = await runEval(await tempFixture(overloadFixture("g")));
    expect(r.stdout).not.toContain("not disambiguated");
    expect(r.stdout).toMatch(/production\s+recall 100% \(1\/1\)\s+precision 100% \(1\/1\)/);
  });

  test("an overload whose stored signature is cut inside an annotation is told apart", async () => {
    const r = await runEval(await tempFixture(overloadFixture("f")));
    expect(r.stdout).not.toContain("not disambiguated");
    expect(r.stdout).toMatch(/production\s+recall 100% \(1\/1\)\s+precision 100% \(1\/1\)/);
  });

  // Same arity: only the IntelliJ parameter types tell h(String) from h(long).
  test("same-arity overloads are told apart by the fixture's parameter types", async () => {
    const r = await runEval(
      await tempFixture(
        JSON.stringify({
          repo: repo.name,
          symbols: [
            {
              qualified_name: "no.nav.test.Ov.h",
              intellij_signature: "h(String)",
              file: OV,
              callers: [{ signature: "OvBruker.str()", file: OV_USER }],
            },
          ],
        }),
      ),
    );
    expect(r.stdout).not.toContain("not disambiguated");
    expect(r.stdout).toMatch(/production\s+recall 100% \(1\/1\)\s+precision 100% \(1\/1\)/);
  });

  test("a symbol missing from the index gets no file-mismatch note", async () => {
    const r = await runEval(
      await tempFixture(
        JSON.stringify({ repo: repo.name, symbols: [{ qualified_name: "no.nav.test.Finnes.ikke", file: MAIN, callers: [] }] }),
      ),
    );
    expect(r.stdout).toContain("not found in the index");
    expect(r.stdout).not.toContain("matches no candidate");
  });
});
