import { describe, test, expect } from "bun:test";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "../src/indexer/parser.ts";
import { extractSymbols } from "../src/indexer/symbol-extractor.ts";
import { extractCallGraph, type ExtractedCall } from "../src/indexer/call-graph.ts";

/**
 * What the receiver scope walk stores per call site: the receiver's declared type, the
 * receiver kind, argument types and names, and the implicit receiver of a Kotlin scope
 * function's lambda. Each case names the declaration that must win.
 */
async function extract(lang: SupportedLanguage, source: string) {
  await initParser();
  const language = await loadLanguage(lang);
  const tree = parseSource(source, language)!;
  try {
    const extraction = extractSymbols(source, tree, lang, language);
    return { extraction, calls: extractCallGraph(source, tree, lang, extraction).calls };
  } finally {
    tree.delete();
  }
}

/** The single call to `method` in `source`. */
async function call(lang: SupportedLanguage, source: string, method: string): Promise<ExtractedCall> {
  const found = (await extract(lang, source)).calls.filter((c) => c.methodName === method);
  if (found.length !== 1) throw new Error(`expected one call to ${method}, got ${found.length}`);
  return found[0];
}

const typeOf = async (lang: SupportedLanguage, source: string, method: string) =>
  (await call(lang, source, method)).receiverType;

describe("Kotlin plain constructor parameters", () => {
  test("a plain parameter shadows a same-name property in a property initializer", async () => {
    const src = `class C(foo: FooBuilder) { val foo: Foo = foo.build() }`;
    expect(await typeOf("kotlin", src, "build")).toBe("FooBuilder");
  });

  test("a plain parameter shadows a top-level property in an init block", async () => {
    const src = `val repo: TopRepo = TopRepo()\nclass C(repo: CtorRepo) { init { repo.save() } }`;
    expect(await typeOf("kotlin", src, "save")).toBe("CtorRepo");
  });

  test("a nested class's plain parameter shadows the outer class's property", async () => {
    const src = `class Outer {\n  val repo: OuterRepo = OuterRepo()\n\n  inner class N(repo: InnerRepo) { init { repo.save() } }\n}`;
    expect(await typeOf("kotlin", src, "save")).toBe("InnerRepo");
  });

  test("a plain parameter is not in scope in a member function", async () => {
    const src = `class C(repo: CtorRepo) { val x = 1\n  fun f() { repo.save() } }`;
    expect(await typeOf("kotlin", src, "save")).toBeNull();
  });
});

describe("Java pattern variables", () => {
  test("an instanceof pattern variable shadows a field", async () => {
    const src = `class C { Foo s; void f(Object o) { if (o instanceof Bar s) { s.x(); } } }`;
    expect(await typeOf("java", src, "x")).toBe("Bar");
  });

  test("a switch type pattern shadows a field", async () => {
    const src = `class C { Baz e; void f(Object o) { switch (o) { case Qux e -> e.y(); default -> {} } } }`;
    expect(await typeOf("java", src, "y")).toBe("Qux");
  });

  test("a record pattern component is typed", async () => {
    const src = `class C { Foo q; void f(Object o) { switch (o) { case Point(int px, Baz q) -> q.z(); default -> {} } } }`;
    expect(await typeOf("java", src, "z")).toBe("Baz");
  });
});

describe("Kotlin destructuring shadows", () => {
  test("in lambda parameters", async () => {
    const src = `class C(private val x: Baz) { fun f(m: Map<String, Baz>) { m.forEach { (k, x) -> x.h() } } }`;
    expect(await typeOf("kotlin", src, "h")).toBeNull();
  });

  test("in a for loop", async () => {
    const src = `class C(private val x: Baz) { fun f(m: Map<String, Baz>) { for ((k, x) in m) { x.h() } } }`;
    expect(await typeOf("kotlin", src, "h")).toBeNull();
  });

  test("in a local declaration", async () => {
    const src = `class C(private val x: Baz) { fun f(p: Pair<Int, Int>) { val (k, x) = p; x.h() } }`;
    expect(await typeOf("kotlin", src, "h")).toBeNull();
  });
});

describe("Kotlin this and it", () => {
  test("this@Outer.x looks x up in Outer, and the receiver drops the label", async () => {
    const src = `class Outer {\n  val x: A = A()\n\n  inner class Inner {\n    val x: B = B()\n\n    fun f() { this@Outer.x.go() }\n  }\n}`;
    const c = await call("kotlin", src, "go");
    expect([c.receiver, c.receiverType]).toEqual(["x", "A"]);
  });

  test("this.x in an inner class stops at the inner class", async () => {
    const src = `class Outer {\n  val x: A = A()\n\n  inner class Inner { fun f() { this.x.go() } }\n}`;
    expect(await typeOf("kotlin", src, "go")).toBeNull();
  });

  test("an implicit it shadows an outer it", async () => {
    const src = `class C { fun f(xs: List<Foo>, it: Foo) { xs.forEach { it.go() } } }`;
    expect(await typeOf("kotlin", src, "go")).toBeNull();
  });
});

describe("uppercase receivers declared as variables", () => {
  test("an untyped Kotlin local named like a class is a variable, not a static receiver", async () => {
    const c = await call("kotlin", `class C { fun f() { val Foo = listOf(1); Foo.size() } }`, "size");
    expect([c.receiverKind, c.receiverType]).toEqual(["identifier", null]);
  });

  test("an uppercase name not declared in scope stays a static receiver", async () => {
    const c = await call("kotlin", `class C { fun f() { Foo.size() } }`, "size");
    expect([c.receiverKind, c.receiverType]).toEqual(["static-type", null]);
  });

  test("a typed uppercase Java field is a typed identifier", async () => {
    const c = await call("java", `class C { static final Foo FOO = null; void f() { FOO.run(); } }`, "run");
    expect([c.receiverKind, c.receiverType]).toEqual(["identifier", "Foo"]);
  });
});

describe("scope guards", () => {
  test("Kotlin val x = factory() stores no type (lowercase callee)", async () => {
    expect(await typeOf("kotlin", `class C { fun f() { val x = factory(); x.go() } }`, "go")).toBeNull();
  });

  test("Java multi-catch has no single type", async () => {
    expect(await typeOf("java", `class C { void f() { try {} catch (A1 | B1 e) { e.go(); } } }`, "go")).toBeNull();
  });

  test("a Java spread parameter shadows a field", async () => {
    expect(await typeOf("java", `class C { Bar a; void f(Foo... a) { a.go(); } }`, "go")).toBeNull();
  });

  test("an untyped single Java lambda parameter shadows a field", async () => {
    expect(await typeOf("java", `class C { Bar x; void f() { g(x -> x.go()); } }`, "go")).toBeNull();
  });

  test("inferred Java lambda parameters shadow a field", async () => {
    expect(await typeOf("java", `class C { Bar b; void f() { g((a, b) -> b.go()); } }`, "go")).toBeNull();
  });

  test("Java var shadows a field but stores no type", async () => {
    expect(await typeOf("java", `class C { Bar v; void f() { var v = make(); v.go(); } }`, "go")).toBeNull();
  });

  test("a Kotlin local declared in an initializer does not see itself", async () => {
    expect(await typeOf("kotlin", `class C(private val x: A) { fun f() { val x: B = x.go() } }`, "go")).toBe("A");
  });

  test("a Java local declared after the call is not in scope", async () => {
    expect(await typeOf("java", `class C { Bar z; void f() { z.go(); Foo z = null; } }`, "go")).toBe("Bar");
  });
});

describe("argument types and names", () => {
  test("Java literals, identifiers, this, null and constructor calls", async () => {
    const c = await call(
      "java",
      `class C { void f(long id, Foo foo) { g("s", 'c', 1, 2L, 1.0, 1.5f, true, null, this, new Bar<>(), -1, id, foo, h()); } }`,
      "g",
    );
    expect(c.argTypes).toEqual([
      "String", "char", "#int", "long", "double", "float", "boolean", null, "C", "Bar", "#int", "long", "Foo", null,
    ]);
    expect(c.argNames).toBeNull();
  });

  test("Kotlin literals, identifiers, this, null and constructor calls", async () => {
    const c = await call(
      "kotlin",
      `class C { fun f(id: Long?, xs: List<Foo>) { g("s", 1, 2L, 1.0, 1.5f, true, null, this, Bar(), id, xs, h()) } }`,
      "g",
    );
    expect(c.argTypes).toEqual([
      "String", "#int", "long", "double", "float", "boolean", null, "C", "Bar", "long", "List", null,
    ]);
  });

  test("Kotlin named arguments keep their names, count toward arity, and a spread has no count", async () => {
    const named = await call("kotlin", `fun f() { k(1, b = "x") { } }`, "k");
    expect([named.argCount, named.argNames, named.argTypes]).toEqual([3, [null, "b", null], ["#int", "String", null]]);
    expect((await call("kotlin", `fun f() { m(*arr) }`, "m")).argCount).toBeNull();
  });

  test("Kotlin this inside a lambda or an extension function is not the class", async () => {
    const { calls } = await extract("kotlin", `class C { fun f() { run { g(this) } } }\nfun Foo.e() { h(this) }`);
    expect(calls.filter((c) => c.methodName !== "run").map((c) => [c.methodName, c.argTypes])).toEqual([
      ["g", [null]],
      ["h", ["Foo"]],
    ]);
  });
});

describe("Kotlin scope-function receivers", () => {
  const SRC = `class Other { fun bar() = 1 }
class K(private val o: Other) {
  fun a() { with(o) { bar() } }
  fun b() { o.apply { bar() } }
  fun c() { o.run { bar() } }
  fun d() { o.let { bar() } }
  fun e() { Other().apply { bar() } }
  fun f(u: Unknown?) { u.also { bar() } }
}`;

  test("with, apply and run give their lambda the receiver's type; let and also do not", async () => {
    const { calls } = await extract("kotlin", SRC);
    expect(calls.filter((c) => c.methodName === "bar").map((c) => c.implicitReceiverType)).toEqual([
      "Other", "Other", "Other", null, "Other", null,
    ]);
  });
});

describe("symbol shapes", () => {
  test("parameter types and names, generics stripped, type parameters unknown", async () => {
    const { extraction } = await extract(
      "java",
      `class A<T> { private <U> void m(final long a, T t, U u, int[] xs, java.util.List<String> l, Integer i, String... rest) {} }`,
    );
    const m = extraction.symbols.find((s) => s.name === "m")!;
    expect([m.paramTypes, m.paramNames, m.visibility]).toEqual([
      ["long", null, null, null, "List", "int", null],
      ["a", "t", "u", "xs", "l", "i", "rest"],
      "private",
    ]);
  });

  test("Kotlin parameter types, extension receiver and visibility behind an annotation", async () => {
    const { extraction } = await extract(
      "kotlin",
      `@Suppress("x") private fun <T> Foo.ext(a: Int = 1, t: T, l: List<Bar>?, vararg b: String): Int = 1`,
    );
    const f = extraction.symbols.find((s) => s.name === "ext")!;
    expect([f.paramTypes, f.paramNames, f.extensionReceiver, f.visibility]).toEqual([
      ["int", null, "List", null],
      ["a", "t", "l", "b"],
      "Foo",
      "private",
    ]);
  });
});

describe("scope walk cost", () => {
  // Each scope's declarations are read once; re-scanning a block per call took 8 s here.
  test("a 4,000-call Java method extracts in under 2 s", async () => {
    const body = Array.from({ length: 4000 }, (_, i) => `    Foo v${i} = null; v${i}.run(${i});`).join("\n");
    const start = performance.now();
    const { calls } = await extract("java", `class S {\n  void m() {\n${body}\n  }\n}\n`);
    expect(calls.filter((c) => c.receiverType === "Foo").length).toBe(4000);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("type-parameter arguments", () => {
  const args = async (lang: SupportedLanguage, src: string, method: string) => (await call(lang, src, method)).argTypes;

  test("Java: a type parameter's bound, or unknown without one", async () => {
    expect(await args("java", `class C { <T extends Behandling> void f(T t) { svc.lagre(t); } }`, "lagre")).toEqual(["Behandling"]);
    expect(await args("java", `class C<T> { T x; void f() { svc.lagre(x); } }`, "lagre")).toEqual([null]);
    expect(await args("java", `class C { <T extends A & B> void f(T t) { svc.lagre(t); } }`, "lagre")).toEqual([null]);
  });

  test("Kotlin: a type parameter's bound, or unknown without one", async () => {
    expect(await args("kotlin", `fun <T> f(t: T) { g(t) }`, "g")).toEqual([null]);
    expect(await args("kotlin", `fun <T : Beh> f(t: T?) { g(t) }`, "g")).toEqual(["Beh"]);
    expect(await args("kotlin", `class C<T>(val x: T) { fun f() { g(x) } }`, "g")).toEqual([null]);
  });
});

describe("Java pattern bindings stay in their positive branch", () => {
  test("a binding in a field initializer does not overwrite the field", async () => {
    const src = `class C { Foo s; static boolean b = O.o instanceof Bar s; void f() { this.s.y(); s.z(); } }`;
    expect(await typeOf("java", src, "y")).toBe("Foo");
    expect(await typeOf("java", src, "z")).toBe("Foo");
  });

  test("typed in the then-branch and the RHS of &&; unknown after the if, in else and under a negation", async () => {
    const src = `class C { Foo s; void f(Object o) {
      if (o instanceof Bar s) { s.inThen(); } else { s.inElse(); }
      s.after();
      boolean b = o instanceof Bar s && s.inAnd();
      if (!(o instanceof Bar s)) { s.inNegated(); }
    } }`;
    const { calls } = await extract("java", src);
    const t = (m: string) => calls.find((c) => c.methodName === m)!.receiverType;
    expect([t("inThen"), t("inElse"), t("after"), t("inAnd"), t("inNegated")]).toEqual(["Bar", null, null, "Bar", null]);
  });

  test("a switch pattern binding does not leak past the switch", async () => {
    const src = `class C { Foo e; void f(Object o) { switch (o) { case Qux e -> e.y(); default -> {} } e.after(); } }`;
    expect(await typeOf("java", src, "after")).toBe("Foo");
  });
});

describe("labeled this as an argument", () => {
  test("typed only when the label names an enclosing class or an extension function", async () => {
    const { calls } = await extract(
      "kotlin",
      `class Outer {\n  inner class In {\n    fun f(o: Other) {\n      o.apply {\n        g(this@apply)\n        k(this@Outer)\n      }\n    }\n  }\n}`,
    );
    const a = (m: string) => calls.find((c) => c.methodName === m)!.argTypes;
    expect([a("g"), a("k")]).toEqual([[null], ["Outer"]]);
    expect((await call("kotlin", `fun Foo.e() { h(this@e) }`, "h")).argTypes).toEqual(["Foo"]);
  });
});

describe("Kotlin constructor parameters in accessors", () => {
  test("a getter sees the member, not the plain constructor parameter", async () => {
    const src = `class C(repo: CtorRepo) {\n  val repo: Member = Member()\n  val g: Int get() = repo.save()\n}`;
    expect(await typeOf("kotlin", src, "save")).toBe("Member");
  });

  test("the initializer of the same property still sees the parameter", async () => {
    const src = `class C(repo: CtorRepo) {\n  val repo: Member = Member()\n  val g: Int = repo.save()\n}`;
    expect(await typeOf("kotlin", src, "save")).toBe("CtorRepo");
  });
});

describe("Kotlin integer literal types", () => {
  test("out of Int range is Long, an L suffix is Long, an unsigned literal (also hex) is UInt", async () => {
    const c = await call("kotlin", `fun f() { g(3000000000, 0xFFFFFFFF, 7L, 0xFFu, 1u, 2147483647, 0x7FFF_FFFF) }`, "g");
    expect(c.argTypes).toEqual(["long", "long", "long", "UInt", "UInt", "#int", "#int"]);
  });

  test("a property's literal initializer gets the same type", async () => {
    const { calls } = await extract("kotlin", `fun f() { val big = 3000000000\n val u = 0xFFu\n g(big, u) }`);
    expect(calls.find((c) => c.methodName === "g")!.argTypes).toEqual(["long", "UInt"]);
  });
});

describe("Kotlin implicit receivers across class boundaries", () => {
  test("an object literal inside with(x) keeps x as implicit receiver", async () => {
    const src = `class K(private val o: Other) {\n  fun f() {\n    with(o) {\n      val r = object : Runnable {\n        override fun run() { bar() }\n      }\n    }\n  }\n}`;
    expect((await call("kotlin", src, "bar")).implicitReceiverType).toBe("Other");
  });

  test("a local class inside with(x) stops it (its own members come first)", async () => {
    const src = `class K(private val o: Other) {\n  fun g() {\n    with(o) {\n      class L {\n        fun m() { baz() }\n      }\n    }\n  }\n}`;
    expect((await call("kotlin", src, "baz")).implicitReceiverType).toBeNull();
  });
});
