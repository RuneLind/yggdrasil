import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * `super` calls, receivers that name an inherited property, and the declarations that
 * type chain steps, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/super-scope.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.ss";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("super calls", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/no/nav/ss/JI.java": `package ${P};

public interface JI {
    default String g() {
        return "i";
    }

    String toString();
}
`,
      "src/main/java/no/nav/ss/JBase.java": `package ${P};

public class JBase {
    public String g() {
        return "b";
    }

    public String h() {
        return "";
    }
}
`,
      "src/main/java/no/nav/ss/JSub.java": `package ${P};

public class JSub extends JBase implements JI {
    public String g() {
        return super.g();
    }

    public String viaI() {
        return JI.super.g();
    }
}
`,
      "src/main/java/no/nav/ss/JOnlyI.java": `package ${P};

public class JOnlyI implements JI {
    public String toString() {
        return super.toString();
    }
}
`,
      "src/main/java/no/nav/ss/JAbs.java": `package ${P};

public abstract class JAbs implements JI {}
`,
      "src/main/java/no/nav/ss/JSub2.java": `package ${P};

public class JSub2 extends JAbs {
    public String g() {
        return super.g();
    }
}
`,
      "src/main/java/no/nav/ss/JVert.java": `package ${P};

public class JVert {
    JBase lag() {
        return new JBase() {
            public String h() {
                return super.h();
            }
        };
    }
}
`,
      "src/main/kotlin/no/nav/ss/K.kt": `package ${P}

interface KI {
    fun foo(): String {
        return "i"
    }

    fun bar(): String
}

open class KBase {
    open fun foo(): String {
        return "b"
    }

    open fun bar(): String {
        return "b"
    }
}

class KSub : KBase(), KI {
    override fun foo(): String {
        return super<KI>.foo()
    }

    override fun bar(): String {
        return super.bar()
    }
}

class KOnly : KI {
    override fun foo(): String {
        return super.foo()
    }

    override fun bar(): String {
        return ""
    }
}

class Vert : KBase() {
    fun lag(): KI {
        return object : KI {
            override fun foo(): String {
                return super.foo()
            }

            override fun bar(): String {
                return ""
            }
        }
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("Java super reaches the superclass chain, not the implemented interfaces", async () => {
    expect(await callsFrom(repo, `${P}.JSub.g`)).toEqual([`${P}.JBase.g:4@super`]);
  });

  test("Java super in a class without a superclass never reaches an implemented interface", async () => {
    expect(await callsFrom(repo, `${P}.JOnlyI.toString`)).toEqual([]);
  });

  test("Java I.super.g() reaches the interface, resolved as super", async () => {
    expect(await callsFrom(repo, `${P}.JSub.viaI`)).toEqual([`${P}.JI.g:4@super`]);
  });

  test("Java super reaches an interface default method through the superclass", async () => {
    expect(await callsFrom(repo, `${P}.JSub2.g`)).toEqual([`${P}.JI.g:4@super`]);
  });

  test("Java super in an anonymous class reaches the anonymous class's supertype", async () => {
    expect(await callsFrom(repo, `${P}.JVert.lag`)).toEqual([`${P}.JBase.h:8@super`]);
  });

  test("Kotlin super<I> reaches I only", async () => {
    expect(await callsFrom(repo, `${P}.KSub.foo`)).toEqual([`${P}.KI.foo:4@super`]);
  });

  test("Kotlin super reaches the superclass before an interface", async () => {
    expect(await callsFrom(repo, `${P}.KSub.bar`)).toEqual([`${P}.KBase.bar:16@super`]);
  });

  test("Kotlin super without a superclass reaches the interface default", async () => {
    expect(await callsFrom(repo, `${P}.KOnly.foo`)).toEqual([`${P}.KI.foo:4@super`]);
  });

  test("Kotlin super in an object literal reaches the literal's supertype", async () => {
    expect(await callsFrom(repo, `${P}.Vert.lag`)).toEqual([`${P}.KI.foo:4@super`]);
  });
});

describe.skipIf(!RUN)("inherited properties and chain step types", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/ss/Typer.kt": `package ${P}

class Tjeneste {
    fun hent(): String {
        return ""
    }
}

class Annen {
    fun hent(): String {
        return ""
    }
}

class Fagsak {
    fun saksnummer(): String {
        return ""
    }
}

class Response {
    fun body(): String {
        return ""
    }
}
`,
      "src/main/kotlin/no/nav/ss/BaseTest.kt": `package ${P}

abstract class BaseTest {
    lateinit var service: Tjeneste
    private val skjult: Tjeneste = Tjeneste()

    init {
        val iInit: Tjeneste = Tjeneste()
    }
}
`,
      "src/main/kotlin/no/nav/ss/SubTest.kt": `package ${P}

class SubTest : BaseTest() {
    fun a(): String {
        return this.service.hent()
    }

    fun b(): String {
        return this@SubTest.service.hent()
    }

    fun c(): String {
        return skjult.hent()
    }

    fun annen(): Annen {
        return Annen()
    }

    fun d() {
        when (val service = annen()) {
            else -> service.hent()
        }
    }

    fun e() {
        when (val service: Annen = annen()) {
            else -> service.hent()
        }
    }

    fun f(): String {
        return iInit.hent()
    }
}
`,
      "src/main/java/no/nav/ss/JSubTest.java": `package ${P};

public class JSubTest extends BaseTest {
    String a() {
        return this.service.hent();
    }
}
`,
      "src/main/kotlin/no/nav/ss/Holder.kt": `package ${P}

class Holder {
    init {
        val iInit: Fagsak = Fagsak()
    }

    val lambda = {
        val iLambda: Fagsak = Fagsak()
        iLambda
    }

    fun x() = 1; val b: Fagsak = Fagsak()
}

class HolderBruk(private val h: Holder) {
    fun fraInit() = h.iInit.saksnummer()
    fun lambda() = h.iLambda.saksnummer()
    fun samme() = h.b.saksnummer()
}
`,
      "src/main/kotlin/no/nav/ss/Handler.kt": `package ${P}

abstract class Handler<Response> {
    abstract fun handle(): Response
    abstract val siste: Response

    fun bruk() {
        handle().body()
        siste.body()
    }

    fun <Response> lag(): Response? {
        return null
    }

    fun brukLag() {
        lag<Response>()?.body()
    }
}
`,
      "src/main/java/no/nav/ss/JNett.java": `package ${P};

public class JNett {
    public Fagsak getURL() {
        return null;
    }

    public Fagsak getURLSak() {
        return null;
    }
}
`,
      "src/main/kotlin/no/nav/ss/Nett.kt": `package ${P}

class Nett(private val n: JNett) {
    fun a() = n.url.saksnummer()
    fun b() = n.urlSak.saksnummer()
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("this.x and this@Label.x name an inherited property when the class does not declare x", async () => {
    expect(await callsFrom(repo, `${P}.SubTest.a`)).toEqual([`${P}.Tjeneste.hent:4@typed`]);
    expect(await callsFrom(repo, `${P}.SubTest.b`)).toEqual([`${P}.Tjeneste.hent:4@typed`]);
  });

  test("Java this.field names an inherited Kotlin property", async () => {
    expect(await callsFrom(repo, `${P}.JSubTest.a`)).toEqual([`${P}.Tjeneste.hent:4@typed`]);
  });

  test("a private base-class property is not inherited, nor a local of its init block", async () => {
    expect(await callsFrom(repo, `${P}.SubTest.c`)).toEqual([]);
    expect(await callsFrom(repo, `${P}.SubTest.f`)).toEqual([]);
  });

  test("a when subject binding shadows an inherited property", async () => {
    expect(await callsFrom(repo, `${P}.SubTest.d`)).toEqual([`${P}.SubTest.annen:16@local`]);
    expect(await callsFrom(repo, `${P}.SubTest.e`)).toEqual([`${P}.Annen.hent:10@typed`, `${P}.SubTest.annen:16@local`]);
  });

  test("locals in init blocks and property-initializer lambdas are not member properties", async () => {
    expect(await callsFrom(repo, `${P}.HolderBruk.fraInit`)).toEqual([]);
    expect(await callsFrom(repo, `${P}.HolderBruk.lambda`)).toEqual([]);
  });

  test("a property on the same line as a function is a member property", async () => {
    expect(await callsFrom(repo, `${P}.HolderBruk.samme`)).toEqual([`${P}.Fagsak.saksnummer:16@chain`]);
  });

  test("a type-parameter return or property type never types a chain as a same-named class", async () => {
    expect(await callsFrom(repo, `${P}.Handler.bruk`)).toEqual([`${P}.Handler.handle:4@local`]);
    expect(await callsFrom(repo, `${P}.Handler.brukLag`)).toEqual([`${P}.Handler.lag:12@local`]);
  });

  test("Kotlin property syntax reaches a Java getter with an acronym", async () => {
    expect(await callsFrom(repo, `${P}.Nett.a`)).toEqual([`${P}.Fagsak.saksnummer:16@chain`]);
    expect(await callsFrom(repo, `${P}.Nett.b`)).toEqual([`${P}.Fagsak.saksnummer:16@chain`]);
  });
});
