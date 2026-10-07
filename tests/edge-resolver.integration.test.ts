import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Edge resolution through the real indexer on a throwaway fixture repo.
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 because it needs a running Postgres with
 * the ci_* schema migrated. Writes only under a unique `itest-*` repo name.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/edge-resolver.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("edge resolution on a fixture repo", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/test/Årsavregning.kt": `package no.nav.test

object Årsavregning {
    fun lagNy() = 1
}
`,
      "src/main/kotlin/no/nav/test/Avregning.kt": `package no.nav.test

object Avregning {
    fun lagNy() = 2
}
`,
      "src/main/kotlin/no/nav/test/Bruker.kt": `package no.nav.test

class Bruker {
    fun opprett(): Int {
        return Årsavregning.lagNy() + Avregning.lagNy()
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  // Control: proves the harness indexes and resolves a plain static call, so the
  // Å case below fails for the receiver regex and not for a harness fault.
  test("static call on an ASCII receiver resolves to a calls edge", async () => {
    const edges = await repo.edgesTo("no.nav.test.Avregning.lagNy", "calls");
    expect(edges.map((e) => e.source)).toEqual(["no.nav.test.Bruker.opprett"]);
  });

  // G2: the static-receiver branch tested /^[A-Z]/, so a type starting with Æ/Ø/Å
  // was never treated as a class receiver and the cross-file call was dropped.
  test("static call on a receiver starting with Å resolves to a calls edge", async () => {
    const edges = await repo.edgesTo("no.nav.test.Årsavregning.lagNy", "calls");
    expect(edges.map((e) => e.source)).toEqual(["no.nav.test.Bruker.opprett"]);
  });
});
