import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Overload narrowing where the stored types cannot prove javac's pick: varargs against a
 * parameter of unknown type, chain receivers of unrelated classes, and interfaces with
 * several supertypes.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/overload-regressions.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.or";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}`).sort();
}

describe.skipIf(!RUN)("overload narrowing regressions", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/no/nav/or/A.java": `package ${P};

public class A {}
`,
      "src/main/java/no/nav/or/Va.java": `package ${P};

public class Va {
    public void v(int[] xs) {}
    public void v(Object... xs) {}
    public <T extends A> void g(T t) {}
    public void g(Object... xs) {}
    public <T> void u(T t) {}
    public void u(Object... xs) {}
}
`,
      "src/main/java/no/nav/or/Box.java": `package ${P};

public class Box<T> {
    public void put(T t) {}
    public void put(Object... xs) {}
}
`,
      "src/main/java/no/nav/or/VaBruk.java": `package ${P};

public class VaBruk {
    private Va va;
    private Box<A> box;
    void v() { va.v("s"); }
    void g() { va.g("s"); }
    void u() { va.u("s"); }
    void put() { box.put("s"); }
}
`,
      "src/main/java/no/nav/or/Foo.java": `package ${P};

public class Foo {
    public void m(Object o) {}
}
`,
      "src/main/java/no/nav/or/Bar.java": `package ${P};

public class Bar {
    public void m(String s) {}
}
`,
      "src/main/java/no/nav/or/Lag.java": `package ${P};

public class Lag {
    public Foo x(long id) { return null; }
    public Bar x(String id) { return null; }
}
`,
      "src/main/java/no/nav/or/LagBruk.java": `package ${P};

public class LagBruk {
    private Lag lag;
    Object ukjent() { return null; }
    void bruk() { lag.x(ukjent()).m("s"); }
}
`,
      "src/main/kotlin/no/nav/or/Arv.kt": `package ${P}

open class KA {
    fun c(): String {
        return ""
    }
}

class KB : KA()

class R {
    fun lag(x: Long): KA {
        return KA()
    }

    fun lag(x: String): KB {
        return KB()
    }
}

class RBruk(private val r: R) {
    fun hent(): Any = 1

    fun bruk() {
        r.lag(hent()).c()
    }
}
`,
      "src/main/kotlin/no/nav/or/ArvOver.kt": `package ${P}

open class OA {
    open fun c(): String {
        return ""
    }
}

class OB : OA() {
    override fun c(): String {
        return "b"
    }
}

class OR {
    fun lag(x: Long): OA {
        return OA()
    }

    fun lag(x: String): OB {
        return OB()
    }
}

class ORBruk(private val r: OR) {
    fun hent(): Any = 1

    fun bruk() {
        r.lag(hent()).c()
    }
}
`,
      "src/main/java/no/nav/or/Multi.java": `package ${P};

import java.util.Collection;
import java.util.List;

public class Multi {
    interface RepoI extends Iterable<String>, List<String> {}
    void m(Iterable<String> i) {}
    void m(Collection<String> c) {}
    void bruk(RepoI r) { m(r); }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("an array parameter of unknown type does not make varargs drop out", async () => {
    expect(await callsFrom(repo, `${P}.VaBruk.v`)).toEqual([`${P}.Va.v:4`, `${P}.Va.v:5`]);
  });

  test("a bounded type parameter the argument does not fit leaves the vararg", async () => {
    expect(await callsFrom(repo, `${P}.VaBruk.g`)).toEqual([`${P}.Va.g:7`]);
  });

  test("an unbounded method type parameter applies in phase 1 and hides the vararg", async () => {
    expect(await callsFrom(repo, `${P}.VaBruk.u`)).toEqual([`${P}.Va.u:8`]);
  });

  test("a class type parameter, bound by the receiver's type, does not make varargs drop out", async () => {
    expect(await callsFrom(repo, `${P}.VaBruk.put`)).toEqual([`${P}.Box.put:4`, `${P}.Box.put:5`]);
  });

  test("chain receivers of unrelated classes narrow separately", async () => {
    expect(await callsFrom(repo, `${P}.LagBruk.bruk`)).toEqual([
      `${P}.Bar.m:4`, `${P}.Foo.m:4`, `${P}.Lag.x:4`, `${P}.Lag.x:5`, `${P}.LagBruk.ukjent:5`,
    ]);
  });

  test("a chain receiver class and its subclass both keep the inherited method", async () => {
    expect(await callsFrom(repo, `${P}.RBruk.bruk`)).toEqual([`${P}.KA.c:4`, `${P}.R.lag:12`, `${P}.R.lag:16`, `${P}.RBruk.hent:22`]);
  });

  test("an override on one chain receiver class does not hide the other class's method", async () => {
    expect(await callsFrom(repo, `${P}.ORBruk.bruk`)).toEqual([`${P}.OA.c:4`, `${P}.OB.c:10`, `${P}.OR.lag:16`, `${P}.OR.lag:20`, `${P}.ORBruk.hent:26`]);
  });

  test("a Java interface's extended interfaces are not a superclass chain", async () => {
    expect(await callsFrom(repo, `${P}.Multi.bruk`)).toEqual([`${P}.Multi.m:8`, `${P}.Multi.m:9`]);
  });
});
