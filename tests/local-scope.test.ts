import { describe, test, expect } from "bun:test";
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

describe("is_local", () => {
  // The class must be the file's last declaration: only then does the grammar read its
  // body as a trailing lambda on the delegate.
  test("members of a Kotlin class delegating to a parameter are not local", async () => {
    const src = `package p

class X(private val d: I) : I by d {

    override fun foo(): String {
        val p = run { fun loc() = 1; loc() }
        return "x"
    }

    val q: String = ""
}
`;
    expect(await locals("kotlin", src)).toEqual(["X:false", "foo:false", "p:true", "loc:true", "q:false"]);
  });

  test("members of a Kotlin object delegating to a constructor call are not local", async () => {
    const src = `package p

object O : I by Impl() {
    override fun foo(): String = ""
}
`;
    expect(await locals("kotlin", src)).toEqual(["O:false", "foo:false"]);
  });

  test("a trailing lambda inside the delegate expression stays local", async () => {
    const src = `package p

class X : I by make { fun loc() = 1 } {
    override fun foo(): String = ""
}
`;
    expect(await locals("kotlin", src)).toEqual(["X:false", "loc:true", "foo:false"]);
  });

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
