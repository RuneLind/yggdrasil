import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * One-hop receiver chains (`a.b().c()`, `a.prop.c()`), resolved through the first step's
 * declared type, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/chains.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.c";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("receiver chains", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/c/Fagsak.kt": `package ${P}

import no.nav.c.bruker.Bruker

class Fagsak {
    fun saksnummer(): String = ""
    fun hentBruker(): Bruker = Bruker()
}
`,
      // Another package: the declared type resolves through the declaring file's imports.
      "src/main/kotlin/no/nav/c/bruker/Bruker.kt": `package ${P}.bruker

class Bruker {
    fun ident(): String = ""
}
`,
      "src/main/kotlin/no/nav/c/Repo.kt": `package ${P}

import no.nav.c.bruker.Bruker

class Repo {
    fun hentBruker(): Bruker = Bruker()
    fun hent(id: Long): Fagsak = Fagsak()
    fun hentNullable(): Fagsak? = null
    fun liste(): List<Fagsak> = listOf()
}

class Holder {
    val fagsak: Fagsak = Fagsak()
    fun lokal() {
        val tmp: Fagsak = Fagsak()
    }
}
`,
      "src/main/java/no/nav/c/JavaBehandling.java": `package ${P};

public class JavaBehandling {
    private Fagsak fagsak;
    public Fagsak getFagsak() { return fagsak; }
}
`,
      "src/main/kotlin/no/nav/c/Bruk.kt": `package ${P}

class Bruk(private val repo: Repo, private val holder: Holder, private val jb: JavaBehandling) {
    fun a() = repo.hent(1L).saksnummer()
    fun b() = repo.hentNullable()?.saksnummer()
    fun c() = repo.hent(1L).hentBruker().ident()
    fun d() = repo.liste().first()
    fun e() = holder.fagsak.saksnummer()
    fun f() = jb.fagsak.saksnummer()
    fun g() = holder.tmp.saksnummer()
    fun h() = repo.hent(1L)!!.hentBruker()
    fun i() = repo.hentBruker().ident()
}
`,
      "src/main/java/no/nav/c/JavaBruk.java": `package ${P};

public class JavaBruk {
    private Repo repo;
    void x() { repo.hent(1L).saksnummer(); }
    void y(JavaBehandling b) { b.getFagsak().hentBruker(); }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a call step resolves the next call on its declared return type (Kotlin)", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.a`)).toEqual([`${P}.Fagsak.saksnummer@chain`, `${P}.Repo.hent@typed`]);
  });

  test("a nullable return type and a safe call still resolve; `!!` is stripped", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.b`)).toEqual([`${P}.Fagsak.saksnummer@chain`, `${P}.Repo.hentNullable@typed`]);
    expect(await callsFrom(repo, `${P}.Bruk.h`)).toEqual([`${P}.Fagsak.hentBruker@chain`, `${P}.Repo.hent@typed`]);
  });

  test("the declared type resolves in the declaring file, which imports it, not in the caller's", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.i`)).toEqual([`${P}.Repo.hentBruker@typed`, `${P}.bruker.Bruker.ident@chain`]);
  });

  test("a chain stops after one hop", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.c`)).toEqual([`${P}.Fagsak.hentBruker@chain`, `${P}.Repo.hent@typed`]);
  });

  test("a declared type outside the repo stops the chain", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.d`)).toEqual([`${P}.Repo.liste@typed`]);
  });

  test("a navigation step resolves to a Kotlin member property's type, not to a local val", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.e`)).toEqual([`${P}.Fagsak.saksnummer@chain`]);
    expect(await callsFrom(repo, `${P}.Bruk.g`)).toEqual([]);
  });

  test("Kotlin property syntax on a Java getter resolves through the getter's return type", async () => {
    expect(await callsFrom(repo, `${P}.Bruk.f`)).toEqual([`${P}.Fagsak.saksnummer@chain`]);
  });

  test("Java call chains resolve", async () => {
    expect(await callsFrom(repo, `${P}.JavaBruk.x`)).toEqual([`${P}.Fagsak.saksnummer@chain`, `${P}.Repo.hent@typed`]);
    expect(await callsFrom(repo, `${P}.JavaBruk.y`)).toEqual([`${P}.Fagsak.hentBruker@chain`, `${P}.JavaBehandling.getFagsak@typed`]);
  });
});
