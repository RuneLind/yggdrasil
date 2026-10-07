import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { analyzeImpact } from "../src/search/impact.ts";

/**
 * Call-site ownership and target choice, through the real indexer.
 *
 * A call site belongs to the outermost method, function or constructor whose source
 * range contains the call. Owning by line span credited a call on a line shared by two
 * callables to the later one, and gave calls inside an anonymous class, an object
 * expression or a local function to that nested callable, which has no callers.
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
 * The same fully qualified class can exist in two files (two Gradle modules). An
 * unqualified call must resolve into the caller's own file before the other module's.
 */
describe.skipIf(!RUN)("same-file preference for unqualified calls", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "mod1/src/main/java/p/Dup.java": `package p;

public class Dup {
    void helper() {}
}
`,
      "mod2/src/main/java/p/Dup.java": `package p;

public class Dup {


    void helper() {}

    void caller() { helper(); }
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
});
