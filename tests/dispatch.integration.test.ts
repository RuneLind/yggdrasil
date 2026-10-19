import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpactBySymbolId } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";
import { ImpactTracer } from "../src/tracing/trace.ts";

/**
 * `overrides` edges and dynamic dispatch in `impact`, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/dispatch.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.d";

async function overridesFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "overrides")).map((e) => `${e.target}:${e.targetLine}`).sort();
}

describe.skipIf(!RUN)("overrides edges over a three-level hierarchy", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      // A Kotlin interface parses as class_declaration.
      "src/main/kotlin/no/nav/d/Foo.kt": `package ${P}

interface Foo {
    fun bar(x: String): String
    fun bar(x: Int): String
    fun baz(): Int
}
`,
      "src/main/kotlin/no/nav/d/AbstractFoo.kt": `package ${P}

abstract class AbstractFoo : Foo {
    override fun bar(x: String): String = x
    private fun hidden(): Int = 1
}
`,
      "src/main/kotlin/no/nav/d/FooImpl.kt": `package ${P}

class FooImpl : AbstractFoo() {
    override fun bar(x: String): String = x
    override fun bar(x: Int): String = ""
    override fun baz(): Int = 2
    private fun hidden(): Int = 3
}
`,
      // Mid declares nothing: Leaf.bar still reaches Foo.bar.
      "src/main/kotlin/no/nav/d/Mid.kt": `package ${P}

abstract class Mid : Foo

class Leaf : Mid() {
    override fun bar(x: String): String = x
    override fun bar(x: Int): String = ""
    override fun baz(): Int = 0
}
`,
      // Java: a class implementing a Kotlin interface; a static method never overrides.
      "src/main/java/no/nav/d/JavaFoo.java": `package ${P};

public class JavaFoo extends AbstractFoo {
    @Override
    public String bar(String x) { return x; }
    public static int stat() { return 1; }
}
`,
      "src/main/java/no/nav/d/JavaSub.java": `package ${P};

public class JavaSub extends JavaFoo {
    public static int stat() { return 2; }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("FooImpl.bar(String) overrides every ancestor declaration, not only the nearest", async () => {
    const all = await repo.edgesFrom(`${P}.FooImpl.bar`, "overrides");
    const fromString = all.filter((e) => e.sourceLine === 4).map((e) => `${e.target}:${e.targetLine}`).sort();
    expect(fromString).toEqual([`${P}.AbstractFoo.bar:4`, `${P}.Foo.bar:4`]);
  });

  test("an overload overrides only the ancestor method with its parameter types", async () => {
    const all = await repo.edgesFrom(`${P}.FooImpl.bar`, "overrides");
    const fromInt = all.filter((e) => e.sourceLine === 5).map((e) => `${e.target}:${e.targetLine}`).sort();
    expect(fromInt).toEqual([`${P}.Foo.bar:5`]);
  });

  test("an ancestor that does not declare the method is skipped", async () => {
    expect(await overridesFrom(repo, `${P}.Leaf.baz`)).toEqual([`${P}.Foo.baz:6`]);
  });

  test("private methods never override; Java overrides a Kotlin interface through a Kotlin class", async () => {
    expect(await overridesFrom(repo, `${P}.FooImpl.hidden`)).toEqual([]);
    expect(await overridesFrom(repo, `${P}.JavaFoo.bar`)).toEqual([`${P}.AbstractFoo.bar:4`, `${P}.Foo.bar:4`]);
  });

  test("a static method hides, never overrides", async () => {
    expect(await overridesFrom(repo, `${P}.JavaSub.stat`)).toEqual([]);
  });

  test("an incremental reindex rebuilds overrides edges", async () => {
    await repo.reindex({
      "src/main/kotlin/no/nav/d/AbstractFoo.kt": `package ${P}

abstract class AbstractFoo : Foo {
    private fun hidden(): Int = 1
}
`,
    });
    const all = await repo.edgesFrom(`${P}.FooImpl.bar`, "overrides");
    expect(all.filter((e) => e.sourceLine === 4).map((e) => e.target)).toEqual([`${P}.Foo.bar`]);
  });
});

describe.skipIf(!RUN)("impact follows dispatch both ways", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/no/nav/d/Fasade.java": `package ${P};

public interface Fasade {
    String hent(long id);
    String hent(String ident);
}
`,
      "src/main/java/no/nav/d/Service.java": `package ${P};

public class Service implements Fasade {
    @Override
    public String hent(long id) { return hent(String.valueOf(id)); }
    @Override
    public String hent(String ident) { return ident; }
}
`,
      "src/main/java/no/nav/d/Annen.java": `package ${P};

public class Annen implements Fasade {
    public String hent(long id) { return ""; }
    public String hent(String ident) { return ""; }
}
`,
      "src/main/kotlin/no/nav/d/Bruker.kt": `package ${P}

class Bruker(private val fasade: Fasade) {
    fun bruk(): String = fasade.hent("a")
    fun bruk2(): String = fasade.hent(1L)
}

// Reaches Service.hent(String) at depth 1 both directly and through the interface.
class Begge(private val fasade: Fasade, private val service: Service) {
    fun begge() {
        fasade.hent("y")
        service.hent("x")
    }
}

class Topp(private val bruker: Bruker) {
    fun topp() = bruker.bruk()
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  const idOf = async (qn: string, paramTypes: string[]) => {
    const [{ id }] = await sql<{ id: string }[]>`
      SELECT s.id FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repo.name} AND s.qualified_name = ${qn} AND s.param_types = ${paramTypes}`;
    return id;
  };

  test("impact(Service.hent(String)) has the interface's callers at depth 1, via the interface method", async () => {
    const r = (await analyzeImpactBySymbolId(await idOf(`${P}.Service.hent`, ["String"]), { maxDepth: 3 }))!;
    const rows = r.affected.map((a) => `${a.qualified_name}|${a.depth}|${a.edge_kind}|${a.resolution}|${a.via}`).sort();
    expect(rows).toEqual([
      // A direct edge beats a dispatched one at the same depth.
      `${P}.Begge.begge|1|calls|typed|null`,
      // Dispatch at depth 2: Service.hent(long) overrides Fasade.hent(long), which bruk2 calls.
      `${P}.Bruker.bruk2|2|calls|typed|${P}.Fasade.hent`,
      `${P}.Bruker.bruk|1|calls|typed|${P}.Fasade.hent`,
      // The long overload calls the String one directly.
      `${P}.Service.hent|1|calls|local|null`,
      `${P}.Topp.topp|2|calls|typed|null`,
    ]);
    // The interface method itself is not in the blast radius, nor the sibling implementation.
    expect(r.affected.some((a) => a.qualified_name === `${P}.Fasade.hent` || a.qualified_name === `${P}.Annen.hent`)).toBe(false);
  });

  test("the impact trace carries edge kind and via", async () => {
    const tracer = new ImpactTracer();
    await analyzeImpactBySymbolId(await idOf(`${P}.Service.hent`, ["String"]), { maxDepth: 1, tracer });
    const top = tracer.toJSON().topResults.find((t) => t.qualifiedName === `${P}.Bruker.bruk`);
    expect([top?.edgeKind, top?.via]).toEqual(["calls", `${P}.Fasade.hent`]);
  });

  test("impact(Fasade.hent(String)) lists each implementation once as overrides, then the callers", async () => {
    const r = (await analyzeImpactBySymbolId(await idOf(`${P}.Fasade.hent`, ["String"]), { maxDepth: 2 }))!;
    const rows = r.affected.map((a) => `${a.qualified_name}:${a.depth}:${a.edge_kind}:${a.via}`).sort();
    expect(rows).toEqual([
      `${P}.Annen.hent:1:overrides:null`,
      `${P}.Begge.begge:1:calls:null`,
      `${P}.Bruker.bruk:1:calls:null`,
      `${P}.Service.hent:1:overrides:null`,
      // Service.hent(long) calls the String overload.
      `${P}.Service.hent:2:calls:null`,
      `${P}.Topp.topp:2:calls:null`,
    ]);
  });
});
