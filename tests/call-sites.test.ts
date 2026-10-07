import { describe, test, expect } from "bun:test";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "../src/indexer/parser.ts";
import { extractSymbols } from "../src/indexer/symbol-extractor.ts";
import { extractCallGraph, classifyReceiver } from "../src/indexer/call-graph.ts";
import { outermostCallableIndex } from "../src/indexer/edge-resolver.ts";

async function calls(lang: SupportedLanguage, source: string) {
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

describe("classifyReceiver", () => {
  test.each([
    [null, "none"],
    ["this", "this"],
    ["repo", "identifier"],
    ["Foo", "static-type"],
    ["Årsavregning", "static-type"],
    ["A\u030Arsavregning", "static-type"], // NFD: A + combining ring above
    ["A\u030Arsavregning.Beløp", "static-type"],
    ["Outer.Inner", "static-type"],
    ["a.b", "chain-or-expression"],
    ["Foo()", "chain-or-expression"],
    ["super", "chain-or-expression"],
    ["A.this", "chain-or-expression"],
    ["list.get(0)", "chain-or-expression"],
  ] as const)("%p → %s", (receiver, kind) => {
    expect(classifyReceiver(receiver)).toBe(kind);
  });
});

describe("argCount", () => {
  test("Kotlin: positional, trailing lambda, named and spread", async () => {
    const { calls: cs } = await calls(
      "kotlin",
      `fun f() { a.b(1, 2); g(1) { it }; h { }; k(x = 1); m(*arr); n() }`,
    );
    expect(cs.map((c) => [c.methodName, c.argCount])).toEqual([
      ["b", 2], ["g", 2], ["h", 1], ["k", null], ["m", null], ["n", 0],
    ]);
  });

  test("Java: counts arguments, ignores comments", async () => {
    const { calls: cs } = await calls(
      "java",
      `class A { void f() { a.b(1, /* c */ 2); g(); } }`,
    );
    expect(cs.map((c) => [c.methodName, c.argCount])).toEqual([["b", 2], ["g", 0]]);
  });
});

describe("outermostCallableIndex", () => {
  const owners = async (lang: SupportedLanguage, source: string) => {
    const { extraction, calls: cs } = await calls(lang, source);
    return cs.map((c) => {
      const idx = outermostCallableIndex(extraction.symbols, c.startIndex);
      return [c.methodName, idx === null ? null : extraction.symbols[idx].name];
    });
  };

  test("a call in a Kotlin local function belongs to the host function", async () => {
    expect(
      await owners(
        "kotlin",
        `class K {
    fun outer() {
        fun inner() {
            B.helper()
        }
        inner()
    }
}`,
      ),
    ).toEqual([["helper", "outer"], ["inner", "outer"]]);
  });

  test("two Java methods on one line each own their own call", async () => {
    expect(
      await owners("java", `class A { void a() { H.c(5); } void b() { H.c(6); } }`),
    ).toEqual([["c", "a"], ["c", "b"]]);
  });

  test("a call in a Java anonymous class belongs to the host method", async () => {
    expect(
      await owners(
        "java",
        `class A {\n  void outer() {\n    schedule(new Runnable() { public void run() { tick(); } });\n  }\n}`,
      ),
    ).toEqual([["schedule", "outer"], ["tick", "outer"]]);
  });

  test("a call outside any callable has no owner", async () => {
    expect(await owners("kotlin", `class K {\n    val x = B.helper()\n}`)).toEqual([["helper", null]]);
  });
});
