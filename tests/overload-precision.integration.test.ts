import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

/**
 * Which overload a call reaches: argument-type and parameter-name narrowing, private
 * visibility, overloads inherited from a supertype, extension receivers and Kotlin scope
 * functions, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/overload-precision.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

/** `target:targetLine@resolution` for every calls edge out of `source`, sorted. */
async function targetsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}:${e.targetLine}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("argument types narrow same-arity overloads", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/ov/Behandling.java": "package ov;\n\npublic class Behandling extends BaseEntity {}\n",
      "src/main/java/ov/BaseEntity.java": "package ov;\n\npublic class BaseEntity {}\n",
      "src/main/java/ov/BehandlingService.java": `package ov;

public class BehandlingService {
    public void endreStatus(long behandlingID, String status) {}
    public void endreStatus(Behandling behandling, String status) {}
    public void lagre(BaseEntity e) {}
    public void lagre(String s) {}
    public void reg(Caller c) {}
    public void reg(String s) {}
}
`,
      "src/main/java/ov/Caller.java": `package ov;

public class Caller {
    private BehandlingService svc;
    void viaLong(long behandlingID) { svc.endreStatus(behandlingID, "x"); }
    void viaBoxed(Long id) { svc.endreStatus(id, "x"); }
    void viaLiteral() { svc.endreStatus(1L, "x"); }
    void viaObject(Behandling b) { svc.endreStatus(b, "x"); }
    void viaNew() { svc.endreStatus(new Behandling(), "x"); }
    void viaNull() { svc.endreStatus(null, "x"); }
    void viaUnknown(Object o) { svc.endreStatus(o.hashCode(), o.toString()); }
    void viaPartlyKnown(Object o) { svc.endreStatus(1L, o.toString()); }
    void viaSubtype(Behandling b) { svc.lagre(b); }
    void viaThis() { svc.reg(this); }
}
`,
      "src/main/java/ov/TekniskException.java": "package ov;\n\npublic class TekniskException extends RuntimeException {}\n",
      "src/main/java/ov/Mapper.java": `package ov;

import org.springframework.web.reactive.function.client.WebClientResponseException;

public class Mapper {
    public void h(TekniskException e) {}
    public void h(WebClientResponseException e) {}
    void c() { TekniskException t = new TekniskException(); h(t); }
}
`,
      "src/main/kotlin/kov/Mottaker.kt": `package kov

class Periode

class Mottaker {
    fun get(behandlingID: Long): Int = 1
    fun get(perioder: List<Periode>): Int = 2
    fun f(s: String) = 1
    fun f(i: Int) = 2
    fun h(navn: String) = 1
    fun h(alder: Int) = 2
    fun k(x: Int) = 1
    fun k(x: Int, y: Int) = 2
    fun u(l: List<Periode>) = 1
    fun u(s: String) = 2
}
`,
      "src/main/kotlin/kov/KCaller.kt": `package kov

class KCaller(private val m: Mottaker) {
    private val ident = "12345678901"
    fun viaLong(id: Long) { m.get(id) }
    fun viaList(xs: List<Periode>) { m.get(xs) }
    fun viaString() { m.f("a") }
    fun viaInt() { m.f(1) }
    fun viaMismatch(x: Long) { m.f(x) }
    fun viaNamed(o: Any) { m.h(navn = o.toString()) }
    fun viaNamedCount() { m.k(x = 1, y = 2) }
    fun viaUnknown(o: Any) { m.h(o.toString()) }
    fun viaExternalSubtype(al: ArrayList<Periode>) { m.u(al) }
    fun viaCtor() { m.get(Periode()) }
    fun viaLiteralProperty() { m.f(ident) }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  const ENDRE_LONG = "ov.BehandlingService.endreStatus:4@typed";
  const ENDRE_OBJ = "ov.BehandlingService.endreStatus:5@typed";

  test.each([
    ["ov.Caller.viaLong", "a long parameter"],
    ["ov.Caller.viaBoxed", "a Long parameter (boxed twin)"],
    ["ov.Caller.viaLiteral", "a long literal"],
  ])("Java %s (%s) → endreStatus(long, …) only", async (source) => {
    expect(await targetsFrom(repo, source)).toEqual([ENDRE_LONG]);
  });

  test("Java: an object argument and a constructor call pick endreStatus(Behandling, …)", async () => {
    expect(await targetsFrom(repo, "ov.Caller.viaObject")).toEqual([ENDRE_OBJ]);
    expect(await targetsFrom(repo, "ov.Caller.viaNew")).toEqual([ENDRE_OBJ]);
  });

  test("Java: null is a wildcard, and unknown arguments keep every arity-compatible overload", async () => {
    expect(await targetsFrom(repo, "ov.Caller.viaNull")).toEqual([ENDRE_LONG, ENDRE_OBJ]);
    expect((await targetsFrom(repo, "ov.Caller.viaUnknown")).filter((t) => t.includes("endreStatus"))).toEqual([
      ENDRE_LONG,
      ENDRE_OBJ,
    ]);
  });

  test("Java: an unknown argument fits any parameter while a known one narrows", async () => {
    expect((await targetsFrom(repo, "ov.Caller.viaPartlyKnown")).filter((t) => t.includes("endreStatus"))).toEqual([ENDRE_LONG]);
  });

  test("Java: a subclass argument reaches the supertype parameter, not String", async () => {
    expect(await targetsFrom(repo, "ov.Caller.viaSubtype")).toEqual(["ov.BehandlingService.lagre:6@typed"]);
  });

  test("Java: `this` is typed as the enclosing class", async () => {
    expect(await targetsFrom(repo, "ov.Caller.viaThis")).toEqual(["ov.BehandlingService.reg:8@typed"]);
  });

  test("Kotlin: a Long identifier and a List identifier each pick their overload", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaLong")).toEqual(["kov.Mottaker.get:6@typed"]);
    expect(await targetsFrom(repo, "kov.KCaller.viaList")).toEqual(["kov.Mottaker.get:7@typed"]);
  });

  test("Kotlin: a string literal picks (String), an integer literal (Int)", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaString")).toEqual(["kov.Mottaker.f:8@typed"]);
    expect(await targetsFrom(repo, "kov.KCaller.viaInt")).toEqual(["kov.Mottaker.f:9@typed"]);
  });

  test("Kotlin: when no overload fits the known types, every arity-compatible one keeps its edge", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaMismatch")).toEqual([
      "kov.Mottaker.f:8@typed",
      "kov.Mottaker.f:9@typed",
    ]);
  });

  test("Kotlin: a named argument picks the overload with that parameter name", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaNamed")).toEqual(["kov.Mottaker.h:10@typed"]);
  });

  test("Kotlin: named arguments count toward the arity", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaNamedCount")).toEqual(["kov.Mottaker.k:13@typed"]);
  });

  test("Kotlin: an unknown argument keeps both same-arity overloads", async () => {
    expect((await targetsFrom(repo, "kov.KCaller.viaUnknown")).filter((t) => t.includes(".h:"))).toEqual([
      "kov.Mottaker.h:10@typed",
      "kov.Mottaker.h:11@typed",
    ]);
  });

  test("Kotlin: an external class argument is not a String", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaExternalSubtype")).toEqual(["kov.Mottaker.u:14@typed"]);
  });

  test("Java: an overload whose parameter certainly fits beats one that only may (external class)", async () => {
    expect(await targetsFrom(repo, "ov.Mapper.c")).toEqual(["ov.Mapper.h:6@local"]);
  });

  test("Kotlin: a property initialized with a string literal is a String", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaLiteralProperty")).toEqual(["kov.Mottaker.f:8@typed"]);
  });

  test("Kotlin: a constructor-call argument is typed by its class", async () => {
    expect(await targetsFrom(repo, "kov.KCaller.viaCtor")).toEqual(["kov.Mottaker.get:7@typed"]);
  });
});

describe.skipIf(!RUN)("private targets are reachable from their own top-level class only", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/pv/Svc.java": `package pv;

public class Svc {
    @Deprecated
    private void avslutt(Object b) {}
    public void avslutt(long id) {}
    void self(Object o) { avslutt(o.hashCode()); }
    static class Nested {
        void m(Svc s, Object o) { s.avslutt(o.hashCode()); }
    }
}

class Neighbour {
    void m(Svc s, Object o) { s.avslutt(o.hashCode()); }
}
`,
      "src/main/java/pv/Other.java": `package pv;

public class Other {
    void c(Svc s, Object o) { s.avslutt(o.hashCode()); }
}
`,
      "src/main/kotlin/pk/Top.kt": `package pk

private fun hjelp(a: Int) = a

class SameFile {
    fun c() { hjelp(1) }
}
`,
      "src/main/kotlin/pk/Elsewhere.kt": `package pk

class Elsewhere {
    fun c() { hjelp(1) }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  const avslutt = (t: string[]) => t.filter((x) => x.includes("avslutt"));

  test("another file reaches the public overload only, even with an annotation before `private`", async () => {
    expect(avslutt(await targetsFrom(repo, "pv.Other.c"))).toEqual(["pv.Svc.avslutt:6@typed"]);
  });

  test("another top-level class in the same file does not reach the private overload", async () => {
    expect(avslutt(await targetsFrom(repo, "pv.Neighbour.m"))).toEqual(["pv.Svc.avslutt:6@typed"]);
  });

  test("the class itself and its nested class reach both overloads", async () => {
    expect(avslutt(await targetsFrom(repo, "pv.Svc.self"))).toEqual(["pv.Svc.avslutt:4@local", "pv.Svc.avslutt:6@local"]);
    expect(avslutt(await targetsFrom(repo, "pv.Svc.Nested.m"))).toEqual(["pv.Svc.avslutt:4@typed", "pv.Svc.avslutt:6@typed"]);
  });

  test("a Kotlin top-level private function is reachable from its own file only", async () => {
    expect(await targetsFrom(repo, "pk.SameFile.c")).toEqual(["pk.hjelp:3@local"]);
    expect(await targetsFrom(repo, "pk.Elsewhere.c")).toEqual([]);
  });
});

describe.skipIf(!RUN)("overloads across the class hierarchy", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/hi/Base.java": `package hi;

public class Base {
    public void f(int a) {}
    public void g() {}
}
`,
      "src/main/java/hi/Sub.java": `package hi;

public class Sub extends Base {
    public void f(String s) {}
    public void g() {}
}
`,
      "src/main/java/hi/U.java": `package hi;

public class U {
    void literal(Sub s) { s.f(1); }
    void unknown(Sub s, Object o) { s.f(o.hashCode()); }
    void overridden(Sub s) { s.g(); }
}
`,
      "src/main/kotlin/hk/K.kt": `package hk

open class KB {
    fun v(vararg a: Int) = 1
}

class KS : KB() {
    fun v(a: String) = 2
}

class KU {
    fun spread(s: KS, arr: IntArray) { s.v(*arr) }
}
`,
      "src/main/java/dm/A.java": "package dm;\n\npublic interface A { default void m() {} }\n",
      "src/main/java/dm/B.java": "package dm;\n\npublic interface B extends A { default void m() {} }\n",
      "src/main/java/dm/C.java": "package dm;\n\npublic class C implements A, B { void c() { m(); } }\n",
    });
  });
  afterAll(async () => repo?.cleanup());

  test("an integer literal reaches the base class f(int) past the subclass's f(String)", async () => {
    expect(await targetsFrom(repo, "hi.U.literal")).toEqual(["hi.Base.f:4@typed"]);
  });

  test("an unknown argument reaches the overloads of both classes", async () => {
    expect((await targetsFrom(repo, "hi.U.unknown")).filter((t) => t.includes(".f:"))).toEqual([
      "hi.Base.f:4@typed",
      "hi.Sub.f:4@typed",
    ]);
  });

  test("an override hides the overridden method", async () => {
    expect(await targetsFrom(repo, "hi.U.overridden")).toEqual(["hi.Sub.g:5@typed"]);
  });

  test("a spread argument (no count) reaches the overloads of every class in the hierarchy", async () => {
    expect(await targetsFrom(repo, "hk.KU.spread")).toEqual(["hk.KB.v:4@typed", "hk.KS.v:8@typed"]);
  });

  test("two paths to an interface: the override on the nearer path hides it", async () => {
    expect(await targetsFrom(repo, "dm.C.c")).toEqual(["dm.B.m:3@local"]);
  });
});

describe.skipIf(!RUN)("extension functions need their receiver", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/ex/Periode.kt": `package ex

open class Medlemskapsperiode

class Builder {
    fun trygdeavgiftsperiode(init: () -> Unit) {}
}

fun build(b: Builder.() -> Unit) {}
`,
      "src/main/kotlin/ex/Ext.kt": `package ex

fun Medlemskapsperiode.trygdeavgiftsperiode(init: () -> Unit) {}

fun Medlemskapsperiode.annen() { trygdeavgiftsperiode { } }
`,
      "src/main/kotlin/ex/Users.kt": `package ex

class TestBase {
    fun lag() { build { trygdeavgiftsperiode { } } }
}

class SubPeriode : Medlemskapsperiode() {
    fun m() { trygdeavgiftsperiode { } }
}

class Typed(private val p: Medlemskapsperiode) {
    fun t() { p.trygdeavgiftsperiode { } }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  const EXT = "ex.trygdeavgiftsperiode:3";

  test("a receiverless call from an unrelated class does not reach the extension", async () => {
    expect((await targetsFrom(repo, "ex.TestBase.lag")).filter((t) => t.startsWith(EXT))).toEqual([]);
  });

  test("an extension on the receiver type and a subclass member reach it", async () => {
    expect(await targetsFrom(repo, "ex.annen")).toEqual([`${EXT}@local`]);
    expect(await targetsFrom(repo, "ex.SubPeriode.m")).toEqual([`${EXT}@local`]);
  });

  test("a typed receiver reaches an extension on its type", async () => {
    expect(await targetsFrom(repo, "ex.Typed.t")).toEqual([`${EXT}@typed`]);
  });
});

describe.skipIf(!RUN)("Kotlin scope functions change the receiver of their lambda", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/sf/K.kt": `package sf

class Other {
    fun bar() = 1
}

class K(private val o: Other) {
    fun bar() = 2
    fun baz() = 3
    fun viaWith() { with(o) { bar() } }
    fun viaApply() { o.apply { bar() } }
    fun viaRun() { o.run { bar() } }
    fun viaLet() { o.let { bar() } }
    fun fallback() { o.apply { baz() } }
    fun viaCtor() { Other().apply { bar() } }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test.each([["sf.K.viaWith"], ["sf.K.viaApply"], ["sf.K.viaRun"], ["sf.K.viaCtor"]])(
    "%s → Other.bar",
    async (source) => {
      expect((await targetsFrom(repo, source)).filter((t) => t.includes(".bar:"))).toEqual(["sf.Other.bar:4@typed"]);
    },
  );

  test("let keeps the own class (its lambda takes `it`)", async () => {
    expect((await targetsFrom(repo, "sf.K.viaLet")).filter((t) => t.includes(".bar:"))).toEqual(["sf.K.bar:8@local"]);
  });

  test("a method the receiver lacks falls back to the own class", async () => {
    expect((await targetsFrom(repo, "sf.K.fallback")).filter((t) => t.includes(".baz:"))).toEqual(["sf.K.baz:9@local"]);
  });
});
