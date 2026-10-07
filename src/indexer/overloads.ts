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
};
/** An integer literal without a suffix: Java widens it; Kotlin types it by the expected type. */
const INT_LITERAL_FITS: Record<string, readonly string[]> = {
  java: ["int", "long", "float", "double"],
  kotlin: ["int", "long", "short", "byte"],
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

const CATCH_ALL: ReadonlySet<string> = new Set(["Object", "Any"]);

/**
 * How an argument fits a parameter: 0 not at all, 2 certainly, 1 only possibly (a class
 * argument to an external parameter type that is not among its known supertypes).
 */
export function argFit(arg: string | null, param: string | null, ctx: TypeContext, lang: string): 0 | 1 | 2 {
  if (arg === null || param === null || arg === param || CATCH_ALL.has(param)) return 2;
  const widens = arg === "#int" ? INT_LITERAL_FITS[lang] ?? INT_LITERAL_FITS.java : WIDENS_TO[arg];
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

export function argFits(arg: string | null, param: string | null, ctx: TypeContext, lang: string): boolean {
  return argFit(arg, param, ctx, lang) > 0;
}

export interface OverloadSite {
  argTypes: (string | null)[] | null;
  argNames: (string | null)[] | null;
  /** ci_files.language of the call site. */
  language: string;
}

export interface OverloadCandidate {
  paramTypes: (string | null)[] | null;
  paramNames: (string | null)[] | null;
}

interface ArgFit {
  param: string | null;
  fit: 0 | 1 | 2;
}

/**
 * Per site argument, the candidate's parameter type and the fit (see argFit): positional
 * arguments by position, named ones by parameter name (null when that name does not
 * exist). Positions past the declared parameters (a vararg's tail, a trailing lambda)
 * are wildcards.
 */
function argFitsOf(site: OverloadSite, c: OverloadCandidate, ctx: TypeContext): ArgFit[] | null {
  const out: ArgFit[] = [];
  const n = Math.max(site.argTypes?.length ?? 0, site.argNames?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const name = site.argNames?.[i] ?? null;
    const at = name === null ? i : c.paramNames?.indexOf(name) ?? -1;
    if (at < 0) return null;
    const param = c.paramTypes?.[at] ?? null;
    out.push({ param, fit: argFit(site.argTypes?.[i] ?? null, param, ctx, site.language) });
  }
  return out;
}

const weakest = (fits: ArgFit[] | null): 0 | 1 | 2 =>
  fits === null ? 0 : fits.reduce<0 | 1 | 2>((w, f) => (f.fit < w ? f.fit : w), 2);

/** The weakest fit over the site's arguments; 0 when a named argument has no parameter. */
export function fitOf(site: OverloadSite, c: OverloadCandidate, ctx: TypeContext): 0 | 1 | 2 {
  return weakest(argFitsOf(site, c, ctx));
}

/**
 * Whether a certain fit `d` makes `c` drop out. Against a possible fit: unless `d` is
 * certain only through Object/Any where `c` is possible (`c` may be the more specific
 * one). Against a certain fit: when `d` equals `c` everywhere except where `c` takes
 * Object/Any and `d` a more specific type that a known argument certainly fits.
 */
function dominates(d: ArgFit[], c: ArgFit[], cFit: 1 | 2, site: OverloadSite): boolean {
  if (cFit === 1) return d.every((x, k) => !(c[k].fit === 1 && x.param !== null && CATCH_ALL.has(x.param)));
  let strict = false;
  for (let k = 0; k < d.length; k++) {
    const dp = d[k].param;
    const cp = c[k].param;
    if (dp !== null && dp === cp) continue;
    if (cp === null || dp === null || !CATCH_ALL.has(cp) || CATCH_ALL.has(dp) || (site.argTypes?.[k] ?? null) === null) return false;
    strict = true;
  }
  return strict;
}

/**
 * The candidates that fit the site's known argument types and names and that no certain
 * fit dominates (see dominates); every candidate when nothing is known or nothing fits.
 * Object/Any never outranks a more specific parameter that may apply.
 */
export function narrowOverloads<T extends OverloadCandidate>(site: OverloadSite, candidates: T[], ctx: TypeContext): T[] {
  const known = site.argTypes?.some((t) => t !== null) || site.argNames?.some((n) => n !== null);
  if (!known || candidates.length < 2) return candidates;
  const per = candidates.map((c) => argFitsOf(site, c, ctx));
  const fits = per.map(weakest);
  if (Math.max(...fits) === 0) return candidates;
  return candidates.filter((_, i) => {
    const f = fits[i];
    return f !== 0 && !per.some((d, j) => j !== i && fits[j] === 2 && dominates(d!, per[i]!, f, site));
  });
}
