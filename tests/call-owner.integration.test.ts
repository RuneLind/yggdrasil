import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpact } from "../src/search/impact.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Call-site ownership and target choice, through the real indexer.
 *
 * A call site belongs to the outermost method, function or constructor whose source
 * range contains the call, within the innermost class, interface, enum or object that
 * contains it. Owning by line span credited a call on a line shared by two callables to
 * the later one, and gave calls inside an anonymous class or an object expression to
 * that nested method, which has no callers. A local function has callers (its host), so
 * crediting its calls to the host is a choice: one owner, a shorter impact path.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/call-owner.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("outermost owner of a call site", () => {
  let repo: FixtureRepo;

  const callers = async (target: string) =>
    (await repo.edgesTo(target, "calls")).map((e) => e.source);

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/Helpers.java": `package p;

public class Helpers {
    static int compute(int x) { return x; }
}
`,
      "src/main/java/p/Pair.java": `package p;

public class Pair { void a() { Helpers.compute(5); } void b() { Helpers.compute(6); } }
`,
      "src/main/java/p/Sched.java": `package p;

public class Sched {
    void outer() {
        schedule(new Runnable() { public void run() { tick(); } });
    }
    void schedule(Runnable r) {}
    void tick() {}
    void top() { outer(); }
}
`,
      "src/main/kotlin/p/Util.kt": `package p

object Util {
    fun log(s: String) = 1
    fun named(a: Int, b: Int) = 2
    fun y() = 3
}
`,
      "src/main/kotlin/p/Same.kt": `package p

class Same { fun a() = Util.log("a"); fun c() = Util.named(1, 2) }
`,
      "src/main/kotlin/p/Host.kt": `package p

interface Foo { fun x() }

class Host {
    fun host() {
        val f = object : Foo {
            override fun x() {
                Util.y()
            }
        }
        f.x()
    }
}
`,
      "src/main/kotlin/p/K.kt": `package p

class K {
    fun outer() {
        fun inner() {
            Helpers.compute(1)
        }
        inner()
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("Java: two methods on one line each own their own call", async () => {
    expect((await callers("p.Helpers.compute")).filter((s) => s.startsWith("p.Pair"))).toEqual([
      "p.Pair.a",
      "p.Pair.b",
    ]);
  });

  test("Kotlin: two expression-bodied functions on one line each own their own call", async () => {
    expect(await callers("p.Util.log")).toEqual(["p.Same.a"]);
    expect(await callers("p.Util.named")).toEqual(["p.Same.c"]);
  });

  test("Java: calls inside an anonymous class belong to the host method", async () => {
    expect(await callers("p.Sched.schedule")).toEqual(["p.Sched.outer"]);
    expect(await callers("p.Sched.tick")).toEqual(["p.Sched.outer"]);
  });

  test("Java: impact of a call made in an anonymous class reaches the host and its callers", async () => {
    const impact = await analyzeImpact("p.Sched.tick", { repo: repo.name });
    const reached = impact!.affected.map((a) => [a.qualified_name, a.depth]);
    expect(reached).toContainEqual(["p.Sched.outer", 1]);
    expect(reached).toContainEqual(["p.Sched.top", 2]);
  });

  test("Kotlin: a call in an object-expression override belongs to the host function", async () => {
    expect(await callers("p.Util.y")).toEqual(["p.Host.host"]);
  });

  test("Kotlin: a call in a local function belongs to the host function", async () => {
    expect((await callers("p.Helpers.compute")).filter((s) => s.startsWith("p.K"))).toEqual([
      "p.K.outer",
    ]);
  });
});

/**
 * The same fully qualified class can exist in two files (two Gradle modules). A call,
 * unqualified or through the class name, must resolve into the caller's own file before
 * the other module's.
 */
describe.skipIf(!RUN)("same-file preference for unqualified calls", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "mod1/src/main/java/p/Dup.java": `package p;

public class Dup {
    void helper() {}
    static void util() {}
}
`,
      "mod2/src/main/java/p/Dup.java": `package p;

public class Dup {


    void helper() {}

    void caller() { helper(); }

    static void util() {}

    void staticCaller() { Dup.util(); }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("helper() resolves to the caller's own file", async () => {
    const edges = await repo.edgesFrom("p.Dup.caller", "calls");
    expect(edges.map((e) => [e.target, e.targetPath, e.targetLine])).toEqual([
      ["p.Dup.helper", "mod2/src/main/java/p/Dup.java", 6],
    ]);
  });

  test("Dup.util() resolves to the caller's own file", async () => {
    const edges = await repo.edgesFrom("p.Dup.staticCaller", "calls");
    expect(edges.map((e) => [e.target, e.targetPath, e.targetLine])).toEqual([
      ["p.Dup.util", "mod2/src/main/java/p/Dup.java", 10],
    ]);
  });
});

/**
 * Overloads share a qualified name. Among same-file targets with one qualified name,
 * the lower start line wins, then the lower id.
 */
describe.skipIf(!RUN)("tie-break between overloads", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/Ov.java": `package p;

public class Ov {
    void over(int a) {}

    void over(String s) {}

    void same(int a) {} void same(String s) {}

    void caller() { over(1); same(2); }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the overload with the lower start line wins", async () => {
    const edges = await repo.edgesFrom("p.Ov.caller", "calls");
    expect(edges.filter((e) => e.target === "p.Ov.over").map((e) => e.targetLine)).toEqual([4]);
  });

  test("overloads on one line: the lower id wins", async () => {
    const ids = await sql<{ id: string }[]>`
      SELECT s.id FROM ci_symbols s JOIN ci_files f ON f.id = s.file_id
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repo.name} AND s.qualified_name = 'p.Ov.same'
      ORDER BY s.id`;
    expect(ids).toHaveLength(2);
    const [edge] = await sql<{ target_id: string }[]>`
      SELECT e.target_id FROM ci_edges e JOIN ci_symbols src ON src.id = e.source_id
      JOIN ci_files f ON f.id = src.file_id JOIN ci_repos r ON r.id = f.repo_id
      JOIN ci_symbols t ON t.id = e.target_id
      WHERE r.name = ${repo.name} AND src.qualified_name = 'p.Ov.caller'
        AND t.qualified_name = 'p.Ov.same' AND e.kind = 'calls'`;
    expect(edge.target_id).toBe(ids[0].id);
  });
});

/**
 * A local named class is a container symbol: calls in its methods belong to the
 * outermost callable inside that class, so unqualified and `this` calls resolve against
 * the local class, not the host method's class.
 */
describe.skipIf(!RUN)("owner bounded by the innermost container", () => {
  let repo: FixtureRepo;

  const pairs = async () =>
    (await repo.edges("calls")).map((e) => `${e.source}->${e.target}`);

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/A.java": `package p;

class A {
    void host() {
        class Local {
            void m() { helper(); this.other(); }
            void helper() {}
            void other() {}
        }
    }
    void helper() {}
}
`,
      "src/main/kotlin/p/KL.kt": `package p

class KL {
    fun host() {
        class Loc {
            fun m() { aux() }
            fun aux() = 1
        }
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("Java: calls in a local class method resolve against the local class", async () => {
    const edges = await pairs();
    expect(edges.filter((e) => e.startsWith("p.A."))).toEqual([
      expect.stringMatching(/Local\.m->.*Local\.helper$/),
      expect.stringMatching(/Local\.m->.*Local\.other$/),
    ]);
  });

  test("Kotlin: a call in a local class method resolves against the local class", async () => {
    const edges = await pairs();
    expect(edges.filter((e) => e.startsWith("p.KL."))).toEqual([
      expect.stringMatching(/Loc\.m->.*Loc\.aux$/),
    ]);
  });
});
