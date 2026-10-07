import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Names visible from a nested class: member types inherited from a supertype, and
 * methods of the lexically enclosing classes, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/enclosing-scope.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("member types inherited from a supertype", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/im/B.java": "package im;\n\npublic class B { public static class Inner { public static void x() {} } }\n",
      "src/main/java/im/A.java": "package im;\n\npublic class A extends B { void f() { Inner.x(); } }\n",
      "src/main/java/ib/Base.java": "package ib;\n\npublic class Base { public static class Builder { public void build() {} } }\n",
      "src/main/java/ib/Builder.java": "package ib;\n\npublic class Builder { public void build() {} }\n",
      "src/main/java/ib/Sub.java": "package ib;\n\npublic class Sub extends Base { void go(Builder b) { b.build(); } }\n",
      "src/main/kotlin/ik/I.kt": `package ik

interface I {
    object Helpers {
        fun h() = 1
    }
}

class C : I {
    fun g() { Helpers.h() }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test("a static call through a superclass's nested class", async () => {
    expect(await callsFrom(repo, "im.A.f")).toEqual(["im.B.Inner.x@static"]);
  });

  test("an inherited member type outranks a same-package top-level class of that name", async () => {
    expect(await callsFrom(repo, "ib.Sub.go")).toEqual(["ib.Base.Builder.build@typed"]);
  });

  test("Kotlin: an object nested in an implemented interface", async () => {
    expect(await callsFrom(repo, "ik.C.g")).toEqual(["ik.I.Helpers.h@static"]);
  });
});

describe.skipIf(!RUN)("receiverless calls reach lexically enclosing classes", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/en/Outer.java": `package en;

public class Outer {
    void outerM() {}
    class Inner {
        void m() { outerM(); }
    }
}
`,
      "src/main/java/en/J.java": `package en;

public class J {
    static void util() {}
    static class SN {
        void m() { util(); }
    }
}
`,
      "src/main/kotlin/ek/K.kt": `package ek

class K {
    fun inst() = 1
    inner class In {
        fun m() { inst() }
    }
}
`,
      "src/main/java/en/Shadow.java": `package en;

public class Shadow {
    void s() {}
    class Inner extends Shadowed {
        void m() { s(); }
    }
}

class Shadowed {
    void s() {}
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test("a Java inner class calls an outer instance method", async () => {
    expect(await callsFrom(repo, "en.Outer.Inner.m")).toEqual(["en.Outer.outerM@local"]);
  });

  test("a Java static nested class calls an outer static method", async () => {
    expect(await callsFrom(repo, "en.J.SN.m")).toEqual(["en.J.util@local"]);
  });

  test("a Kotlin inner class calls an outer function", async () => {
    expect(await callsFrom(repo, "ek.K.In.m")).toEqual(["ek.K.inst@local"]);
  });

  test("the own class's hierarchy wins over the enclosing class", async () => {
    expect(await callsFrom(repo, "en.Shadow.Inner.m")).toEqual(["en.Shadowed.s@local"]);
  });
});
