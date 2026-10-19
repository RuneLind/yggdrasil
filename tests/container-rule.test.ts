import { describe, test, expect } from "bun:test";
import { extract, select, diffText, type Lang } from "./helpers/select-pipeline.ts";
import { parseGitDiff } from "../src/search/diff-parse.ts";
import { parseSourceTree } from "../src/search/container-rule.ts";
import { selectChangedSymbols } from "../src/search/detect-changes.ts";

/**
 * The container rule's state space as a table: {modified, inserted} × the class-body node
 * a hit falls in × {Kotlin, Java}. Each row edits the base file (string replacements, in
 * reverse order), runs diff → base-side ranges → selectChangedSymbols, and states the changed
 * symbols and why each kept container stayed (the hit kind, or "floor").
 *
 * Most rows also edit a method (`ctl`), so the floor never applies and the row shows the
 * classification alone; the floor rows leave it out.
 */
const K_BASE = `package p

import q.Base

/** K doc. */
@Service
class K(
    private val a: Int,
) : Base() {
    private val names = listOf(
        "a",
    )
    @field:JsonProperty("x") val x = 1
    @javax.inject.Inject lateinit var z: Foo
    @Size(max = X.max()) val w = 2
    val t: Int get() = a + 1
    @get:JsonIgnore val g: Int
        get() = a + 2

    init {
        println("init")
    }

    fun m(): Int {
        return a
    }

    // kommentar

    inner class N {
        fun n() = 1
    }

    companion object {
        const val Q = 1
        fun f() = 1
    }

    fun last(): Int {
        return 2
    }
}

interface I {
    fun im(): Int
}

abstract class A {
    abstract fun am(): Int
    fun body() = 1
}
`;

const J_BASE = `package p;

import java.util.Map;

@Service
public class J extends B implements I {
    private int retries = 3; // max
    private static final Map<String, Integer> M = Map.of(
        "a", 1
    );
    private Foo f =
        new Foo();

    static {
        init();
    }

    {
        setup();
    }

    J(int a) {
        this.a = a;
    }

    void m() {
        run();
    }

    /* kommentar */

    class N {
        void n() {}
    }

    void last() {
        done();
    }

    private static final List<String> L = List.of(
        "x"
    );
}

interface JI {
    int jm();
}

abstract class JA {
    abstract void ja();
    void jb() {}
}

enum JE {
    ONE,
    TWO;
    void q() {}
}
`;

type Edit = [string, string];
const K_CTL: Edit = ["        return a\n", "        return a + 0\n"];
const A_CTL: Edit = ["fun body() = 1", "fun body() = 2"];
const J_CTL: Edit = ["        run();\n", "        run(1);\n"];
const JA_CTL: Edit = ["void jb() {}", "void jb() { x(); }"];
const K_AFTER_M = "        return a\n    }\n";
const J_AFTER_M = "        run();\n    }\n";
/** Insert `text` after `anchor` (the anchor itself stays). */
const after = (anchor: string, text: string): Edit => [anchor, anchor + text];

interface Row {
  name: string;
  lang: Lang;
  edits: Edit[];
  changed: string[];
  kept: Record<string, string>;
}

const k = (name: string, edits: Edit[], changed: string[], kept: Record<string, string> = {}): Row => ({ name, lang: "kotlin", edits, changed, kept });
const j = (name: string, edits: Edit[], changed: string[], kept: Record<string, string> = {}): Row => ({ name, lang: "java", edits, changed, kept });

const ROWS: Row[] = [
  // Kotlin, modified
  k("modified property initializer (multi-line listOf)", [K_CTL, ['        "a",\n', '        "b",\n']], ["K", "K.m", "K.names"], { K: "state" }),
  k("modified property with use-site annotation", [K_CTL, ['@field:JsonProperty("x")', '@field:JsonProperty("y")']], ["K", "K.m", "K.x"], { K: "state" }),
  k("modified property with qualified annotation", [K_CTL, ["lateinit var z: Foo", "lateinit var z: Bar"]], ["K", "K.m", "K.z"], { K: "state" }),
  k("modified property with nested-paren annotation", [K_CTL, ["X.max()) val w", "X.min()) val w"]], ["K", "K.m", "K.w"], { K: "state" }),
  k("modified one-line computed property", [K_CTL, ["get() = a + 1", "get() = a + 3"]], ["K.m", "K.t"]),
  k("modified annotated computed property", [K_CTL, ["get() = a + 2", "get() = a + 4"]], ["K.g", "K.m"]),
  k("modified init block", [K_CTL, ['println("init")', 'println("start")']], ["K", "K.m"], { K: "state" }),
  k("modified class header (supertypes)", [K_CTL, [") : Base() {", ") : Base(), Marker {"]], ["K", "K.m"], { K: "header" }),
  k("modified primary constructor", [K_CTL, ["private val a: Int,", "private val a: Long,"]], ["K", "K.m"], { K: "header" }),
  k("modified class annotation", [K_CTL, ["@Service\nclass K", "@Component\nclass K"]], ["K", "K.m"], { K: "header" }),
  k("modified method", [K_CTL], ["K.m"]),
  k("modified method in a nested class", [K_CTL, ["fun n() = 1", "fun n() = 2"]], ["K.N.n", "K.m"]),
  k("modified comment", [K_CTL, ["// kommentar", "// endret"]], ["K.m"]),
  k("modified KDoc above the class (outside every symbol)", [["K doc.", "K docs."]], []),
  k("modified companion constant", [K_CTL, ["const val Q = 1", "const val Q = 2"]], ["K", "K.Q", "K.m"], { K: "state" }),
  k("modified companion function", [K_CTL, ["fun f() = 1", "fun f() = 2"]], ["K.f", "K.m"]),
  k("modified abstract interface method", [A_CTL, ["fun im(): Int", "fun im(): Long"]], ["A.body", "I", "I.im"], { I: "contract" }),
  // Kotlin, inserted
  k("inserted stored property", [K_CTL, after(K_AFTER_M, "    val ny = 5\n")], ["K", "K.m"], { K: "state" }),
  k("inserted property with multi-line initializer", [K_CTL, after(K_AFTER_M, '    private val more = listOf(\n        "b",\n    )\n')], ["K", "K.m"], { K: "state" }),
  k("inserted property with use-site annotation", [K_CTL, after(K_AFTER_M, '    @field:JsonProperty("y") val y = 2\n')], ["K", "K.m"], { K: "state" }),
  k("inserted computed property with use-site annotation", [K_CTL, after(K_AFTER_M, "    @get:JsonIgnore val h: Int get() = 1\n")], ["K.m"]),
  k("inserted property with qualified annotation", [K_CTL, after(K_AFTER_M, "    @javax.inject.Inject lateinit var r: Repo\n")], ["K", "K.m"], { K: "state" }),
  k("inserted property with nested-paren annotation", [K_CTL, after(K_AFTER_M, "    @Size(max = X.max()) val v = 3\n")], ["K", "K.m"], { K: "state" }),
  k("inserted stored property with a getter", [K_CTL, after(K_AFTER_M, "    var teller: Int = 0\n        get() = field\n")], ["K", "K.m"], { K: "state" }),
  k("inserted delegated property", [K_CTL, after(K_AFTER_M, "    val lat by lazy { 1 }\n")], ["K", "K.m"], { K: "state" }),
  k("inserted one-line computed property without type", [K_CTL, after(K_AFTER_M, "    val u get() = a + 9\n")], ["K.m"]),
  k("inserted entry in a listOf initializer", [K_CTL, after('        "a",\n', '        "b",\n')], ["K", "K.m", "K.names"], { K: "state" }),
  k("inserted init block", [K_CTL, after(K_AFTER_M, '\n    init {\n        println("2")\n    }\n')], ["K", "K.m"], { K: "state" }),
  k("inserted line inside init block", [K_CTL, after('        println("init")\n', '        println("mer")\n')], ["K", "K.m"], { K: "state" }),
  k("inserted primary constructor parameter", [K_CTL, after("    private val a: Int,\n", "    private val b: Int,\n")], ["K", "K.m"], { K: "header" }),
  k("inserted class annotation", [K_CTL, after("@Service\n", "@Validated\n")], ["K", "K.m"], { K: "header" }),
  k("inserted method between members", [K_CTL, after(K_AFTER_M, "\n    fun ny(): Int {\n        return 3\n    }\n")], ["K.m"]),
  k("inserted method before the first child", [K_CTL, after(") : Base() {\n", "    fun foerst() = 0\n")], ["K.m"]),
  k("inserted nested class with a field", [K_CTL, after(K_AFTER_M, "\n    class Q2 {\n        val q = 1\n    }\n")], ["K.m"]),
  k("inserted comment", [K_CTL, after(K_AFTER_M, "    // ny kommentar\n")], ["K.m"]),
  k("inserted blank line", [K_CTL, after(K_AFTER_M, "\n")], ["K.m"]),
  k("inserted block comment mentioning val", [K_CTL, after(K_AFTER_M, "    /*\n     * the val here\n     */\n")], ["K.m"]),
  k("inserted raw string with `var` inside a method", [after("        return a\n", '        val sql = """\n            update t set var = 1\n        """\n')], ["K.m"]),
  k("inserted `fun open() = \"{\"` then a property", [K_CTL, after(K_AFTER_M, '    fun open() = "{"\n    val bx = 1\n')], ["K", "K.m"], { K: "state" }),
  k("inserted `fun open() = \"{\"` then a method", [K_CTL, after(K_AFTER_M, '    fun open() = "{"\n    fun close() = 1\n')], ["K.m"]),
  k("inserted annotation above a method", [["    fun m(): Int {\n", '    @Deprecated("x")\n    fun m(): Int {\n']], ["K.m"]),
  k("inserted annotation above a stored property", [K_CTL, ["    @Size(max", "    @Valid\n    @Size(max"]], ["K", "K.m", "K.w"], { K: "state" }),
  k("inserted abstract method in an interface", [A_CTL, after("    fun im(): Int\n", "    fun im2(): Int\n")], ["A.body", "I"], { I: "contract" }),
  k("inserted default method in an interface", [A_CTL, after("    fun im(): Int\n", "    fun d() = 1\n")], ["A.body"]),
  k("inserted abstract method in an abstract class", [K_CTL, after("    abstract fun am(): Int\n", "    abstract fun am2(): Int\n")], ["A", "K.m"], { A: "contract" }),
  // Kotlin, floor: no member flagged, so the innermost container stays
  k("floor: only a comment changed", [["// kommentar", "// endret"]], ["K"], { K: "floor" }),
  k("floor: only a blank line changed", [["        get() = a + 2\n\n", "        get() = a + 2\n    \n"]], ["K"], { K: "floor" }),
  k("floor: only a method inserted", [after(K_AFTER_M, "\n    fun ny() = 3\n")], ["K"], { K: "floor" }),
  k("floor: only a method inserted directly above another method", [["    fun m(): Int {\n", "    fun ny() = 3\n    fun m(): Int {\n"]], ["K"], { K: "floor" }),
  k("floor: only a comment inserted in a nested class", [after("    inner class N {\n", "        // ny\n")], ["K.N"], { "K.N": "floor" }),

  // Java, modified
  j("modified field with trailing comment", [J_CTL, ["retries = 3; // max", "retries = 4; // max"]], ["J", "J.m"], { J: "state" }),
  j("modified entry in a Map.of field", [J_CTL, ['"a", 1', '"a", 2']], ["J", "J.m"], { J: "state" }),
  j("modified second line of a multi-line initializer", [J_CTL, ["new Foo();", "new Foo(1);"]], ["J", "J.m"], { J: "state" }),
  j("modified static block", [J_CTL, ["init();", "init(2);"]], ["J", "J.m"], { J: "state" }),
  j("modified instance initializer", [J_CTL, ["setup();", "setup(2);"]], ["J", "J.m"], { J: "state" }),
  j("modified class header", [J_CTL, ["extends B implements", "extends C implements"]], ["J", "J.m"], { J: "header" }),
  j("modified class annotation", [J_CTL, ["@Service", "@Component"]], ["J", "J.m"], { J: "header" }),
  j("modified constructor", [J_CTL, ["this.a = a;", "this.a = a + 1;"]], ["J.J", "J.m"]),
  j("modified method", [J_CTL], ["J.m"]),
  j("modified comment", [J_CTL, ["/* kommentar */", "/* endret */"]], ["J.m"]),
  j("modified method in a nested class", [J_CTL, ["void n() {}", "void n() { x(); }"]], ["J.N.n", "J.m"]),
  j("modified method in an enum", [J_CTL, ["void q() {}", "void q() { x(); }"]], ["J.m", "JE.q"]),
  j("modified enum constant", [["    ONE,\n", "    UNO,\n"], ["void q() {}", "void q() { x(); }"]], ["JE", "JE.q"], { JE: "state" }),
  // Java, inserted
  j("inserted field", [J_CTL, after(J_AFTER_M, "    private int x = 1;\n")], ["J", "J.m"], { J: "state" }),
  j("inserted field with trailing comment", [J_CTL, after(J_AFTER_M, "    private int y = 2; // y\n")], ["J", "J.m"], { J: "state" }),
  j("inserted multi-line initializer", [J_CTL, after(J_AFTER_M, "    private Foo g =\n        new Foo();\n")], ["J", "J.m"], { J: "state" }),
  j("inserted entry in a Map.of field", [J_CTL, after("Map.of(\n", '        "b", 2,\n')], ["J", "J.m"], { J: "state" }),
  j("inserted entry in a List.of field after the methods", [J_CTL, after("List.of(\n", '        "y",\n')], ["J", "J.m"], { J: "state" }),
  j("inserted static block", [J_CTL, after(J_AFTER_M, "\n    static {\n        more();\n    }\n")], ["J", "J.m"], { J: "state" }),
  j("inserted line inside a static block", [J_CTL, after("        init();\n", "        more();\n")], ["J", "J.m"], { J: "state" }),
  j("inserted instance initializer", [J_CTL, after(J_AFTER_M, "\n    {\n        more();\n    }\n")], ["J", "J.m"], { J: "state" }),
  j("inserted method", [J_CTL, after(J_AFTER_M, "\n    void ny() {\n        x();\n    }\n")], ["J.m"]),
  j("inserted nested class with a field", [J_CTL, after(J_AFTER_M, "\n    class Q {\n        int q = 1;\n    }\n")], ["J.m"]),
  j("inserted comment", [J_CTL, after(J_AFTER_M, "    // ny\n")], ["J.m"]),
  j("inserted annotation above a method", [["    void m() {\n", "    @Override\n    void m() {\n"]], ["J.m"]),
  j("inserted abstract method in an interface", [JA_CTL, after("    int jm();\n", "    int jm2();\n")], ["JA.jb", "JI"], { JI: "contract" }),
  j("inserted default method in an interface", [JA_CTL, after("    int jm();\n", "    default int jd() { return 1; }\n")], ["JA.jb"]),
  j("inserted abstract method in an abstract class", [J_CTL, after("    abstract void ja();\n", "    abstract void jb2();\n")], ["J.m", "JA"], { JA: "contract" }),
  j("inserted enum constant", [after("    ONE,\n", "    THREE,\n"), ["void q() {}", "void q() { x(); }"]], ["JE", "JE.q"], { JE: "state" }),
  // Java, floor
  j("floor: only a blank line inserted", [after(J_AFTER_M, "\n")], ["J"], { J: "floor" }),
];

/** Applied last to first, so the `ctl` edit (listed first) does not move the other edits' anchors. */
const apply = (base: string, edits: Edit[]) =>
  [...edits].reverse().reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`edit anchor not found: ${JSON.stringify(from)}`);
    return text.replace(from, to);
  }, base);

const short = (qn: string) => qn.replace(/^p\./, "");

describe("container rule state space", () => {
  for (const row of ROWS) {
    test(`${row.lang}: ${row.name}`, async () => {
      const base = row.lang === "kotlin" ? K_BASE : J_BASE;
      const head = apply(base, row.edits);
      expect(head).not.toBe(base);
      const { changed, kept } = await select(row.lang, base, head);
      expect({ changed: changed.map(short).sort(), kept: Object.fromEntries(Object.entries(kept).map(([q, r]) => [short(q), r])) }).toEqual({
        changed: [...row.changed].sort(),
        kept: row.kept,
      });
    });
  }
});

/**
 * Without the head file (unreadable, or its container renamed), an insertion is classified
 * by the base node it falls inside alone; one between members has no kind and drops.
 */
describe("container rule on the base file alone", () => {
  const run = async (edits: Edit[]) => {
    const head = apply(K_BASE, edits);
    const { text, path } = await diffText("kotlin", K_BASE, head);
    const symbols = await extract("kotlin", K_BASE, path);
    const indexed = await parseSourceTree("F.kt", K_BASE);
    try {
      const { changed, reasons } = selectChangedSymbols([
        { symbols, ranges: parseGitDiff(text).baseFiles.get(path) ?? [], indexed, head: null },
      ]);
      return { changed: changed.map((x) => short(x.qualified_name)).sort(), kept: Object.fromEntries([...reasons].map(([id, r]) => [short(symbols[Number(id)].qualified_name), r])) };
    } finally {
      indexed?.delete();
    }
  };

  test("an insertion inside an init block keeps the class", async () => {
    expect(await run([K_CTL, after('        println("init")\n', '        println("mer")\n')])).toEqual({ changed: ["K", "K.m"], kept: { K: "state" } });
  });

  test("an insertion inside a property initializer keeps the class", async () => {
    expect(await run([K_CTL, after('        "a",\n', '        "b",\n')])).toEqual({ changed: ["K", "K.m", "K.names"], kept: { K: "state" } });
  });

  test("an insertion inside the primary constructor keeps the class", async () => {
    expect(await run([K_CTL, after("    private val a: Int,\n", "    private val b: Int,\n")])).toEqual({ changed: ["K", "K.m"], kept: { K: "header" } });
  });

  test("an insertion between members has no kind: the class drops", async () => {
    expect(await run([K_CTL, after(K_AFTER_M, "    val ny = 5\n")])).toEqual({ changed: ["K.m"], kept: {} });
  });
});
