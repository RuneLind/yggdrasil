/**
 * Argument-type narrowing among arity-compatible overloads. Types are canonical simple
 * names (see canonicalType); `#int` is an integer literal without a suffix; null is
 * unknown and fits anything (a type parameter, an array, a lambda, an unknown argument).
 */

const BOXED: Record<string, string> = {
  Long: "long", Integer: "int", Int: "int", Short: "short", Byte: "byte", Boolean: "boolean",
  Character: "char", Char: "char", Double: "double", Float: "float",
};

/** `java.lang.Long` → `long`, `Outer.Inner` → `Inner`: the simple name, boxed twins folded. */
export function canonicalType(normalized: string): string {
  const simple = normalized.slice(normalized.lastIndexOf(".") + 1);
  return BOXED[simple] ?? simple;
}

/** Java widening conversions (Kotlin has none, but they only add candidates). */
const WIDENS_TO: Record<string, readonly string[]> = {
  byte: ["short", "int", "long", "float", "double"],
  short: ["int", "long", "float", "double"],
  char: ["int", "long", "float", "double"],
  int: ["long", "float", "double"],
  long: ["float", "double"],
  float: ["double"],
  double: [],
  boolean: [],
  "#int": ["int", "long", "short", "byte"],
};
const NUMERIC_SUPERS = ["Number", "Comparable", "Serializable"];
/** Supertypes of the final built-ins whose whole hierarchy is known. */
const KNOWN_SUPERS: Record<string, readonly string[]> = {
  String: ["CharSequence", "Comparable", "Serializable"],
  boolean: ["Comparable", "Serializable"],
  char: ["Comparable", "Serializable"],
};

export interface TypeContext {
  isRepoClass(name: string): boolean;
  /** Simple names of every supertype of the repo classes named `name` (resolved or not). */
  supertypes(name: string): ReadonlySet<string> | undefined;
}

/**
 * How an argument fits a parameter: 0 not at all, 2 certainly, 1 only possibly (a class
 * argument to an external parameter type that is not among its known supertypes).
 */
export function argFit(arg: string | null, param: string | null, ctx: TypeContext): 0 | 1 | 2 {
  if (arg === null || param === null || arg === param) return 2;
  if (param === "Object" || param === "Any") return 2;
  const widens = WIDENS_TO[arg];
  if (widens) {
    return widens.includes(param) || (KNOWN_SUPERS[arg] ?? NUMERIC_SUPERS).includes(param) ? 2 : 0;
  }
  if (arg === "String") return KNOWN_SUPERS.String.includes(param) ? 2 : 0;
  // A class argument: never a primitive or a String parameter (boxed twins are folded).
  if (param in WIDENS_TO || param === "String") return 0;
  if (ctx.supertypes(arg)?.has(param)) return 2;
  // A repo class parameter only takes its own subclasses, which are all in the repo.
  if (ctx.isRepoClass(param)) return 0;
  // An external parameter: a supertype of a supertype may be outside the repo.
  return 1;
}

export function argFits(arg: string | null, param: string | null, ctx: TypeContext): boolean {
  return argFit(arg, param, ctx) > 0;
}

export interface OverloadSite {
  argTypes: (string | null)[] | null;
  argNames: (string | null)[] | null;
}

export interface OverloadCandidate {
  paramTypes: (string | null)[] | null;
  paramNames: (string | null)[] | null;
}

/**
 * The weakest fit over the site's arguments (see argFit): positional arguments by
 * position, named ones by parameter name (which must exist, else 0). Positions past the
 * declared parameters (a vararg's tail, a trailing lambda) are wildcards.
 */
function fit(site: OverloadSite, c: OverloadCandidate, ctx: TypeContext): 0 | 1 | 2 {
  let weakest: 0 | 1 | 2 = 2;
  const n = Math.max(site.argTypes?.length ?? 0, site.argNames?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const name = site.argNames?.[i] ?? null;
    let at = i;
    if (name !== null) {
      at = c.paramNames?.indexOf(name) ?? -1;
      if (at < 0) return 0;
    }
    const f = argFit(site.argTypes?.[i] ?? null, c.paramTypes?.[at] ?? null, ctx);
    if (f === 0) return 0;
    if (f < weakest) weakest = f;
  }
  return weakest;
}

/**
 * The candidates whose parameters fit the site's known argument types and names, only
 * the certain fits when there are any; every candidate when nothing is known or nothing
 * fits.
 */
export function narrowOverloads<T extends OverloadCandidate>(site: OverloadSite, candidates: T[], ctx: TypeContext): T[] {
  const known = site.argTypes?.some((t) => t !== null) || site.argNames?.some((n) => n !== null);
  if (!known || candidates.length < 2) return candidates;
  const fits = candidates.map((c) => fit(site, c, ctx));
  const best = Math.max(...fits);
  return best === 0 ? candidates : candidates.filter((_, i) => fits[i] === best);
}
