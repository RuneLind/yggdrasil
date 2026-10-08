import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpactBySymbolId } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Which callers dispatch hands to an implementation, and which methods get `overrides`
 * edges, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/dispatch-precision.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.dp";

async function idAt(repo: FixtureRepo, qn: string, line: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT s.id FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
    WHERE r.name = ${repo.name} AND s.qualified_name = ${qn} AND s.start_line = ${line}`;
  if (rows.length !== 1) throw new Error(`${qn}:${line} matched ${rows.length} symbols`);
  return rows[0].id;
}

/** `qualified_name|depth|edge_kind|via` per impact entry, sorted. */
async function impactRows(repo: FixtureRepo, qn: string, line: number, depth: number): Promise<string[]> {
  const r = (await analyzeImpactBySymbolId(await idAt(repo, qn, line), { maxDepth: depth }))!;
  return r.affected.map((a) => `${a.qualified_name}|${a.depth}|${a.edge_kind}|${a.via}`).sort();
}

async function overridesFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "overrides")).map((e) => `${e.sourceLine}->${e.target}:${e.targetLine}`).sort();
}

describe.skipIf(!RUN)("dispatch in impact", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/dp/Base.kt": `package ${P}

open class Base {
    open fun bar(x: String): String {
        return x
    }
}

class FooImpl : Base() {
    override fun bar(x: String): String {
        return super.bar(x) + "f"
    }
}

class OtherImpl : Base() {
    override fun bar(x: String): String {
        return super.bar(x) + "o"
    }
}

class PlainImpl : Base()

class Caller(private val base: Base, private val plain: PlainImpl) {
    fun kall(): String {
        return base.bar("a")
    }

    fun kallPlain(): String {
        return plain.bar("p")
    }

    fun begge(): String {
        return plain.bar("1") + base.bar("2")
    }

    fun begge2(): String {
        return base.bar("2") + plain.bar("1")
    }
}

class Ring {
    fun ping(n: Int): Int {
        return pong(n)
    }

    fun pong(n: Int): Int {
        return ping(n)
    }
}
`,
      "src/main/kotlin/no/nav/dp/Maker.kt": `package ${P}

interface Maker {
    fun make(x: String): String
}

class Caching(private val inner: Maker) : Maker {
    override fun make(x: String): String {
        return inner.make(x)
    }
}

class Plain : Maker {
    override fun make(x: String): String {
        return x
    }
}
`,
      // AbstraktSted is no IkkeFysisk, but its subclass Maritimt is and inherits landkode.
      "src/main/kotlin/no/nav/dp/Sted.kt": `package ${P}

interface Arbeidssted {
    fun landkode(): String
}

interface IkkeFysisk : Arbeidssted

abstract class AbstraktSted : Arbeidssted {
    override fun landkode(): String {
        return "NO"
    }
}

class Maritimt : AbstraktSted(), IkkeFysisk

class Fysisk : Arbeidssted {
    override fun landkode(): String {
        return "SE"
    }
}

class BrukSted(private val s: IkkeFysisk) {
    fun kall(): String {
        return s.landkode()
    }
}
`,
      "src/main/kotlin/no/nav/dp/Mal.kt": `package ${P}

open class Mal {
    open fun steg(): String {
        return ""
    }

    fun kjør(): String {
        return steg()
    }
}

class MalA : Mal() {
    override fun steg(): String {
        return "a"
    }
}
`,
      // One caller reaches To.m through two interfaces at the same depth.
      "src/main/kotlin/no/nav/dp/To.kt": `package ${P}

interface Zeta {
    fun m(): String
}

interface Alfa {
    fun m(): String
}

class To : Zeta, Alfa {
    override fun m(): String {
        return ""
    }
}

class ToBruk(private val z: Zeta, private val a: Alfa) {
    fun begge(): String {
        return z.m() + a.m()
    }
}
`,
      // Deco overrides Impl.hent and calls the interface on a field.
      "src/main/java/no/nav/dp/Fas.java": `package ${P};

public interface Fas {
    String hent(String s);
}
`,
      "src/main/java/no/nav/dp/Impl.java": `package ${P};

public class Impl implements Fas {
    public String hent(String s) {
        return s;
    }
}
`,
      "src/main/java/no/nav/dp/Deco.java": `package ${P};

public class Deco extends Impl {
    private Fas inner;

    @Override
    public String hent(String s) {
        return inner.hent(s);
    }
}
`,
      // begge reaches Service.hent directly (typed) and through the receiverless Fasade
      // call in its abstract base (local).
      "src/main/kotlin/no/nav/dp/Fasade.kt": `package ${P}

interface Fasade {
    fun hent(s: String): String
}

abstract class AbstraktService : Fasade {
    fun begge(s: Service): String {
        return hent("y") + s.hent("x")
    }
}

class Service : AbstraktService() {
    override fun hent(s: String): String {
        return s
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a super call is not a dispatched caller, and the seed is never in its own impact", async () => {
    expect(await impactRows(repo, `${P}.FooImpl.bar`, 10, 2)).toEqual([
      `${P}.Caller.begge2|1|calls|${P}.Base.bar`,
      `${P}.Caller.begge|1|calls|${P}.Base.bar`,
      `${P}.Caller.kall|1|calls|${P}.Base.bar`,
    ]);
  });

  test("the seed is not listed when a cycle reaches it", async () => {
    expect(await impactRows(repo, `${P}.Ring.ping`, 42, 3)).toEqual([`${P}.Ring.pong|1|calls|null`]);
  });

  test("a decorator calling the interface is not in its own impact, but is in a sibling's", async () => {
    expect(await impactRows(repo, `${P}.Caching.make`, 8, 2)).toEqual([]);
    expect(await impactRows(repo, `${P}.Plain.make`, 14, 2)).toEqual([`${P}.Caching.make|1|calls|${P}.Maker.make`]);
  });

  test("a call on a receiver the seed's class is no subtype of does not dispatch to it", async () => {
    // plain.bar() resolves to Base.bar on a PlainImpl, which FooImpl is not. begge also
    // calls base.bar() on the same line, so it stays.
    const rows = await impactRows(repo, `${P}.FooImpl.bar`, 10, 1);
    expect(rows.some((r) => r.startsWith(`${P}.Caller.kallPlain|`))).toBe(false);
    expect(rows.some((r) => r.startsWith(`${P}.Caller.begge|`))).toBe(true);
    expect(rows.some((r) => r.startsWith(`${P}.Caller.begge2|`))).toBe(true);
    // Fysisk is no IkkeFysisk.
    expect(await impactRows(repo, `${P}.Fysisk.landkode`, 18, 1)).toEqual([]);
  });

  test("a class that inherits the method through a subtype of the receiver keeps the caller", async () => {
    expect(await impactRows(repo, `${P}.AbstraktSted.landkode`, 10, 1)).toEqual([`${P}.BrukSted.kall|1|calls|${P}.Arbeidssted.landkode`]);
  });

  test("a receiverless call in the base class dispatches to the subclass override", async () => {
    expect(await impactRows(repo, `${P}.MalA.steg`, 14, 1)).toEqual([`${P}.Mal.kjør|1|calls|${P}.Mal.steg`]);
  });

  test("two ancestors at the same depth: via is the first by qualified name", async () => {
    expect(await impactRows(repo, `${P}.To.m`, 12, 1)).toEqual([`${P}.ToBruk.begge|1|calls|${P}.Alfa.m`]);
  });

  test("a dispatched call beats an overrides edge at the same depth", async () => {
    expect(await impactRows(repo, `${P}.Impl.hent`, 4, 1)).toEqual([`${P}.Deco.hent|1|calls|${P}.Fas.hent`]);
  });

  test("a direct call beats a dispatched one at the same depth, whatever the resolution", async () => {
    expect(await impactRows(repo, `${P}.Service.hent`, 14, 1)).toEqual([`${P}.AbstraktService.begge|1|calls|null`]);
  });

  test("overrides entries score like implements; dispatched callers like direct ones", async () => {
    const seed = await idAt(repo, `${P}.Fas.hent`, 4);
    const r = (await analyzeImpactBySymbolId(seed, { maxDepth: 1 }))!;
    expect(r.affected.find((a) => a.qualified_name === `${P}.Impl.hent`)?.confidence).toBeCloseTo(0.9, 10);
    const d = (await analyzeImpactBySymbolId(await idAt(repo, `${P}.Plain.make`, 14), { maxDepth: 1 }))!;
    expect(d.affected[0].confidence).toBeCloseTo(0.7, 10);
  });
});

describe.skipIf(!RUN)("overrides edge construction", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/no/nav/dp/Foo.java": `package ${P};

public class Foo {}
`,
      "src/main/java/no/nav/dp/Bar.java": `package ${P};

public class Bar {}
`,
      "src/main/java/no/nav/dp/Repo.java": `package ${P};

public interface Repo<T> {
    void save(T t);
}
`,
      "src/main/java/no/nav/dp/FooRepo.java": `package ${P};

public class FooRepo implements Repo<Foo> {
    public void save(Foo f) {}
    public void save(String s) {}
}
`,
      // Substitution through an intermediate class's type parameter.
      "src/main/java/no/nav/dp/AbstractRepo.java": `package ${P};

public abstract class AbstractRepo<E> implements Repo<E> {}
`,
      "src/main/java/no/nav/dp/BarRepo.java": `package ${P};

public class BarRepo extends AbstractRepo<Bar> {
    public void save(Bar b) {}
    public void save(String s) {}
}
`,
      // Unknown substitution: the known second position still rules one out.
      "src/main/java/no/nav/dp/Put.java": `package ${P};

public interface Put<T> {
    void put(T t, String k);
}
`,
      "src/main/java/no/nav/dp/GenPut.java": `package ${P};

public class GenPut<X> implements Put<X> {
    public void put(X x, String k) {}
    public void put(X x, Integer k) {}
}
`,
      "src/main/kotlin/no/nav/dp/Lager.kt": `package ${P}

interface Lager {
    fun lag(): String
}

class Outer : Lager {
    override fun lag(): String {
        return ""
    }

    companion object {
        fun lag(): String {
            return "c"
        }
    }

    fun lokal(): String {
        fun lag(): String {
            return "l"
        }
        return lag()
    }

    fun anonym(): Lager {
        return object : Lager {
            override fun lag(): String {
                return "o"
            }
        }
    }

    val felt = object : Lager {
        override fun lag(): String {
            return "f"
        }
    }
}
`,
      "src/main/java/no/nav/dp/JOuter.java": `package ${P};

public class JOuter implements Lager {
    public String lag() {
        return "";
    }

    Lager anonym() {
        return new Lager() {
            public String lag() {
                return "a";
            }
        };
    }

    private Lager felt = new Lager() {
        public String lag() {
            return "f";
        }
    };
}
`,
      "src/main/kotlin/no/nav/dp/Ext.kt": `package ${P}

interface Ext {
    fun ext(): String
    fun Int.ext2(): String
}

class ExtImpl : Ext {
    override fun ext(): String {
        return ""
    }

    fun Int.ext(): String {
        return ""
    }

    override fun Int.ext2(): String {
        return ""
    }

    fun ext2(): String {
        return ""
    }
}
`,
      "src/main/java/no/nav/dp/JTar.java": `package ${P};

import java.util.List;

public interface JTar {
    void ta(Object o);
    void liste(List<String> l);
}
`,
      "src/main/kotlin/no/nav/dp/KTar.kt": `package ${P}

class KTar : JTar {
    override fun ta(o: Any) {
    }

    override fun liste(l: MutableList<String>) {
    }
}
`,
      "src/main/kotlin/no/nav/dp/Kjor.kt": `package ${P}

interface Kjor {
    fun run(cb: (String) -> Unit, n: Int = 0)
}

class KjorImpl : Kjor {
    override fun run(cb: (String) -> Unit, n: Int) {
    }

    fun run(cb: (String) -> Unit, n: Int, ekstra: String) {
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a generic ancestor parameter takes the clause's type argument", async () => {
    expect(await overridesFrom(repo, `${P}.FooRepo.save`)).toEqual([`4->${P}.Repo.save:4`]);
  });

  test("the substitution composes through an intermediate class's type parameter", async () => {
    expect(await overridesFrom(repo, `${P}.BarRepo.save`)).toEqual([`4->${P}.Repo.save:4`]);
  });

  test("with the substitution unknown, a certainly incompatible known position rules a method out", async () => {
    expect(await overridesFrom(repo, `${P}.GenPut.put`)).toEqual([`4->${P}.Put.put:4`]);
  });

  test("companion, local and object-literal functions never override the outer class's interface", async () => {
    expect(await overridesFrom(repo, `${P}.Outer.lag`)).toEqual([`8->${P}.Lager.lag:4`]);
  });

  test("Java anonymous-class methods never override the outer class's interface", async () => {
    expect(await overridesFrom(repo, `${P}.JOuter.lag`)).toEqual([`4->${P}.Lager.lag:4`]);
  });

  test("the extension receiver is part of the signature", async () => {
    expect(await overridesFrom(repo, `${P}.ExtImpl.ext`)).toEqual([`9->${P}.Ext.ext:4`]);
    expect(await overridesFrom(repo, `${P}.ExtImpl.ext2`)).toEqual([`17->${P}.Ext.ext2:5`]);
  });

  test("Kotlin Any and MutableList override Java Object and List", async () => {
    expect(await overridesFrom(repo, `${P}.KTar.ta`)).toEqual([`4->${P}.JTar.ta:6`]);
    expect(await overridesFrom(repo, `${P}.KTar.liste`)).toEqual([`7->${P}.JTar.liste:7`]);
  });

  test("an override matches an ancestor with a default parameter by parameter count", async () => {
    expect(await overridesFrom(repo, `${P}.KjorImpl.run`)).toEqual([`8->${P}.Kjor.run:4`]);
  });
});
