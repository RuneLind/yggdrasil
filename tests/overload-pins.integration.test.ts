import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Overload rules that only show through the rebuild: the call site's language, the
 * vararg flag, and override removal scoped to one lookup group.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/overload-pins.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const P = "no.nav.o";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}`).sort();
}

describe.skipIf(!RUN)("overload rules in the rebuild", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/no/nav/o/Tall.kt": `package ${P}

class Tall {
    fun g(x: Double) {}
    fun g(x: Long) {}
}

class KBruk(private val t: Tall) {
    fun bruk() = t.g(1)
}
`,
      "src/main/java/no/nav/o/JBruk.java": `package ${P};

public class JBruk {
    private Tall t;
    private Va v;
    void bruk() { t.g(1); }
    void va() { v.h("s"); }
}
`,
      "src/main/java/no/nav/o/Va.java": `package ${P};

public class Va {
    public void h(Object... xs) {}
    public void h(String s) {}
}
`,
      "src/main/java/no/nav/o/Ser.java": `package ${P};

import java.io.Serializable;

public class Ser {
    static class Beh implements Serializable {}
    interface RepoI extends Serializable {}
    static class Beh2 implements RepoI {}
    void s(Serializable x) {}
    void s(Throwable x) {}
    void c(Beh b) { s(b); }
    void c2(Beh2 b) { s(b); }
}
`,
      "src/main/kotlin/no/nav/o/Outer.kt": `package ${P}

open class Base {
    open fun foo(x: Int) {}
}

class Outer : Base() {
    inner class Inner : Base() {
        fun <T> foo(y: T) {}
        fun bruk() = foo(x = 1)
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the call site's language decides integer literal applicability", async () => {
    // Kotlin: 1 never fits Double. Java: 1 widens to double or long, unless the folded
    // parameter is the boxed type, so both stay.
    expect(await callsFrom(repo, `${P}.KBruk.bruk`)).toEqual([`${P}.Tall.g:5`]);
    expect(await callsFrom(repo, `${P}.JBruk.bruk`)).toEqual([`${P}.Tall.g:4`, `${P}.Tall.g:5`]);
  });

  test("a Java vararg overload drops out when a fixed-arity one applies", async () => {
    expect(await callsFrom(repo, `${P}.JBruk.va`)).toEqual([`${P}.Va.h:5`]);
  });

  test("an implemented external interface does not hide a possible class parameter", async () => {
    // An over-approximation: Beh's class chain is all in the repo, so it is no Throwable
    // and javac picks s(Serializable); an implemented external interface still never
    // hides a possible class parameter.
    expect(await callsFrom(repo, `${P}.Ser.c`)).toEqual([`${P}.Ser.s:10`, `${P}.Ser.s:9`]);
    // Through a repo interface that extends it: still not on the class chain.
    expect(await callsFrom(repo, `${P}.Ser.c2`)).toEqual([`${P}.Ser.s:10`, `${P}.Ser.s:9`]);
  });

  test("override removal stays inside one lookup group", async () => {
    // Group 1 (Inner) has only foo(y: T), which `x = 1` rules out; group 2 (Outer) still
    // holds Base.foo(x: Int), though Inner.foo hides it inside group 1.
    expect(await callsFrom(repo, `${P}.Outer.Inner.bruk`)).toEqual([`${P}.Base.foo:4`]);
  });
});
