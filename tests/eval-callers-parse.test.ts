import { describe, test, expect } from "bun:test";
import { countParams, intellijMethodName, intellijParamCount } from "../scripts/eval-callers-parse.ts";

const strip = (s: string) => s.replace(/`/g, "");

describe("intellijMethodName", () => {
  test("plain method", () => {
    expect(intellijMethodName("Foo.bar(Baz)")).toBe("bar");
    expect(intellijMethodName("Outer.Inner.bar(Map<String, Int>, (String) -> Unit)")).toBe("bar");
  });

  test("Kotlin test name with parentheses in it", () => {
    const name = "lagre med LAV parent og HØY child skal beholde child sin HØY (typen vinner)";
    expect(intellijMethodName(`KlasseTest.${name}()`)).toBe(name);
    expect(strip(intellijMethodName(`KlasseTest.\`${name}\`()`))).toBe(name);
  });

  test("Kotlin test name with a dot in it", () => {
    const name = "versjon 2.0 skal lagres";
    expect(intellijMethodName(`KlasseTest.${name}()`)).toBe(name);
    expect(strip(intellijMethodName(`KlasseTest.\`${name}\`()`))).toBe(name);
    // Dot before the first space: only the backtick marks where the name starts.
    expect(strip(intellijMethodName("KlasseTest.`versjon2.0 lagres`()"))).toBe("versjon2.0 lagres");
  });
});

describe("countParams", () => {
  test("commas inside string and char default values do not count", () => {
    expect(countParams('join(items: List<String>, sep: String = ",")')).toBe(2);
    expect(countParams("split(text: String, c: Char = ',')")).toBe(2);
    expect(countParams('f(a: String = "(", b: Int)')).toBe(2);
    expect(countParams('g(a: String = "\\",", b: Int)')).toBe(2);
  });
});

describe("intellijParamCount", () => {
  test("reads the final group, not a `(` inside a test name", () => {
    expect(intellijParamCount("KlasseTest.lagre med HØY (typen vinner)()")).toBe(0);
    expect(intellijParamCount("Foo.bar(Baz, Map<A, B>)")).toBe(2);
  });
});
