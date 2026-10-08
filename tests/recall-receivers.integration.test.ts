import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Receivers the per-file scope walk cannot type on its own: inherited properties, mock
 * factory locals, `super`, and Kotlin class delegation, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/recall-receivers.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.r";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("receivers typed outside the file's scope", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/r/Service.kt": `package ${P}

class Service {
    fun hent(): String = ""
}

class Annen {
    fun hent(): String = ""
}

interface Port {
    fun send(x: String)
}

class PortImpl : Port {
    override fun send(x: String) {}
}

// Delegation: Delegert implements Port through impl.
class Delegert(impl: Port) : Port by impl

class Bruker(private val d: Delegert) {
    fun bruk() = d.send("x")
}
`,
      "src/test/kotlin/no/nav/r/BaseTest.kt": `package ${P}

abstract class BaseTest {
    protected lateinit var service: Service
    protected val annen: Annen = Annen()
}
`,
      "src/test/kotlin/no/nav/r/MidTest.kt": `package ${P}

abstract class MidTest : BaseTest()
`,
      "src/test/kotlin/no/nav/r/ServiceTest.kt": `package ${P}

class ServiceTest : MidTest() {
    fun arvet() = service.hent()
    fun arvetVal() = annen.hent()
    fun lokal() {
        val service = Annen()
        service.hent()
    }
    fun lokalUtenType() {
        val service = lag()
        service.hent()
    }
    fun lag() = Service()
    fun mock() {
        val m = mockk<Service>()
        m.hent()
        val s = spyk<Annen>(Annen())
        s.hent()
        val r = mockk<Service>(relaxed = true)
        r.hent()
    }
}
`,
      "src/main/java/no/nav/r/Base.java": `package ${P};

public class Base {
    public String navn() { return ""; }
    public String tom() { return ""; }
}
`,
      "src/main/java/no/nav/r/Mid.java": `package ${P};

public class Mid extends Base {
    @Override
    public String navn() { return super.navn(); }
}
`,
      "src/main/java/no/nav/r/Leaf.java": `package ${P};

public class Leaf extends Mid {
    @Override
    public String navn() { return super.navn() + super.tom(); }
}
`,
      "src/main/kotlin/no/nav/r/KLeaf.kt": `package ${P}

class KLeaf : Mid() {
    override fun navn(): String = super.navn()
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("an undeclared identifier resolves to a property of a supertype in another file", async () => {
    expect(await callsFrom(repo, `${P}.ServiceTest.arvet`)).toEqual([`${P}.Service.hent:4@typed`]);
    expect(await callsFrom(repo, `${P}.ServiceTest.arvetVal`)).toEqual([`${P}.Annen.hent:8@typed`]);
  });

  test("a local shadows the inherited property", async () => {
    expect(await callsFrom(repo, `${P}.ServiceTest.lokal`)).toEqual([`${P}.Annen.hent:8@typed`]);
    // Declared without a type: unknown, never the inherited property's type.
    expect(await callsFrom(repo, `${P}.ServiceTest.lokalUtenType`)).toEqual([`${P}.ServiceTest.lag:14@local`]);
  });

  test("mockk<T>(), spyk<T>() locals are typed as T", async () => {
    expect(await callsFrom(repo, `${P}.ServiceTest.mock`)).toEqual([
      `${P}.Annen.hent:8@typed`, `${P}.Service.hent:4@typed`, `${P}.Service.hent:4@typed`,
    ]);
  });

  test("super.foo() reaches the nearest ancestor that declares foo", async () => {
    expect(await callsFrom(repo, `${P}.Mid.navn`)).toEqual([`${P}.Base.navn:4@local`]);
    expect(await callsFrom(repo, `${P}.Leaf.navn`)).toEqual([`${P}.Base.tom:5@local`, `${P}.Mid.navn:4@local`]);
    expect(await callsFrom(repo, `${P}.KLeaf.navn`)).toEqual([`${P}.Mid.navn:4@local`]);
  });

  test("Kotlin class delegation is an implements edge, so calls on its members resolve", async () => {
    expect((await repo.edgesFrom(`${P}.Delegert`, "implements")).map((e) => e.target)).toEqual([`${P}.Port`]);
    expect(await callsFrom(repo, `${P}.Bruker.bruk`)).toEqual([`${P}.Port.send:12@typed`]);
  });
});
