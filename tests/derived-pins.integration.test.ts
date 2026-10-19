import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Rules of the derived phase (chains, inherited properties) that only show through the
 * rebuild: which property and getter a step reaches, how candidates on a derived receiver
 * narrow, and how a same-line duplicate keeps its resolution.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/derived-pins.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.dv";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("derived receiver rules", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/dv/Typer.kt": `package ${P}

open class A {
    open fun hent(): String {
        return "a"
    }
}

class B : A() {
    override fun hent(): String {
        return "b"
    }
}

class Fagsak {
    fun saksnummer(): String {
        return ""
    }

    fun lagre(s: String) {
    }

    fun lagre(n: Int) {
    }
}

class Annen {
    fun saksnummer(): String {
        return ""
    }
}
`,
      // The same property name at two depths: the nearest wins.
      "src/main/kotlin/no/nav/dv/Arv.kt": `package ${P}

abstract class Topp {
    open val svc: A = A()
}

abstract class Midt : Topp() {
    override val svc: B = B()
}

class Bunn : Midt() {
    fun bruk() = svc.hent()
}
`,
      // A constructor property is no symbol; an extension function of the same name must
      // not type the step.
      "src/main/kotlin/no/nav/dv/Holder.kt": `package ${P}

class H(val fagsak: Fagsak)

fun H.fagsak(): Annen = Annen()

class HBruk(private val h: H) {
    fun bruk() = h.fagsak.saksnummer()
}
`,
      "src/main/java/no/nav/dv/JB.java": `package ${P};

public class JB {
    public Fagsak getFagsak() {
        return null;
    }

    public Annen getFagsak(int... xs) {
        return null;
    }
}
`,
      "src/main/kotlin/no/nav/dv/Repo.kt": `package ${P}

class Repo {
    class Resultat {
        fun ok(): Boolean {
            return true
        }
    }

    fun hent(id: Long): Fagsak {
        return Fagsak()
    }

    fun lagB(): B {
        return B()
    }

    fun resultat(): Resultat {
        return Resultat()
    }
}

class RBruk(private val repo: Repo, private val jb: JB) {
    fun sammeLinje(f: Fagsak) = repo.hent(1L).saksnummer() + f.saksnummer()
    fun getter() = jb.fagsak.saksnummer()
    fun overstyrt() = repo.lagB().hent()
    fun overload() = repo.hent(1L).lagre("s")
    fun nestet() = repo.resultat().ok()
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the nearest inherited property of a name types the receiver", async () => {
    expect(await callsFrom(repo, `${P}.Bunn.bruk`)).toEqual([`${P}.B.hent:10@typed`]);
  });

  test("a navigation step never takes a function candidate", async () => {
    expect(await callsFrom(repo, `${P}.HBruk.bruk`)).toEqual([]);
  });

  test("a call and a chain to one target on one line keep typed", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.sammeLinje`)).toEqual([`${P}.Fagsak.saksnummer:16@typed`, `${P}.Repo.hent:10@typed`]);
  });

  test("a navigation step reaches the getter without parameters only", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.getter`)).toEqual([`${P}.Fagsak.saksnummer:16@chain`]);
  });

  test("an override in the chain receiver's class hides the ancestor's method", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.overstyrt`)).toEqual([`${P}.B.hent:10@chain`, `${P}.Repo.lagB:14@typed`]);
  });

  test("argument types narrow overloads on a chain receiver", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.overload`)).toEqual([`${P}.Fagsak.lagre:20@chain`, `${P}.Repo.hent:10@typed`]);
  });

  test("a declared type naming a member type resolves in the declaring class", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.nestet`)).toEqual([`${P}.Repo.Resultat.ok:5@chain`, `${P}.Repo.resultat:18@typed`]);
  });
});
