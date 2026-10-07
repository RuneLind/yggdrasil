import { describe, test, expect } from "bun:test";
import { initParser, loadLanguage, parseSource, type SupportedLanguage } from "../src/indexer/parser.ts";
import { extractSymbols } from "../src/indexer/symbol-extractor.ts";
import { extractCallGraph, classifyReceiver } from "../src/indexer/call-graph.ts";
import { innermostCallableIndex } from "../src/indexer/edge-resolver.ts";

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
    const byName = Object.fromEntries(cs.map((c) => [c.methodName, c.argCount]));
    expect(byName).toEqual({ b: 2, g: 2, h: 1, k: null, m: null, n: 0 });
  });

  test("Java: counts arguments, ignores comments", async () => {
    const { calls: cs } = await calls(
      "java",
      `class A { void f() { a.b(1, /* c */ 2); g(); } }`,
    );
    expect(cs.map((c) => [c.methodName, c.argCount])).toEqual([["b", 2], ["g", 0]]);
  });
});

describe("innermostCallableIndex", () => {
  test("a call in a Kotlin local function belongs to the local function only", async () => {
    const { extraction, calls: cs } = await calls(
      "kotlin",
      `class K {
    fun outer() {
        fun inner() {
            B.helper()
        }
        inner()
    }
}`,
    );
    const owner = (method: string) => {
      const call = cs.find((c) => c.methodName === method)!;
      const idx = innermostCallableIndex(extraction.symbols, call.line);
      return idx === null ? null : extraction.symbols[idx].name;
    };
    expect(owner("helper")).toBe("inner");
    expect(owner("inner")).toBe("outer");
  });

  test("a call outside any callable has no owner", async () => {
    const { extraction, calls: cs } = await calls("kotlin", `class K {\n    val x = B.helper()\n}`);
    expect(innermostCallableIndex(extraction.symbols, cs[0].line)).toBeNull();
  });
});
