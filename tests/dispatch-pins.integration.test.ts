import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpactBySymbolId } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Tie-breaks in impact, the extension-receiver type in overrides edges, and the same-line
 * call edge dedupe, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/dispatch-pins.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.dpin";

describe.skipIf(!RUN)("dispatch tie-breaks and signatures", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/dpin/Rank.kt": `package ${P}

open class Base {
    open fun bar(): String {
        return "b"
    }
}

class FooImpl : Base() {
    override fun bar(): String {
        return "f"
    }
}

class Bruk(private val b: Base) {
    fun kall(): String {
        return b.bar()
    }
}
`,
      "src/main/kotlin/no/nav/dpin/Ext.kt": `package ${P}

interface S {
    fun String.s(): Int
    fun Long.s(): Int
}

abstract class SImpl : S {
    override fun String.s(): Int {
        return 1
    }
}
`,
      "src/main/kotlin/no/nav/dpin/Sup.kt": `package ${P}

open class SBase {
    open fun g(): String {
        return ""
    }
}

class SSub(private val other: SBase) : SBase() {
    override fun g(): String {
        return super.g() + other.g()
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  // The indexer never gives one symbol both a call and an extends/implements/imports
  // edge (callables own calls, classes the rest), so the edge is inserted by hand to pin
  // the order getImpact documents.
  test("at equal depth another direct edge beats a dispatched call", async () => {
    const id = async (qn: string) =>
      (await sql<{ id: string }[]>`
        SELECT s.id FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
        WHERE r.name = ${repo.name} AND s.qualified_name = ${qn}`)[0].id;
    const seed = await id(`${P}.FooImpl.bar`);
    const kall = await id(`${P}.Bruk.kall`);
    const entry = async () =>
      (await analyzeImpactBySymbolId(seed, { maxDepth: 1 }))!.affected.map((a) => `${a.qualified_name}|${a.depth}|${a.edge_kind}|${a.via}`);
    expect(await entry()).toEqual([`${P}.Bruk.kall|1|calls|${P}.Base.bar`]);
    await sql`INSERT INTO ci_edges (source_id, target_id, kind, line) VALUES (${kall}, ${seed}, 'imports', NULL)`;
    try {
      expect(await entry()).toEqual([`${P}.Bruk.kall|1|imports|null`]);
    } finally {
      await sql`DELETE FROM ci_edges WHERE source_id = ${kall} AND target_id = ${seed} AND kind = 'imports'`;
    }
  });

  test("an extension override links only the ancestor with the same receiver type", async () => {
    const edges = await repo.edgesFrom(`${P}.SImpl.s`, "overrides");
    expect(edges.map((e) => `${e.sourceLine}->${e.target}:${e.targetLine}`)).toEqual([`9->${P}.S.s:4`]);
  });

  test("on one line a typed call edge is kept over a super call to the same target", async () => {
    const edges = await repo.edgesFrom(`${P}.SSub.g`, "calls");
    expect(edges.map((e) => `${e.line}->${e.target}:${e.targetLine}|${e.resolution}`)).toEqual([`11->${P}.SBase.g:4|typed`]);
  });
});
