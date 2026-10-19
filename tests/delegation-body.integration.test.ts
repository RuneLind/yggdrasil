import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpactBySymbolId } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Delegating Kotlin classes whose body the grammar reads as a trailing lambda on the
 * delegate (see misparsedKotlinLambdas), through the real indexer. Every class here is its
 * file's last declaration, so each body is misparsed.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/delegation-body.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.db";

async function symbolRows(repo: FixtureRepo, qn: string): Promise<string[]> {
  const rows = await sql<{ start_line: number; is_local: boolean; is_static: boolean }[]>`
    SELECT s.start_line, s.is_local, s.is_static FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
    WHERE r.name = ${repo.name} AND s.qualified_name = ${qn} ORDER BY s.start_line`;
  return rows.map((r) => `${r.start_line} ${r.is_local ? "local" : "member"} ${r.is_static ? "static" : "-"}`);
}

async function idAt(repo: FixtureRepo, qn: string, line: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT s.id FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
    WHERE r.name = ${repo.name} AND s.qualified_name = ${qn} AND s.start_line = ${line}`;
  if (rows.length !== 1) throw new Error(`${qn}:${line} matched ${rows.length} symbols`);
  return rows[0].id;
}

describe.skipIf(!RUN)("misparsed delegating class bodies", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/db/Elvis.kt": `package ${P}

interface EI {
    fun foo(): String
}

class EImpl : EI {
    override fun foo(): String = "impl"
}

class EBruk(private val i: EI) {
    fun use(): String = i.foo()
}

class EX(d: EI?) : EI by d ?: EImpl() {
    override fun foo(): String {
        return "x"
    }
}
`,
      "src/main/kotlin/no/nav/db/Objekt.kt": `package ${P}

interface OI {
    fun foo(): String
}

class OX : OI by (object : OI {
    override fun foo(): String = "2"
    fun loc(): Int = 1
}) {
    override fun foo(): String = "1"
}
`,
      "src/main/kotlin/no/nav/db/Companion.kt": `package ${P}

interface CI {
    fun foo(): String
}

class CBruk {
    fun lag(): Int = CX.make()
}

class CX(d: CI) : CI by d {
    override fun foo(): String = ""

    companion object {
        const val C = 1
        fun make(): Int = 1
    }
}
`,
      "src/main/kotlin/no/nav/db/Repo.kt": `package ${P}

class Repo {
    fun find(id: Int): String = ""
}

class Annen {
    fun find(id: Int): String = ""
}
`,
      "src/main/kotlin/no/nav/db/Konstruktor.kt": `package ${P}

interface RI {
    fun foo(): String
}

class RX(private val r: Repo, d: RI) : RI by d {
    override fun foo(): String {
        return r.find(1)
    }
}
`,
    }, ["kotlin"]);
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("an elvis delegate's class overrides the interface, and dispatch reaches its callers", async () => {
    expect((await repo.edgesFrom(`${P}.EX.foo`, "overrides")).map((e) => `${e.sourceLine}->${e.target}:${e.targetLine}`))
      .toEqual([`16->${P}.EI.foo:4`]);
    const r = (await analyzeImpactBySymbolId(await idAt(repo, `${P}.EX.foo`, 16), { maxDepth: 1 }))!;
    expect(r.affected.map((a) => `${a.qualified_name}|${a.edge_kind}|${a.via}`)).toContain(`${P}.EBruk.use|calls|${P}.EI.foo`);
  });

  test("an object-literal delegate's members stay local: one OX.foo override, from the class body", async () => {
    expect((await repo.edgesFrom(`${P}.OX.foo`, "overrides")).map((e) => `${e.sourceLine}->${e.target}`))
      .toEqual([`11->${P}.OI.foo`]);
    expect(await symbolRows(repo, `${P}.OX.foo`)).toEqual(["8 local -", "11 member -"]);
    expect(await symbolRows(repo, `${P}.OX.loc`)).toEqual(["9 local -"]);
  });

  test("companion members are static, non-local members, and a call through the class reaches them", async () => {
    expect(await symbolRows(repo, `${P}.CX.make`)).toEqual(["16 member static"]);
    expect(await symbolRows(repo, `${P}.CX.C`)).toEqual(["15 member static"]);
    expect((await repo.edgesFrom(`${P}.CBruk.lag`, "calls")).map((e) => `${e.target}:${e.targetLine}`)).toEqual([`${P}.CX.make:16`]);
  });

  test("a constructor property's receiver type resolves the call to its class", async () => {
    expect((await repo.edgesFrom(`${P}.RX.foo`, "calls")).map((e) => `${e.target}|${e.resolution}`)).toEqual([`${P}.Repo.find|typed`]);
  });
});
