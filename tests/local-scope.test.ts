import { describe, test, expect } from "bun:test";
import type { Node as SyntaxNode } from "web-tree-sitter";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "../src/indexer/parser.ts";
import { extractSymbols } from "../src/indexer/symbol-extractor.ts";

/** `name:isLocal` for every extracted symbol, in source order. */
async function locals(lang: SupportedLanguage, source: string): Promise<string[]> {
  await initParser();
  const language = await loadLanguage(lang);
  const tree = parseSource(source, language)!;
  try {
    return extractSymbols(source, tree, lang, language).symbols.map((s) => `${s.name}:${s.isLocal}`);
  } finally {
    tree.delete();
  }
}

/**
 * `name local|member static|- parent` for every extracted symbol, in source order, and how
 * the grammar parsed the body of the class, object or companion (`companion` when unnamed)
 * named `decl`: `class_body`, or
 * `lambda` when it read the body as a trailing lambda on the delegate.
 */
async function scopes(source: string, decl: string): Promise<{ body: string; symbols: string[] }> {
  await initParser();
  const language = await loadLanguage("kotlin");
  const tree = parseSource(source, language)!;
  try {
    const { symbols } = extractSymbols(source, tree, "kotlin", language);
    let body = "none";
    const walk = (n: SyntaxNode) => {
      const name = n.namedChildren.find((c) => c?.type === "identifier")?.text ?? (n.type === "companion_object" ? "companion" : null);
      if (["class_declaration", "object_declaration", "companion_object"].includes(n.type) && name === decl) {
        if (n.namedChildren.some((c) => c?.type === "class_body")) body = "class_body";
        else if (n.descendantsOfType("explicit_delegation").some((d) => d?.descendantsOfType("lambda_literal").some((l) => l?.endIndex === n.endIndex))) body = "lambda";
      }
      for (const c of n.namedChildren) if (c) walk(c);
    };
    walk(tree.rootNode);
    return {
      body,
      symbols: symbols.map((s) =>
        `${s.name} ${s.isLocal ? "local" : "member"} ${s.isStatic ? "static" : "-"} ${s.parentIndex === null ? "-" : symbols[s.parentIndex].name}`),
    };
  } finally {
    tree.delete();
  }
}

const OUTER_TAIL = "\n\nclass Etter {\n    fun etter() = 1\n}\n";

/**
 * One row per delegating-class shape: the delegate expression, where the class sits
 * (`last`: the file's last declaration; `followed`: another declaration follows;
 * `nested`: the last member of an enclosing class) and what its body holds.
 */
const ROWS: { name: string; src: string; decl: string; body: string; symbols: string[] }[] = [
  {
    name: "by d, last, members",
    decl: "X",
    src: `class X(private val d: I) : I by d {\n    override fun foo(): String = ""\n    val q: String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "q member - X"],
  },
  {
    name: "by d, followed, members (the grammar finds the class body)",
    decl: "X",
    src: `class X(private val d: I) : I by d {\n    override fun foo(): String = ""\n}${OUTER_TAIL}`,
    body: "class_body",
    symbols: ["X member - -", "foo member - X", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "by d, nested as the outer class's last member, one-line body",
    decl: "X",
    src: `class Outer {\n    fun f() = 1\n\n    class X(d: I) : I by d { override fun foo(): String = "" }\n}\n`,
    body: "lambda",
    symbols: ["Outer member - -", "f member - Outer", "X member - Outer", "foo member - X"],
  },
  {
    name: "by d, nested as the last member, multi-line body (the grammar finds the class body)",
    decl: "X",
    src: `class Outer {\n    class X(d: I) : I by d {\n        override fun foo(): String = ""\n    }\n}\n`,
    body: "class_body",
    symbols: ["Outer member - -", "X member - Outer", "foo member - X"],
  },
  {
    name: "by d, nested two levels deep as the last member",
    decl: "X",
    src: `class Outer {\n    class Mid {\n        class X(d: I) : I by d { override fun foo(): String = "" }\n    }\n}${OUTER_TAIL}`,
    body: "lambda",
    symbols: ["Outer member - -", "Mid member - Outer", "X member - Mid", "foo member - X", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "by make(), last",
    decl: "X",
    src: `class X : I by make() {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by d ?: Impl(), last (elvis adds a level)",
    decl: "X",
    src: `class X(d: I?) : I by d ?: Impl() {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by d ?: Impl(), followed (a compound delegate misparses it anyway)",
    decl: "X",
    src: `class X(d: I?) : I by d ?: Impl() {\n    override fun foo(): String = ""\n}${OUTER_TAIL}`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "by d ?: Impl(), nested as the last member",
    decl: "X",
    src: `class Outer {\n    class X(d: I?) : I by d ?: Impl() {\n        override fun foo(): String = ""\n    }\n}\n`,
    body: "lambda",
    symbols: ["Outer member - -", "X member - Outer", "foo member - X"],
  },
  {
    name: "by if (c) a else b, last",
    decl: "X",
    src: `class X(c: Boolean, a: I, b: I) : I by if (c) a else b {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by d ?: throw E(), last",
    decl: "X",
    src: `class X(d: I?) : I by d ?: throw IllegalStateException() {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by a plus b (infix call), last",
    decl: "X",
    src: `class X(a: J, b: J) : I by a plus b {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by a..b (rangeTo), last",
    decl: "X",
    src: `class X(a: J, b: J) : I by a..b {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by @Suppress(…) (d as I), last",
    decl: "X",
    src: `class X(d: Any) : I by @Suppress("UNCHECKED_CAST") (d as I) {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "by (object : I { … }), last: the anonymous object's members stay local",
    decl: "X",
    src: `class X : I by (object : I {\n    override fun foo(): String = "2"\n    fun loc() = 1\n}) {\n    override fun foo(): String = "1"\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo local - X", "loc local - X", "foo member - X"],
  },
  {
    name: "by (object : I { … }), followed",
    decl: "X",
    src: `class X : I by (object : I {\n    override fun foo(): String = "2"\n    fun loc() = 1\n}) {\n    override fun foo(): String = "1"\n}${OUTER_TAIL}`,
    body: "class_body",
    symbols: ["X member - -", "foo local - X", "loc local - X", "foo member - X", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "by d ?: object : I { … }, last",
    decl: "X",
    src: `class X(d: I?) : I by d ?: object : I {\n    override fun foo(): String = "2"\n    fun loc() = 1\n} {\n    override fun foo(): String = "1"\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo local - X", "loc local - X", "foo member - X"],
  },
  {
    name: "by make({ … }), last: the argument lambda stays local",
    decl: "X",
    src: `class X : I by make({ fun loc() = 1 }) {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "loc local - X", "foo member - X"],
  },
  {
    name: "by (make { … }), last: the parenthesized trailing lambda stays local",
    decl: "X",
    src: `class X : I by (make { fun loc() = 1 }) {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "loc local - X", "foo member - X"],
  },
  {
    name: "two delegations, I by d, J by e, last",
    decl: "X",
    src: `class X(d: I, e: J) : I by d, J by e {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "Base(), I by d, last",
    decl: "X",
    src: `class X(d: I) : Base(), I by d {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "generic I<T> by d, last",
    decl: "X",
    src: `class X<T>(d: I<T>) : I<T> by d {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X"],
  },
  {
    name: "object O : I by d, last",
    decl: "O",
    src: `object O : I by d {\n    override fun foo(): String = ""\n}\n`,
    body: "lambda",
    symbols: ["O member - -", "foo member - O"],
  },
  {
    name: "object O : I by Impl(), nested as the last member",
    decl: "O",
    src: `class Outer {\n    object O : I by Impl() { override fun foo(): String = "" }\n}\n`,
    body: "lambda",
    symbols: ["Outer member - -", "O member - Outer", "foo member - O"],
  },
  {
    name: "companion members, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    override fun foo(): String = ""\n\n    companion object {\n        const val C = 1\n        fun make() = 1\n    }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "C member static X", "make member static X"],
  },
  {
    name: "companion members, followed",
    decl: "X",
    src: `class X(d: I) : I by d {\n    override fun foo(): String = ""\n\n    companion object {\n        fun make() = 1\n    }\n}${OUTER_TAIL}`,
    body: "class_body",
    symbols: ["X member - -", "foo member - X", "make member static X", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "companion members, nested as the last member",
    decl: "X",
    src: `class Outer {\n    class X(d: I) : I by d {\n        override fun foo(): String = ""\n        companion object { fun make() = 1 }\n    }\n}\n`,
    body: "lambda",
    symbols: ["Outer member - -", "X member - Outer", "foo member - X", "make member static X"],
  },
  {
    name: "named companion, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    override fun foo(): String = ""\n\n    companion object Factory {\n        fun make() = 1\n    }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "make member static X"],
  },
  {
    name: "a delegating companion with a one-line body, in a class followed by another",
    decl: "companion",
    src: `class Y {\n    companion object : I by d { override fun foo(): String = "" }\n}${OUTER_TAIL}`,
    body: "lambda",
    symbols: ["Y member - -", "foo member static Y", "Etter member - -", "etter member - Etter"],
  },
  {
    name: "a named delegating companion with a multi-line body (the grammar finds the class body)",
    decl: "F",
    src: `class Y {\n    companion object F : I by d {\n        override fun foo(): String = ""\n    }\n}\n`,
    body: "class_body",
    symbols: ["Y member - -", "foo member static Y"],
  },
  {
    name: "a lambda and an anonymous object inside a member stay local, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    override fun foo(): String {\n        val p = run { fun loc() = 1; loc() }\n        val o = object : I {\n            override fun foo(): String = "3"\n        }\n        return ""\n    }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "p local - X", "loc local - X", "o local - X", "foo local - X"],
  },
  {
    name: "a lambda inside a companion member stays local, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    companion object {\n        fun make() = run { fun loc() = 1; loc() }\n    }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "make member static X", "loc local static X"],
  },
  {
    name: "an init block's local stays local, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    init {\n        val z = 1\n    }\n\n    val q = 2\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "z local - X", "q member - X"],
  },
  {
    name: "nested types in the body, last",
    decl: "X",
    src: `class X(d: I) : I by d {\n    object Inner {\n        fun a() = 1\n    }\n\n    class Nested {\n        fun b() = 1\n    }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "Inner member - X", "a member - Inner", "Nested member - X", "b member - Nested"],
  },
  {
    name: "a delegating class nested as the last member of a misparsed body",
    decl: "N",
    src: `class X(d: I) : I by d {\n    override fun foo(): String = ""\n\n    class N(e: I) : I by e { override fun foo(): String = "" }\n}\n`,
    body: "lambda",
    symbols: ["X member - -", "foo member - X", "N member - X", "foo member - N"],
  },
  {
    name: "a delegating local class keeps its members",
    decl: "L",
    src: `fun f(d: I) {\n    class L(d: I) : I by d { override fun foo(): String = "" }\n}\n`,
    body: "lambda",
    symbols: ["f member - -", "L local - -", "foo member - L"],
  },
  {
    name: "no body, by (make { … }), last: the parenthesized lambda stays local",
    decl: "X",
    src: `class X : I by (make { fun loc() = 1 })\n`,
    body: "none",
    symbols: ["X member - -", "loc local - X"],
  },
  {
    name: "not delegating: a property initializer ending in a trailing lambda keeps it local",
    decl: "Y",
    src: `class Y(a: Int?) {\n    val x = a ?: run { fun loc() = 1; loc() }\n}\n`,
    body: "class_body",
    symbols: ["Y member - -", "x member - Y", "loc local - Y"],
  },
  {
    name: "empty body, last",
    decl: "X",
    src: `class X(d: I) : I by d {}\n`,
    body: "lambda",
    symbols: ["X member - -"],
  },
  {
    name: "no body, followed by a class",
    decl: "X",
    src: `class X(d: I) : I by d${OUTER_TAIL}`,
    body: "none",
    symbols: ["X member - -", "Etter member - -", "etter member - Etter"],
  },
];

describe("is_local and is_static in delegating Kotlin classes", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      expect(await scopes(`package p\n\n${row.src}`, row.decl)).toEqual({ body: row.body, symbols: row.symbols });
    });
  }
});

describe("is_local", () => {
  test("a Java class declared in an instance initializer is local; its methods are members of it", async () => {
    const src = `package p;

public class Outer {
    {
        class Lokal implements Lager {
            public String lag() { return ""; }
        }
    }

    public String lag() { return ""; }
}
`;
    expect(await locals("java", src)).toEqual(["Outer:false", "Lokal:true", "lag:false", "lag:false"]);
  });
});
