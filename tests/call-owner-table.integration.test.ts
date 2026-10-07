import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { sql } from "../src/db/connection.ts";

/**
 * Owner of a call site for every position a call can sit in, Java and Kotlin. Each call
 * targets its own sink method, so a row reads the stored owner of exactly one call site
 * (null: not stored). Rule: the outermost callable containing the call inside the
 * innermost container; when no callable inside that container contains it, the
 * outermost callable containing the container, repeated outward.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/call-owner-table.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const JAVA = `package p;

public class JHost {
    static { Sink.jStaticInit(); }
    { Sink.jInstanceInit(); }
    int field = Sink.jFieldInit();
    void body() { Sink.jBody(); }
    void lambda() { Runnable r = () -> Sink.jLambda(); }
    void anon() {
        Object o = new Object() {
            int f = Sink.jAnonField();
            void m() { Sink.jAnonMethod(); }
        };
    }
    void local() {
        class L {
            int f = Sink.jLocalField();
            { Sink.jLocalInit(); }
            void m() { Sink.jLocalMethod(); }
        }
    }
    static class Nested {
        void m() { Sink.jNested(); }
    }
}
`;

const KOTLIN = `package p

val top = Sink.kTopProperty()

class KHost {
    val prop = Sink.kPropertyInit()

    init {
        Sink.kInit()
    }

    fun body() {
        Sink.kBody()
    }

    fun lambda() {
        val f = { Sink.kLambda() }
    }

    fun objExpr() {
        val o = object : Runnable {
            val f = Sink.kObjectField()
            override fun run() {
                Sink.kObjectMethod()
            }
        }
    }

    fun localFun() {
        fun inner() {
            Sink.kLocalFunction()
        }
    }

    fun localClass() {
        class L {
            val f = Sink.kLocalField()

            init {
                Sink.kLocalInit()
            }

            fun m() {
                Sink.kLocalMethod()
            }
        }
    }

    class Nested {
        fun m() {
            Sink.kNested()
        }
    }
}

fun topFun() {
    Sink.kTopFunction()
}
`;

const OWNERS: [string, string, string | null][] = [
  ["Java", "jBody", "p.JHost.body"],
  ["Java", "jLambda", "p.JHost.lambda"],
  ["Java", "jAnonMethod", "p.JHost.anon"],
  ["Java", "jAnonField", "p.JHost.anon"],
  ["Java", "jLocalMethod", "p.JHost.L.m"],
  ["Java", "jLocalField", "p.JHost.local"],
  ["Java", "jLocalInit", "p.JHost.local"],
  ["Java", "jNested", "p.JHost.Nested.m"],
  ["Java", "jStaticInit", null],
  ["Java", "jInstanceInit", null],
  ["Java", "jFieldInit", null],
  ["Kotlin", "kBody", "p.KHost.body"],
  ["Kotlin", "kLambda", "p.KHost.lambda"],
  ["Kotlin", "kObjectMethod", "p.KHost.objExpr"],
  ["Kotlin", "kObjectField", "p.KHost.objExpr"],
  ["Kotlin", "kLocalFunction", "p.KHost.localFun"],
  ["Kotlin", "kLocalMethod", "p.KHost.L.m"],
  ["Kotlin", "kLocalField", "p.KHost.localClass"],
  ["Kotlin", "kLocalInit", "p.KHost.localClass"],
  ["Kotlin", "kNested", "p.KHost.Nested.m"],
  ["Kotlin", "kTopFunction", "p.topFun"],
  ["Kotlin", "kTopProperty", null],
  ["Kotlin", "kPropertyInit", null],
  ["Kotlin", "kInit", null],
];

describe.skipIf(!RUN)("call-site owner state space", () => {
  let repo: FixtureRepo;
  let owners: Map<string, string[]>;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/JHost.java": JAVA,
      "src/main/kotlin/p/KHost.kt": KOTLIN,
    });
    const rows = await sql<{ method_name: string; owner: string }[]>`
      SELECT cs.method_name, s.qualified_name AS owner
      FROM ci_call_sites cs JOIN ci_symbols s ON s.id = cs.source_symbol_id
      JOIN ci_files f ON f.id = cs.file_id JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repo.name}`;
    owners = new Map();
    for (const r of rows) owners.set(r.method_name, [...(owners.get(r.method_name) ?? []), r.owner]);
  });
  afterAll(async () => repo?.cleanup());

  test.each(OWNERS)("%s %s → %s", (_lang, sink, owner) => {
    expect(owners.get(sink) ?? null).toEqual(owner === null ? null : [owner]);
  });
});
