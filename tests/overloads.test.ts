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
    ["int", "long", false, "Kotlin has no widening"],
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
    expect(argFits(arg, param, CTX, "kotlin")).toBe(fits);
  });

  // A Java int literal widens to long, float and double, never to short or byte (outside
  // a constant assignment); a Kotlin one takes Int, Long, Short or Byte by expected type.
  test.each([
    ["java", "double", true], ["java", "float", true], ["java", "long", true], ["java", "int", true],
    ["java", "short", false], ["java", "byte", false],
    ["kotlin", "double", false], ["kotlin", "float", false], ["kotlin", "short", true], ["kotlin", "byte", true],
  ] as const)("%s integer literal → %s: %p", (lang, param, fits) => {
    expect(argFits("#int", param, CTX, lang)).toBe(fits);
  });
});

describe("narrowOverloads", () => {
  const LONG = { id: "long", paramTypes: ["long", "String"], paramNames: ["id", "status"] };
  const OBJ = { id: "obj", paramTypes: ["Behandling", "String"], paramNames: ["behandling", "status"] };

  test("keeps the overloads whose known argument types fit", () => {
    expect(narrowOverloads({ language: "java", argTypes: ["long", "String"], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["long"]);
  });

  test("nothing known keeps every candidate", () => {
    expect(narrowOverloads({ language: "java", argTypes: [null, null], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["long", "obj"]);
  });

  test("when nothing fits, every candidate stays", () => {
    expect(narrowOverloads({ language: "java", argTypes: ["boolean", null], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual([
      "long",
      "obj",
    ]);
  });

  test("a named argument needs a parameter of that name, and is typed against it", () => {
    expect(narrowOverloads({ language: "java", argTypes: [null], argNames: ["behandling"] }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual(["obj"]);
    expect(
      narrowOverloads({ language: "java", argTypes: [null, "long"], argNames: ["status", "id"] }, [LONG, OBJ], CTX).map((c) => c.id),
    ).toEqual(["long"]);
  });

  test("a trailing argument past the declared parameters (vararg, trailing lambda) is a wildcard", () => {
    expect(narrowOverloads({ language: "java", argTypes: ["long", "String", "#int"], argNames: null }, [LONG, OBJ], CTX).map((c) => c.id)).toEqual([
      "long",
    ]);
  });

  test("a certain fit beats a possible one (an external parameter type)", () => {
    const EXTERNAL = { id: "ext", paramTypes: ["WebClientResponseException"], paramNames: ["e"] };
    const OWN = { id: "own", paramTypes: ["BaseEntity"], paramNames: ["e"] };
    expect(narrowOverloads({ language: "java", argTypes: ["Behandling"], argNames: null }, [EXTERNAL, OWN], CTX).map((c) => c.id)).toEqual(["own"]);
    expect(narrowOverloads({ language: "java", argTypes: ["LocalDate"], argNames: null }, [EXTERNAL, OWN], CTX).map((c) => c.id)).toEqual(["ext"]);
  });
});

describe("a catch-all parameter never beats a more specific compatible one", () => {
  const one = (id: string, type: string) => ({ id, paramTypes: [type], paramNames: ["x"] });
  const ids = (argType: string, cands: ReturnType<typeof one>[], lang: "java" | "kotlin" = "java") =>
    narrowOverloads({ argTypes: [argType], argNames: null, language: lang }, cands, CTX).map((c) => c.id).sort();

  test("log(Object) and log(Throwable) with a repo exception whose supertype is external keep both", () => {
    const ctx: TypeContext = { isRepoClass: (n) => n === "MyEx", supertypes: (n) => (n === "MyEx" ? new Set(["RuntimeException"]) : undefined) };
    const kept = narrowOverloads({ argTypes: ["MyEx"], argNames: null, language: "java" }, [one("obj", "Object"), one("thr", "Throwable")], ctx);
    expect(kept.map((c) => c.id).sort()).toEqual(["obj", "thr"]);
  });

  test("c(Collection) and c(Object) with a List keep both", () => {
    expect(ids("List", [one("coll", "Collection"), one("obj", "Object")])).toEqual(["coll", "obj"]);
  });

  test("an exact or known-supertype match still beats Object / Any", () => {
    expect(ids("Behandling", [one("base", "BaseEntity"), one("obj", "Object")])).toEqual(["base"]);
    expect(ids("String", [one("str", "String"), one("any", "Any")], "kotlin")).toEqual(["str"]);
  });

  test("an Object overload whose other parameter may be the one that applies is kept", () => {
    const os = { id: "os", paramTypes: ["String", "String"], paramNames: ["json", "schema"] };
    const oi = { id: "oi", paramTypes: ["Object", "InputStream"], paramNames: ["o", "schema"] };
    expect(narrowOverloads({ argTypes: ["String", null], argNames: null, language: "java" }, [os, oi], CTX).map((c) => c.id)).toEqual(["os", "oi"]);
  });

  test("an unknown argument never lets a specific parameter beat Object", () => {
    const so = { id: "so", paramTypes: ["String", "Object"], paramNames: ["s", "o"] };
    const st = { id: "st", paramTypes: ["String", "Throwable"], paramNames: ["s", "t"] };
    expect(narrowOverloads({ argTypes: ["String", null], argNames: null, language: "java" }, [so, st], CTX).map((c) => c.id)).toEqual(["so", "st"]);
  });

  test("Java num(double) and num(Object) with num(1) keep both (a Double parameter takes no int); Kotlin keeps num(Any)", () => {
    expect(ids("#int", [one("dbl", "double"), one("obj", "Object")])).toEqual(["dbl", "obj"]);
    expect(ids("#int", [one("dbl", "double"), one("any", "Any")], "kotlin")).toEqual(["any"]);
  });
});

/**
 * Applicability by language, enumerated. Java (JLS 15.12.2): phase 1 without boxing or
 * varargs, phase 2 with boxing and unboxing, phase 3 with varargs; the first phase with an
 * applicable method picks the most specific. Kotlin: no primitive widening, an integer
 * literal fits Int, Long, Short or Byte by expected type, every value fits Any.
 *
 * Stored types fold boxed twins (Integer and int are both `int`), so a Java `int`
 * argument or parameter may be either; `#int` is a literal, certainly primitive. Where
 * the folded types cannot tell which method javac or Kotlin picks, both stay; the right
 * one is never dropped.
 */
describe("overload applicability table", () => {
  const ctx: TypeContext = {
    isRepoClass: (n) => n === "MyEx" || n === "Behandling" || n === "BaseEntity",
    supertypes: (n) =>
      n === "MyEx" ? new Set(["RuntimeException"]) : n === "Behandling" ? new Set(["BaseEntity", "Serializable"]) : undefined,
    // MyEx extends RuntimeException; Behandling extends BaseEntity implements Serializable.
    extendsChain: (n) => (n === "MyEx" ? new Set(["RuntimeException"]) : n === "Behandling" ? new Set(["BaseEntity"]) : undefined),
  };
  type Row = [lang: "java" | "kotlin", arg: string, cands: string[], kept: string[], why: string];
  // A candidate is `id:paramType`; `null` is a type parameter, array or function type;
  // a trailing `...` marks a vararg (its parameter type is stored as null).
  const rows: Row[] = [
    ["java", "int", ["obj:Object", "int:int"], ["int", "obj"], "Integer arg: a(Object) in phase 1; int arg: a(int)"],
    ["java", "#int", ["obj:Object", "long:long"], ["long", "obj"], "b(1): b(long) in phase 1 if primitive, b(Object) if Long"],
    ["java", "int", ["obj:Object", "dbl:double"], ["dbl", "obj"], "Integer arg: d(Object) in phase 1; int arg: d(double)"],
    ["java", "#int", ["dbl:double", "obj:Object"], ["dbl", "obj"], "num(1): num(double) if primitive, num(Object) if Double"],
    ["java", "#int", ["obj:Object", "int:int"], ["int"], "a(1): int in phase 1, or Integer beats Object in phase 2"],
    ["java", "String", ["obj:Object", "str:String"], ["str"], "phase 1, String is more specific"],
    ["java", "MyEx", ["t:null", "thr:Throwable"], ["t", "thr"], "<T> g(T) vs g(Throwable): g(Throwable) when MyEx is one"],
    ["java", "MyEx", ["var:null...", "thr:Throwable"], ["thr", "var"], "h(Object...) vs h(Throwable): h(Throwable) if applicable"],
    ["java", "String", ["var:null...", "str:String"], ["str"], "a fixed-arity method applicable in phase 1 hides varargs"],
    ["java", "Behandling", ["ser:Serializable", "thr:Throwable"], ["ser", "thr"], "an implemented external interface does not hide a possible class"],
    ["java", "MyEx", ["rt:RuntimeException", "thr:Throwable"], ["rt"], "an external superclass is more specific than any unknown supertype"],
    ["java", "Behandling", ["base:BaseEntity", "ext:WebClientResponseException"], ["base"], "a repo superclass beats an unrelated external class"],
    ["java", "int", ["int:int", "long:long"], ["int", "long"], "an int arg to Integer loses to long in phase 1"],
    ["java", "char", ["int:int", "str:String"], ["int"], "char widens to int"],
    ["java", "String", ["t:null", "obj:Object"], ["obj", "t"], "a type parameter never beats Object"],
    ["java", "String", ["any:Any", "obj:Object"], ["any", "obj"], "a catch-all never beats a catch-all"],
    ["kotlin", "int", ["any:Any", "long:long"], ["any"], "Kotlin: Int is not a Long"],
    ["kotlin", "#int", ["any:Any", "long:long"], ["any", "long"], "Kotlin literal: Long by expected type, or Any as Int"],
    ["kotlin", "#int", ["any:Any", "int:int"], ["int"], "Kotlin literal: Int is the most specific"],
    ["kotlin", "#int", ["dbl:double", "any:Any"], ["any"], "Kotlin literal never fits Double"],
    ["kotlin", "int", ["int:int", "long:long"], ["int"], "Kotlin: no widening"],
    ["kotlin", "String", ["str:String", "any:Any"], ["str"], "String is more specific than Any"],
    ["kotlin", "MyEx", ["t:null", "thr:Throwable"], ["t", "thr"], "a type parameter never beats a possible specific type"],
    ["kotlin", "String", ["var:null...", "str:String"], ["str", "var"], "Kotlin varargs are not phased: both stay"],
    ["kotlin", "int", ["num:Number", "any:Any"], ["num"], "Number is more specific than Any"],
  ];
  test.each(rows)("%s %s %p → %p (%s)", (lang, arg, cands, kept) => {
    const candidates = cands.map((spec) => {
      const [id, type] = spec.split(":");
      const vararg = type.endsWith("...");
      const t = vararg ? type.slice(0, -3) : type;
      return { id, paramTypes: [t === "null" ? null : t], paramNames: ["x"], vararg };
    });
    const got = narrowOverloads({ language: lang, argTypes: [arg], argNames: null }, candidates, ctx).map((c) => c.id).sort();
    expect(got).toEqual([...kept].sort());
  });

  test("an unknown argument may be an array, which a vararg method takes in phase 1", () => {
    const fixed = { id: "obj", paramTypes: ["Object", "String"], paramNames: ["o", "s"] };
    const va = { id: "var", paramTypes: [null], paramNames: ["xs"], vararg: true };
    const got = narrowOverloads({ language: "java", argTypes: [null, "String"], argNames: null }, [fixed, va], ctx);
    expect(got.map((c) => c.id).sort()).toEqual(["obj", "var"]);
  });
});
