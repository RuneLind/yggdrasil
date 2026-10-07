/** Pure signature parsing for eval-callers.ts, kept import-safe (no DB, no main()). */
import { normalizeTypeName } from "../src/indexer/symbol-extractor.ts";
import { canonicalType } from "../src/indexer/overloads.ts";

const OPEN = "(<[{";
const CLOSE = ")>]}";

/** Index of the `(` that opens the final balanced group ending at the last `)`, or -1. */
function lastGroupStart(text: string): number {
  const end = text.lastIndexOf(")");
  if (end < 0) return -1;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Method name from an IntelliJ caller signature `Class.name(ParamTypes)`. The parameter
 * list is the final balanced group, so a Kotlin test name may itself hold `(` or `.`
 * ("Test.lagre med HØY (typen vinner)()", "Test.versjon 2.0 lagres()"). The class prefix
 * is an identifier path without spaces, so the name starts after the last `.` before
 * the first space (or the first backtick); with no space, after the last `.`.
 * Backticks are kept; callers compare names with backticks stripped.
 */
export function intellijMethodName(signature: string): string {
  const open = lastGroupStart(signature);
  const head = open >= 0 ? signature.slice(0, open) : signature;
  const tick = head.indexOf("`");
  if (tick >= 0) return head.slice(tick);
  const space = head.search(/\s/);
  const prefixEnd = space >= 0 ? head.lastIndexOf(".", space) : head.lastIndexOf(".");
  return head.slice(prefixEnd + 1);
}

/**
 * Count the parameters in the first balanced `(...)` at or after `from`. Commas inside
 * generics, nested parens (annotations, default values), brackets, and string or char
 * literals (`sep: String = ","`) do not count. Returns null when no balanced group is found.
 */
export function countParams(text: string, from = 0): number | null {
  const open = text.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  let segments = 0;
  let segmentHasContent = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // Skip to the matching unescaped quote.
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      i = j;
      segmentHasContent = true;
      continue;
    }
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && depth > 0) {
      // `->` in a Kotlin function type is not a closing bracket.
      if (!(ch === ">" && text[i - 1] === "-")) depth--;
    } else if (ch === ")") {
      return segments + (segmentHasContent ? 1 : 0);
    } else if (ch === "," && depth === 0) {
      if (segmentHasContent) segments++;
      segmentHasContent = false;
      continue;
    }
    if (!/\s/.test(ch)) segmentHasContent = true;
  }
  return null;
}

/** Parameter count of an IntelliJ signature: its final balanced group, not a `(` in the name. */
export function intellijParamCount(signature: string): number | null {
  const open = lastGroupStart(signature);
  return open >= 0 ? countParams(signature, open) : null;
}

/**
 * Parameter types of an IntelliJ signature's final group, canonical like
 * ci_symbols.param_types (simple name, generics and `?` stripped, boxed twins folded);
 * null for a type that is not an identifier path (function type, array, vararg).
 */
export function intellijParamTypes(signature: string): (string | null)[] | null {
  const open = lastGroupStart(signature);
  if (open < 0) return null;
  const inner = signature.slice(open + 1, signature.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && !(ch === ">" && inner[i - 1] === "-")) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => {
    const normalized = normalizeTypeName(p.trim());
    return normalized ? canonicalType(normalized) : null;
  });
}

/**
 * Declared parameter count from ci_symbols.min_params/max_params (from the AST): all
 * parameters, or the required ones plus the vararg when max_params is null.
 */
export function declaredParamCount(minParams: number | null | undefined, maxParams: number | null | undefined): number | null {
  if (minParams === null || minParams === undefined) return null;
  return maxParams ?? minParams + 1;
}
