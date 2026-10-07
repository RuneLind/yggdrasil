import { describe, test, expect, afterEach } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";

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
  // call into the deleted class retargets to the remaining match.
  test("deleting a file retargets an ambiguous static call to the remaining class", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/B.java": "package p;\n\npublic class B { public static void helper() {} }\n",
      "src/main/java/q/B.java": "package q;\n\npublic class B { public static void helper() {} }\n",
      "src/main/java/r/A.java": "package r;\n\npublic class A { void run() { B.helper(); } }\n",
    });
    expect((await repo.edgesFrom("r.A.run", "calls")).map((e) => e.target)).toEqual(["p.B.helper"]);
    await repo.reindex({}, ["src/main/java/p/B.java"]);
    expect((await repo.edgesFrom("r.A.run", "calls")).map((e) => e.target)).toEqual(["q.B.helper"]);
  });

  // One call site, one edge: the first candidate by (qualified name, line) that is not
  // the caller itself. `f(int)` precedes `f()`, so without the self-exclusion it would
  // pick itself; `S.g()` matches p.S and q.S, and the tie-break picks p.S.
  test("an overload calling its sibling and an ambiguous static call each resolve to one target", async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/S.java": "package p;\n\npublic class S { public static void g() {} }\n",
      "src/main/java/q/S.java": "package q;\n\npublic class S { public static void g() {} }\n",
      "src/main/java/r/A.java": `package r;

public class A {
    void f(int a) {
        f();
        S.g();
    }

    void f() {}
}
`,
    });
    const edges = await repo.edgesFrom("r.A.f", "calls");
    expect(edges.map((e) => [e.sourceLine, e.target, e.targetLine])).toEqual([
      [4, "p.S.g", 3],
      [4, "r.A.f", 9],
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
});
