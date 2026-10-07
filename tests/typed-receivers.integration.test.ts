import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpact } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";
import { ImpactTracer } from "../src/tracing/trace.ts";

/**
 * Typed receivers, type → class lookup through imports, method lookup up the class
 * hierarchy, and arity-ranged overloads, through the real indexer.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/typed-receivers.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

/** `target@resolution` for every calls edge out of `source`, sorted. */
async function callsFrom(repo: FixtureRepo, source: string): Promise<string[]> {
  return (await repo.edgesFrom(source, "calls")).map((e) => `${e.target}@${e.resolution}`).sort();
}

describe.skipIf(!RUN)("constructor-injected Kotlin property with a defaulted parameter", () => {
  let repo: FixtureRepo;
  const TARGET = "no.nav.a.ÅrsavregningService.hentGjeldendeBehandlingsresultaterForÅrsavregning";

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "service/src/main/kotlin/no/nav/a/ÅrsavregningService.kt": `package no.nav.a

import java.time.Instant

class ÅrsavregningService {
    fun hentGjeldendeBehandlingsresultaterForÅrsavregning(
        saksnummer: String,
        år: Int,
        førVedtaksdato: Instant? = null
    ): Int? = null
}
`,
      "service/src/main/kotlin/no/nav/b/Finner.kt": `package no.nav.b

import no.nav.a.ÅrsavregningService

class Finner(
    private val årsavregningService: ÅrsavregningService,
) {
    fun finn(saksnummer: String, år: Int) {
        val r = årsavregningService
            .hentGjeldendeBehandlingsresultaterForÅrsavregning(saksnummer, år)
    }

    fun enLinje() = årsavregningService.hentGjeldendeBehandlingsresultaterForÅrsavregning("a", 1)
}
`,
      "service/src/main/kotlin/no/nav/a/Opprettelse.kt": `package no.nav.a

class Opprettelse(private val årsavregningService: ÅrsavregningService) {
    private fun skal(år: Int): Boolean =
        årsavregningService.hentGjeldendeBehandlingsresultaterForÅrsavregning("x", år) != null
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test("2 arguments to a 3-parameter function with a default, across lines, resolve as typed", async () => {
    expect((await repo.edgesTo(TARGET, "calls")).map((e) => `${e.source}@${e.resolution}`).sort()).toEqual([
      "no.nav.a.Opprettelse.skal@typed",
      "no.nav.b.Finner.enLinje@typed",
      "no.nav.b.Finner.finn@typed",
    ]);
  });

  test("min_params counts parameters without a default, max_params all of them", async () => {
    const [row] = await sql<{ min_params: number; max_params: number; declared_type: string }[]>`
      SELECT s.min_params, s.max_params, s.declared_type FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${repo.name} AND s.qualified_name = ${TARGET}`;
    expect(row).toEqual({ min_params: 2, max_params: 3, declared_type: "Int" });
  });
});

describe.skipIf(!RUN)("receiver variables in scope", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/q/Foo.java": "package q;\n\npublic class Foo { public void run() {} }\n",
      "src/main/java/p/JUser.java": `package p;

import q.Foo;
import java.util.List;

public class JUser {
    private final Foo field;
    void viaField() { field.run(); }
    void viaParam(Foo param) { param.run(); }
    void viaLocal() { Foo local = make(); local.run(); }
    void viaFor(List<Foo> xs) { for (Foo x : xs) { x.run(); } }
    void viaThis() { this.field.run(); }
    private static final Foo FOO = null;
    void viaConstant() { FOO.run(); }
    void viaCatch() { try { make(); } catch (Foo e) { e.run(); } }
    void viaForInit() { for (Foo it = null; it != null; ) { it.run(); } }
    void viaResource() { try (Foo r = null) { r.run(); } }
    void viaLambda() { java.util.function.Consumer<Foo> c = (Foo f) -> f.run(); }
    void viaVar() { var v = make(); v.run(); }
    void viaQualified(q.Foo f) { f.run(); }
    Foo make() { return null; }
}

class JOuter {
    Foo foo;
    class In {
        void c() { this.foo.run(); }
    }
}

record JRec(Foo foo) {
    void viaComponent() { foo.run(); }
}

enum JEnum {
    A;
    private Foo foo;
    void viaEnumField() { foo.run(); }
}
`,
      "src/main/kotlin/k/KUser.kt": `package k

import q.Foo

class Box<T> {
    fun open() = 1
}

class KUser(private val ctor: Foo) {
    private val prop: Foo? = null
    private val boxed: Box<Foo> = Box()

    fun viaParam(p: Foo) { p.run() }
    fun viaLocal() { val l: Foo = Foo(); l.run() }
    fun viaInferred() { val i = Foo(); i.run() }
    fun viaCtor() { ctor.run() }
    fun viaThis() { this.ctor.run() }
    fun viaBang() { prop!!.run() }
    fun viaSafe() { prop?.run() }
    fun viaGeneric() { boxed.open() }
    fun viaThisSkipsLocal() { val ctor: Box<Int>? = null; this.ctor.run() }
    fun viaLambda() { val g = { f: Foo -> f.run() } }
    fun viaUntypedLambda() { val g: (Foo) -> Unit = { ctor -> ctor.run() } }
    fun viaFor(xs: List<Foo>) { for (f: Foo in xs) { f.run() } }
    fun viaCatch() {
        try {
            viaParam(ctor)
        } catch (e: Foo) {
            e.run()
        }
    }
    fun viaTop() { topFoo.run() }
    private val fnBox: Box<(Foo) -> Unit> = Box()
    fun viaFunctionTypeArgument() { fnBox.open() }
}

class KPlain(plain: Foo) {
    fun c() { plain.run() }
}

val topFoo: Foo = Foo()
`,
      "src/main/kotlin/s/Scope.kt": `package s

class A {
    fun go() = 1
}

class B {
    fun go() = 2
}

class Scope(private val x: A) {
    fun shadowed() { val x: B = B(); x.go() }
    fun field() { x.go() }
    fun local() { val y: B = B() }
    fun notInScope() { y.go() }
    fun later() { z.go(); val z: B = B() }
}
`,
      "src/main/java/s/JScope.java": `package s;

public class JScope {
    private A a;
    void shadow(B a) { a.go(); }
    void thisSkipsLocal() { B a = null; this.a.go(); }
    void later() { z.go(); B z = null; }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test.each([
    ["p.JUser.viaField", "Java field"],
    ["p.JUser.viaParam", "Java parameter"],
    ["p.JUser.viaFor", "Java for-each variable"],
    ["p.JUser.viaThis", "Java this.field"],
    ["k.KUser.viaParam", "Kotlin parameter"],
    ["k.KUser.viaLocal", "Kotlin typed local"],
    ["k.KUser.viaInferred", "Kotlin val x = Foo()"],
    ["k.KUser.viaCtor", "Kotlin constructor property"],
    ["k.KUser.viaThis", "Kotlin this.property"],
    ["k.KUser.viaBang", "Kotlin property!! of nullable type"],
    ["k.KUser.viaSafe", "Kotlin property?. of nullable type"],
    ["p.JUser.viaConstant", "Java uppercase field"],
    ["p.JUser.viaForInit", "Java for-loop initializer"],
    ["p.JUser.viaResource", "Java try-with-resources"],
    ["p.JUser.viaLambda", "Java typed lambda parameter"],
    ["p.JRec.viaComponent", "Java record component"],
    ["p.JEnum.viaEnumField", "Java enum field"],
    ["k.KUser.viaThisSkipsLocal", "Kotlin this.x past a local x"],
    ["k.KUser.viaLambda", "Kotlin typed lambda parameter"],
    ["k.KUser.viaFor", "Kotlin for-loop variable"],
    ["k.KUser.viaTop", "Kotlin top-level property"],
    ["p.JUser.viaQualified", "Java qualified declared type"],
  ])("%s (%s) → q.Foo.run", async (source) => {
    expect(await callsFrom(repo, source)).toEqual(["q.Foo.run@typed"]);
  });

  test("p.JUser.viaLocal (Java local) → q.Foo.run", async () => {
    expect(await callsFrom(repo, "p.JUser.viaLocal")).toEqual(["p.JUser.make@local", "q.Foo.run@typed"]);
  });

  test("p.JUser.viaCatch (Java catch parameter) → q.Foo.run", async () => {
    expect(await callsFrom(repo, "p.JUser.viaCatch")).toEqual(["p.JUser.make@local", "q.Foo.run@typed"]);
  });

  test("k.KUser.viaCatch (Kotlin catch parameter) → q.Foo.run", async () => {
    expect(await callsFrom(repo, "k.KUser.viaCatch")).toEqual(["k.KUser.viaParam@local", "q.Foo.run@typed"]);
  });

  test("an untyped Kotlin lambda parameter shadows a property without a type", async () => {
    expect(await callsFrom(repo, "k.KUser.viaUntypedLambda")).toEqual([]);
  });

  test("a plain constructor parameter is not a property", async () => {
    expect(await callsFrom(repo, "k.KPlain.c")).toEqual([]);
  });

  test("this.x stops at the innermost class body", async () => {
    expect(await callsFrom(repo, "p.JOuter.In.c")).toEqual([]);
  });

  test("a function type inside generic arguments is stripped with them", async () => {
    expect(await callsFrom(repo, "k.KUser.viaFunctionTypeArgument")).toEqual(["k.Box.open@typed"]);
  });

  test("declared_type holds a method's return type and a property's type, normalized", async () => {
    const rows = await sql<{ qualified_name: string; declared_type: string | null }[]>`
      SELECT s.qualified_name, s.declared_type FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repo.name} AND s.qualified_name IN ('p.JUser.make', 'k.KUser.prop', 'k.KUser.boxed', 'k.Box.open')
      ORDER BY s.qualified_name`;
    expect(rows).toEqual([
      { qualified_name: "k.Box.open", declared_type: null },
      { qualified_name: "k.KUser.boxed", declared_type: "Box" },
      { qualified_name: "k.KUser.prop", declared_type: "Foo" },
      { qualified_name: "p.JUser.make", declared_type: "Foo" },
    ]);
  });

  test("generic arguments are stripped from the declared type", async () => {
    expect(await callsFrom(repo, "k.KUser.viaGeneric")).toEqual(["k.Box.open@typed"]);
  });

  test("a local shadows a constructor property of the same name", async () => {
    expect(await callsFrom(repo, "s.Scope.shadowed")).toEqual(["s.B.go@typed"]);
    expect(await callsFrom(repo, "s.Scope.field")).toEqual(["s.A.go@typed"]);
  });

  test("a Java parameter shadows a field of the same name", async () => {
    expect(await callsFrom(repo, "s.JScope.shadow")).toEqual(["s.B.go@typed"]);
  });

  test("Java this.x skips a local x; a Java local declared after the call is not in scope", async () => {
    expect(await callsFrom(repo, "s.JScope.thisSkipsLocal")).toEqual(["s.A.go@typed"]);
    expect(await callsFrom(repo, "s.JScope.later")).toEqual([]);
  });

  test("another function's local and a local declared after the call are not in scope", async () => {
    expect(await callsFrom(repo, "s.Scope.notInScope")).toEqual([]);
    expect(await callsFrom(repo, "s.Scope.later")).toEqual([]);
  });

  test("impact entries and the impact trace carry the edge's resolution", async () => {
    const tracer = new ImpactTracer();
    const impact = await analyzeImpact("q.Foo.run", { repo: repo.name, maxDepth: 1, tracer });
    const viaField = impact!.affected.find((a) => a.qualified_name === "p.JUser.viaField");
    expect(viaField?.resolution).toBe("typed");
    // Every caller of q.Foo.run is a typed call; the trace keeps 20 of them.
    const traced = tracer.toJSON().topResults;
    expect(traced.length).toBeGreaterThan(0);
    expect(new Set(traced.map((t) => t.resolution))).toEqual(new Set(["typed"]));
  });
});

describe.skipIf(!RUN)("type name → class through imports, package and nesting", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/u1/Util.java": "package u1;\n\npublic class Util { public static void f() {} }\n",
      "src/main/java/u2/Util.java": "package u2;\n\npublic class Util { public static void f() {} }\n",
      "src/main/java/u3/Imp.java": "package u3;\n\nimport u2.Util;\n\npublic class Imp { void c() { Util.f(); } }\n",
      "src/main/java/w/Util.java": "package w;\n\npublic class Util { public static void f() {} }\n",
      "src/main/java/w/Pkg.java": "package w;\n\nimport u1.*;\n\npublic class Pkg { void c() { Util.f(); } }\n",
      "src/main/java/v/Wild.java": "package v;\n\nimport u2.*;\n\npublic class Wild { void c() { Util.f(); } }\n",
      "src/main/java/x/Util.java": "package x;\n\npublic class Util { public static void f() {} }\n",
      "src/main/java/x/Ext.java": "package x;\n\nimport org.ext.Util;\n\npublic class Ext { void c() { Util.f(); } }\n",
      "src/main/kotlin/al/Alias.kt": `package al

import u1.Util as U1

class Alias(private val u: U1) {
    fun viaStatic() { U1.f() }
    fun viaTyped() { u.f() }
}
`,
      "src/main/java/n/Outer.java": "package n;\n\npublic class Outer { public static class Inner { public static void f() {} } }\n",
      "src/main/java/m/Nest.java": `package m;

import n.Outer;

public class Nest extends Outer.Inner { void c() { Outer.Inner.f(); } }
`,
      "src/main/java/mt/Outer2.java": `package mt;

public class Outer2 {
    static class Inner { static void f() {} }
    void c() { Inner.f(); }
}

class Inner { static void f() {} }
`,
      "src/main/java/mt/Outer3.java": `package mt;

public class Outer3 {
    static class B { static void g() {} }
    static class C {
        static class B { static void g() {} }
        void f() { B.g(); }
    }
}
`,
      "src/main/java/b1/Base.java": "package b1;\n\npublic class Base {}\n",
      "src/main/java/b2/Base.java": "package b2;\n\npublic class Base {}\n",
      "src/main/kotlin/b3/Child.kt": "package b3\n\nimport b2.Base\n\nclass Child : Base()\n",
      "src/main/kotlin/m/KNest.kt": "package m\n\nimport n.Outer\n\nclass KNest : Outer.Inner()\n",
      "src/main/java/dn/Two.java": `package dn;

class A { static class N extends X {} }

class B { static class N extends Y {} }

class X {}

class Y {}

class Self { static class Builder extends Builder {} }
`,
      // PR 2 review: a same-file nested-class suffix match outranked another file's
      // exact match. Bar is not inside Zed, so Util is the same-package p.Util.
      "src/main/java/p/Bar.java":
        "package p;\n\nclass Bar { void c() { Util.f(); } } class Zed { static class Util { static void f(){} } }\n",
      "src/main/java/p/Util.java": "package p;\n\npublic class Util { static void f() {} }\n",
    });
  });
  afterAll(async () => repo?.cleanup());

  test("an explicit import picks one of two classes with the same simple name", async () => {
    expect(await callsFrom(repo, "u3.Imp.c")).toEqual(["u2.Util.f@static"]);
  });

  test("the same package outranks a wildcard import", async () => {
    expect(await callsFrom(repo, "w.Pkg.c")).toEqual(["w.Util.f@static"]);
  });

  test("a wildcard import resolves when nothing else does", async () => {
    expect(await callsFrom(repo, "v.Wild.c")).toEqual(["u2.Util.f@static"]);
  });

  test("an explicit import of a class outside the repo resolves to nothing", async () => {
    expect(await callsFrom(repo, "x.Ext.c")).toEqual([]);
  });

  test("a Kotlin import alias resolves as a static and as a declared type", async () => {
    expect(await callsFrom(repo, "al.Alias.viaStatic")).toEqual(["u1.Util.f@static"]);
    expect(await callsFrom(repo, "al.Alias.viaTyped")).toEqual(["u1.Util.f@typed"]);
  });

  test("Kotlin import alias is stored apart from the import path", async () => {
    const rows = await sql<{ import_path: string; alias: string | null }[]>`
      SELECT im.import_path, im.alias FROM ci_import_map im JOIN ci_files f ON f.id = im.file_id
      JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${repo.name} AND f.path LIKE '%Alias.kt'`;
    expect(rows).toEqual([{ import_path: "u1.Util", alias: "U1" }]);
  });

  test("a nested type through its imported outer class, in a call and in extends", async () => {
    expect(await callsFrom(repo, "m.Nest.c")).toEqual(["n.Outer.Inner.f@static"]);
    expect((await repo.edgesFrom("m.Nest", "extends")).map((e) => e.target)).toEqual(["n.Outer.Inner"]);
  });

  test("a Kotlin supertype keeps its qualifier", async () => {
    expect((await repo.edgesFrom("m.KNest", "extends")).map((e) => e.target)).toEqual(["n.Outer.Inner"]);
  });

  test("two nested classes of one name each keep their own extends clause", async () => {
    expect((await repo.edgesFrom("dn.A.N", "extends")).map((e) => e.target)).toEqual(["dn.X"]);
    expect((await repo.edgesFrom("dn.B.N", "extends")).map((e) => e.target)).toEqual(["dn.Y"]);
  });

  test("a supertype that resolves to the class itself is not an edge", async () => {
    expect(await repo.edgesFrom("dn.Self.Builder", "extends")).toEqual([]);
  });

  test("a member type outranks a top-level class of the same name in the same file", async () => {
    expect(await callsFrom(repo, "mt.Outer2.c")).toEqual(["mt.Outer2.Inner.f@static"]);
  });

  test("the innermost enclosing class's member type wins", async () => {
    expect(await callsFrom(repo, "mt.Outer3.C.f")).toEqual(["mt.Outer3.C.B.g@static"]);
  });

  test("inheritance follows the import, not the first class by simple name", async () => {
    expect((await repo.edgesFrom("b3.Child", "extends")).map((e) => e.target)).toEqual(["b2.Base"]);
  });

  test("a static receiver resolves to the same-package class, not a nested class of another class in the file", async () => {
    expect(await callsFrom(repo, "p.Bar.c")).toEqual(["p.Util.f@static"]);
  });
});

describe.skipIf(!RUN)("method lookup up the hierarchy, top-level functions and overloads", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/h/Base.kt": `package h

open class Base {
    fun shared() = 1
    open fun over() = 2
}

class Sub : Base() {
    override fun over() = 3
    fun inherited() { shared() }
    fun overridden() { over() }
}

class User {
    fun typed(s: Sub) { s.shared() }
}
`,
      "src/main/java/h/I.java": `package h;

public interface I { default void d() {} }
`,
      "src/main/java/h/Impl.java": `package h;

public class Impl implements I { void z() { d(); } }
`,
      "src/main/kotlin/t/Helpers.kt": `package t

fun helper(a: Int) = a
`,
      "src/main/kotlin/t/SamePkg.kt": `package t

class SamePkg {
    fun c() { helper(1) }
}

fun topCaller() { helper(2) }
`,
      "src/main/kotlin/t2/Imported.kt": `package t2

import t.helper
import t.helper as h

class Imported {
    fun direct() { helper(1) }
    fun aliased() { h(1) }
}
`,
      "src/main/kotlin/t2/Local.kt": `package t2

fun helper(a: Int) = 0
`,
      "src/main/kotlin/t3/Wild.kt": `package t3

import t.*

class Wild {
    fun c() { helper(1) }
}
`,
      "src/main/java/st/Util.java": `package st;

public class Util { public static void sf() {} }
`,
      "src/main/java/st2/StaticImp.java": `package st2;

import static st.Util.sf;

public class StaticImp { void c() { sf(); } }
`,
      "src/main/java/o/Ov.java": `package o;

public class Ov {
    void over(int a) {}
    void over(String s) {}
    void over(int a, int b) {}
    void v(String... xs) {}
    void one() { over(1); }
    void two() { over(1, 2); }
    void three() { over(1, 2, 3); }
    void varNone() { v(); }
    void varMany() { v("a", "b", "c"); }
    void rec(int n) { rec(n - 1); }
}
`,
      "src/main/kotlin/o/KOv.kt": `package o

class KOv {
    fun f(a: Int) = a
    fun f(a: Int, b: Int) = a + b
    fun named() { f(a = 1) }
    fun kv(first: Int, vararg rest: String) = first
    fun kvNone() { kv(1) }
    fun kvMany() { kv(1, "a", "b") }
    fun kvTooFew() { kv() }
}
`,
      "src/main/kotlin/c/Comp.kt": `package c

class X {
    companion object {
        fun f() = 1
    }
}

class Y {
    fun c() { X.Companion.f() }
}
`,
      "src/main/java/r/R.java": `package r;

public record R(int a) {
    static R of() { return new R(1); }
    void k() {}
}
`,
      "src/main/java/r/RUser.java": `package r;

public class RUser {
    void c(R rec) { R.of(); rec.k(); }
}
`,
    });
  });
  afterAll(async () => repo?.cleanup());

  test("a receiverless call to an inherited method resolves to the base class", async () => {
    expect(await callsFrom(repo, "h.Sub.inherited")).toEqual(["h.Base.shared@local"]);
  });

  test("an override in the class itself outranks the base method", async () => {
    expect(await callsFrom(repo, "h.Sub.overridden")).toEqual(["h.Sub.over@local"]);
  });

  test("a typed receiver of a subclass resolves to the base class method", async () => {
    expect(await callsFrom(repo, "h.User.typed")).toEqual(["h.Base.shared@typed"]);
  });

  test("a receiverless call resolves to an interface default method", async () => {
    expect(await callsFrom(repo, "h.Impl.z")).toEqual(["h.I.d@local"]);
  });

  test("an explicit function import outranks a same-package function of that name", async () => {
    expect(await callsFrom(repo, "t2.Imported.direct")).toEqual(["t.helper@local"]);
  });

  test("Kotlin top-level functions: same package, imported, aliased, wildcard", async () => {
    expect(await callsFrom(repo, "t.SamePkg.c")).toEqual(["t.helper@local"]);
    expect(await callsFrom(repo, "t.topCaller")).toEqual(["t.helper@local"]);
    expect(await callsFrom(repo, "t2.Imported.direct")).toEqual(["t.helper@local"]);
    expect(await callsFrom(repo, "t2.Imported.aliased")).toEqual(["t.helper@local"]);
    expect(await callsFrom(repo, "t3.Wild.c")).toEqual(["t.helper@local"]);
  });

  test("a Java static import resolves a receiverless call", async () => {
    expect(await callsFrom(repo, "st2.StaticImp.c")).toEqual(["st.Util.sf@local"]);
  });

  test("an edge to every overload whose parameter range admits the argument count", async () => {
    const lines = async (source: string) =>
      (await repo.edgesFrom(source, "calls")).map((e) => e.targetLine).sort((a, b) => a - b);
    expect(await lines("o.Ov.one")).toEqual([4, 5]);
    expect(await lines("o.Ov.two")).toEqual([6]);
    expect(await lines("o.Ov.three")).toEqual([]);
  });

  test("a Java vararg method matches any argument count from its required parameters up", async () => {
    expect(await callsFrom(repo, "o.Ov.varNone")).toEqual(["o.Ov.v@local"]);
    expect(await callsFrom(repo, "o.Ov.varMany")).toEqual(["o.Ov.v@local"]);
  });

  test("a recursive call is not an edge to itself", async () => {
    expect(await callsFrom(repo, "o.Ov.rec")).toEqual([]);
  });

  test("a Kotlin vararg admits any count from the required parameters up", async () => {
    expect(await callsFrom(repo, "o.KOv.kvNone")).toEqual(["o.KOv.kv@local"]);
    expect(await callsFrom(repo, "o.KOv.kvMany")).toEqual(["o.KOv.kv@local"]);
    expect(await callsFrom(repo, "o.KOv.kvTooFew")).toEqual([]);
  });

  test("a call with a named argument has no count and reaches every overload", async () => {
    expect((await repo.edgesFrom("o.KOv.named", "calls")).map((e) => e.targetLine).sort()).toEqual([4, 5]);
  });

  test("an X.Companion receiver resolves to the companion's function", async () => {
    expect(await callsFrom(repo, "c.Y.c")).toEqual(["c.X.f@static"]);
  });

  test("Java record methods are symbols and resolve", async () => {
    expect(await callsFrom(repo, "r.RUser.c")).toEqual(["r.R.k@typed", "r.R.of@static"]);
  });
});
