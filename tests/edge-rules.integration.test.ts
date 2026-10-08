import { describe, test, expect, afterEach } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { sql } from "../src/db/connection.ts";
import { setFilePackages } from "../src/db/files.ts";

/**
 * Rules of the repo-wide edge rebuild (rebuildEdges) that no other test pins: each test
 * fails when the named rule is removed.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/edge-rules.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("edge rebuild rules", () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  // Inheritance edges have a NULL line, so ON CONFLICT never dedupes them: only the
  // repo-wide delete keeps a rebuild from duplicating edges of unchanged files.
  test("reindexing an unrelated file leaves exactly one extends edge between unchanged files", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/D.java": "package p;\n\npublic class D {}\n",
      "src/main/java/p/C.java": "package p;\n\npublic class C extends D {}\n",
      "src/main/java/p/E.java": "package p;\n\npublic class E {}\n",
    });
    await repo.reindex({ "src/main/java/p/E.java": "package p;\n\npublic class E { void e() {} }\n" });
    expect((await repo.edgesTo("p.D", "extends")).map((e) => e.source)).toEqual(["p.C"]);
  });

  // Deleting a file changes no other file's hash; the rebuild must still run so the
  // call into the deleted copy of a class (two Gradle modules) retargets to the other.
  test("deleting a file retargets a static call to the remaining copy of the class", async () => {
    repo = await createFixtureRepo({
      "mod1/src/main/java/p/B.java": "package p;\n\npublic class B { public static void helper() {} }\n",
      "mod2/src/main/java/p/B.java": "package p;\n\npublic class B { public static void helper() {} }\n",
      "src/main/java/r/A.java": "package r;\n\nimport p.B;\n\npublic class A { void run() { B.helper(); } }\n",
    });
    const targets = async () => (await repo!.edgesFrom("r.A.run", "calls")).map((e) => [e.target, e.targetPath]);
    expect(await targets()).toEqual([["p.B.helper", "mod1/src/main/java/p/B.java"]]);
    await repo.reindex({}, ["mod1/src/main/java/p/B.java"]);
    expect(await targets()).toEqual([["p.B.helper", "mod2/src/main/java/p/B.java"]]);
  });

  // `f(null)` admits both one-parameter overloads (null fits any parameter type), so only
  // self-exclusion keeps the caller `f(int)` off its own edge list. `S.g()` matches p.S
  // and q.S by name; the import picks p.S.
  test("an overload calling its sibling and an imported static call each resolve to one target", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/S.java": "package p;\n\npublic class S { public static void g() {} }\n",
      "src/main/java/q/S.java": "package q;\n\npublic class S { public static void g() {} }\n",
      "src/main/java/r/A.java": `package r;

import p.S;

public class A {
    void f(int a) {
        f(null);
        S.g();
    }

    void f(String s) {}
}
`,
    });
    const edges = await repo.edgesFrom("r.A.f", "calls");
    expect(edges.map((e) => [e.sourceLine, e.target, e.targetLine])).toEqual([
      [6, "p.S.g", 3],
      [6, "r.A.f", 11],
    ]);
  });

  // Same-rank owners: the same package declares `helper` in two files (two Gradle
  // modules); the caller's own file wins.
  test("a receiverless call prefers the same-package function in the caller's file", async () => {
    repo = await createFixtureRepo({
      "mod1/src/main/kotlin/t/Helpers.kt": "package t\n\nfun helper() = 1\n",
      "mod2/src/main/kotlin/t/Caller.kt": "package t\n\nfun helper() = 2\n\nclass Caller {\n    fun c() { helper() }\n}\n",
    });
    expect((await repo.edgesFrom("t.Caller.c", "calls")).map((e) => e.targetPath)).toEqual([
      "mod2/src/main/kotlin/t/Caller.kt",
    ]);
  });

  test("a this-qualified call resolves to the sibling method", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/T.java": `package p;

public class T {
    void a() { this.b(); }
    void b() {}
}
`,
    });
    expect((await repo.edgesFrom("p.T.a", "calls")).map((e) => e.target)).toEqual(["p.T.b"]);
  });

  // Two call sites on one line reach the same target: one edge, labeled with the
  // strongest resolution (typed > static > local).
  test("one edge per line and target keeps the strongest resolution", async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/p/A.kt": "package p\n\nclass A {\n    fun g() = 1\n    fun f(a: A) { g(); a.g() }\n}\n",
    });
    expect((await repo.edgesFrom("p.A.f", "calls")).map((e) => `${e.target}@${e.resolution}`)).toEqual(["p.A.g@typed"]);
  });

  test("a member method hides a same-package function of the same name", async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/p/F.kt": "package p\n\nfun foo() = 0\n\nclass M {\n    fun foo() = 1\n    fun c() { foo() }\n}\n",
    });
    expect((await repo.edgesFrom("p.M.c", "calls")).map((e) => e.target)).toEqual(["p.M.foo"]);
  });

  test("a this-qualified call in an inner class does not walk to the outer class", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/O.java": `package p;

public class O {
    void outer() {}
    class I { void c() { this.outer(); } }
}
`,
    });
    expect(await repo.edgesFrom("p.O.I.c", "calls")).toEqual([]);
  });

  test("an own member type outranks an inherited member type of the same name", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/B.java": "package p;\n\npublic class B {\n    public static class X { public static void s() {} }\n}\n",
      "src/main/java/p/A.java": `package p;

public class A extends B {
    public static class X { public static void s() {} }
    void c() { X.s(); }
}
`,
    });
    expect((await repo.edgesFrom("p.A.c", "calls")).map((e) => e.target)).toEqual(["p.A.X.s"]);
  });

  test("an external supertype from the extends clause makes a certain fit", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/MyEx.java": "package p;\n\npublic class MyEx extends RuntimeException {}\n",
      "src/main/java/p/H.java": `package p;

public class H {
    void h(RuntimeException e) {}
    void h(Iterable<?> i) {}
    void c(MyEx e) { h(e); }
}
`,
    });
    expect((await repo.edgesFrom("p.H.c", "calls")).map((e) => e.targetLine)).toEqual([4]);
  });

  test("a top-level function does not match a typed receiver", async () => {
    repo = await createFixtureRepo({
      "src/main/kotlin/p/G.kt": "package p\n\nfun bar() = 0\n\nclass Foo\n\nclass U(private val f: Foo) {\n    fun c() { f.bar() }\n}\n",
    });
    expect(await repo.edgesFrom("p.U.c", "calls")).toEqual([]);
  });

  test("setFilePackages updates every row across several chunks", async () => {
    repo = await createFixtureRepo(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/main/java/p/C${i}.java`, `package p;\n\npublic class C${i} {}\n`])),
    );
    const files = await sql<{ id: string; path: string }[]>`
      SELECT f.id, f.path FROM ci_files f JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${repo.name} ORDER BY f.path`;
    await setFilePackages(files.map((f) => ({ fileId: f.id, packageName: `q.${f.path.slice(-7, -5)}` })), 2);
    const after = await sql<{ package_name: string }[]>`
      SELECT f.package_name FROM ci_files f JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${repo.name} ORDER BY f.path`;
    expect(after.map((r) => r.package_name)).toEqual(["q.C0", "q.C1", "q.C2", "q.C3", "q.C4"]);
  });
});
