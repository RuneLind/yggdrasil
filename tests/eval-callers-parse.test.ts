import { describe, test, expect } from "bun:test";
import { countParams, declaredParamCount, intellijMethodName, intellijParamCount, intellijParamTypes } from "../scripts/eval-callers-parse.ts";

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

describe("declaredParamCount", () => {
  test("all parameters when there is no vararg", () => {
    expect(declaredParamCount(2, 3)).toBe(3);
  });

  test("required parameters plus the vararg", () => {
    expect(declaredParamCount(1, null)).toBe(2);
  });

  test("unknown without min_params", () => {
    expect(declaredParamCount(null, null)).toBeNull();
  });
});

describe("intellijParamTypes", () => {
  test("simple names, generics and nullability stripped, boxed twins folded", () => {
    expect(intellijParamTypes("Foo.bar(String, Int, Instant?)")).toEqual(["String", "int", "Instant"]);
    expect(intellijParamTypes("landErEessiReady(String, Collection<Land_iso2>)")).toEqual(["String", "Collection"]);
    expect(intellijParamTypes("hentPersonMedHistorikk(long)")).toEqual(["long"]);
    expect(intellijParamTypes("f(OppgaveMigrering.Options, Map<A, B>)")).toEqual(["Options", "Map"]);
    expect(intellijParamTypes("g()")).toEqual([]);
  });

  test("a type that is not an identifier path is unknown", () => {
    expect(intellijParamTypes("f((String) -> Unit, int[])")).toEqual([null, null]);
  });
});
