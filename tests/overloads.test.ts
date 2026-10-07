import { describe, test, expect } from "bun:test";
import { argFits, canonicalType, narrowOverloads, type TypeContext } from "../src/indexer/overloads.ts";

/** Repo classes: Behandling extends BaseEntity implements Serializable; BaseEntity. */
const CTX: TypeContext = {
  isRepoClass: (n) => n === "Behandling" || n === "BaseEntity",
  supertypes: (n) => (n === "Behandling" ? new Set(["BaseEntity", "Serializable"]) : undefined),
};

describe("canonicalType", () => {
  test.each([
    ["Long", "long"], ["java.lang.Long", "long"], ["Integer", "int"], ["Int", "int"], ["Boolean", "boolean"],
    ["Character", "char"], ["Char", "char"], ["Short", "short"], ["Byte", "byte"], ["Double", "double"],
    ["Float", "float"], ["java.util.List", "List"], ["Outer.Inner", "Inner"], ["String", "String"],
  ])("%s → %s", (text, canonical) => {
    expect(canonicalType(text)).toBe(canonical);
  });
});

describe("argFits", () => {
  test.each([
    [null, "long", true, "unknown argument"],
    ["long", null, true, "unknown parameter (type parameter)"],
    ["long", "long", true, "equal"],
    ["#int", "long", true, "integer literal to long"],
    ["#int", "byte", true, "integer literal to byte"],
    ["#int", "String", false, "integer literal to String"],
    ["#int", "double", false, "integer literal to double"],
    ["long", "int", false, "no narrowing"],
    ["int", "long", true, "widening"],
    ["String", "Object", true, "anything to Object"],
    ["Behandling", "Any", true, "anything to Any"],
    ["String", "CharSequence", true, "String's supertype"],
    ["String", "Collection", false, "String to an external class"],
    ["List", "String", false, "external class to String"],
    ["Behandling", "long", false, "class to primitive"],
    ["Behandling", "BaseEntity", true, "repo supertype"],
    ["Behandling", "Serializable", true, "external supertype from the clause"],
    ["BaseEntity", "Behandling", false, "repo class to its subclass"],
    ["ArrayList", "List", true, "external to external: unknown, so it fits"],
    ["LocalDate", "BaseEntity", false, "external class to a repo class"],
    ["Behandling", "Comparable", true, "repo class to an external class it may implement transitively"],
  ] as const)("%p → %p: %p (%s)", (arg, param, fits) => {
    expect(argFits(arg, param, CTX)).toBe(fits);
  });
});

describe("narrowOverloads", () => {
  const LONG = { id: "long", paramTypes: ["long", "String"], paramNames: ["id", "status"] };
  const OBJ = { id: "obj", paramTypes: ["Behandling", "String"], paramNames: ["behandling", "status"] };

  test("keeps the overloads whose known argument types fit", () => {
    expect(narrowOverloads({ argTypes: ["long", "String"], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["long"]);
  });

  test("nothing known keeps every candidate", () => {
    expect(narrowOverloads({ argTypes: [null, null], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["long", "obj"]);
  });

  test("when nothing fits, every candidate stays", () => {
    expect(narrowOverloads({ argTypes: ["boolean", null], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual([
      "long",
      "obj",
    ]);
  });

  test("a named argument needs a parameter of that name, and is typed against it", () => {
    expect(narrowOverloads({ argTypes: [null], argNames: ["behandling"] }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["obj"]);
    expect(
      narrowOverloads({ argTypes: [null, "long"], argNames: ["status", "id"] }, [LONG, OBJ], CTX).map((c) => c.id),
    ).toEqual(["long"]);
  });

  test("a trailing argument past the declared parameters (vararg, trailing lambda) is a wildcard", () => {
    expect(narrowOverloads({ argTypes: ["long", "String", "#int"], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual([
      "long",
    ]);
  });

  test("a certain fit beats a possible one (an external parameter type)", () => {
    const EXTERNAL = { id: "ext", paramTypes: ["WebClientResponseException"], paramNames: ["e"] };
    const OWN = { id: "own", paramTypes: ["BaseEntity"], paramNames: ["e"] };
    expect(narrowOverloads({ argTypes: ["Behandling"], argNames: null }, [EXTERNAL, OWN], CTX).map((c) => c.id)).toEqual(["own"]);
    expect(narrowOverloads({ argTypes: ["LocalDate"], argNames: null }, [EXTERNAL, OWN], CTX).map((c) => c.id)).toEqual(["ext"]);
  });
});
