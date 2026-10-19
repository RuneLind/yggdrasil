import type { Node, Tree } from "web-tree-sitter";
import { extensionToLanguage, initParser, loadLanguage, parseSource } from "../indexer/parser.ts";

/**
 * Container rule on tree-sitter node types. A hit (a changed line, or an insertion point)
 * inside a class, interface, enum or object is classified by the class-body-level node it
 * falls in. Kinds in KEEPING keep the container in changedSymbols; the others do not.
 *
 * | Node | Kind |
 * |---|---|
 * | Class header: annotations, modifiers, name, type parameters, supertypes, primary constructor, the `{` line | header |
 * | Kotlin stored property (initializer or delegate, or no accessor), Java field or interface constant | state |
 * | Kotlin `init {}`, Java `static {}` and instance initializer, Kotlin secondary constructor, enum entry | state |
 * | Function or method without a body (abstract, interface) | contract |
 * | Function or method with a body, Java constructor, nested class, Kotlin computed property (accessor, no initializer) | member |
 * | Comment | comment |
 * | Nothing but whitespace or the closing `}` | blank |
 * | Any other node, a parse error | unknown |
 */
export type HitKind = "header" | "state" | "contract" | "unknown" | "member" | "comment" | "blank";

/** Kinds that keep the container, strongest first; the rest in report order. */
const ORDER: readonly HitKind[] = ["header", "state", "contract", "unknown", "member", "comment", "blank"];
export const KEEPING: ReadonlySet<HitKind> = new Set(["header", "state", "contract", "unknown"]);

/** The kind that decides for a set of hits: the first in ORDER. */
export function strongest(kinds: Iterable<HitKind>): HitKind | null {
  let best: HitKind | null = null;
  for (const k of kinds) if (best === null || ORDER.indexOf(k) < ORDER.indexOf(best)) best = k;
  return best;
}

/** Node types the indexer extracts as container symbols (Kotlin and Java). */
const CONTAINER_NODES: ReadonlySet<string> = new Set([
  "class_declaration", "object_declaration", "interface_declaration", "enum_declaration", "record_declaration",
]);
/** Not a symbol, but a body of its own: classified as part of the class that holds it. */
const TRANSPARENT_NODES: ReadonlySet<string> = new Set(["companion_object"]);
const BODY_NODES: ReadonlySet<string> = new Set([
  "class_body", "enum_class_body", "interface_body", "enum_body", "annotation_type_body",
]);
const COMMENT_NODES: ReadonlySet<string> = new Set(["line_comment", "block_comment", "multiline_comment", "comment"]);
const CALLABLE_NODES: ReadonlySet<string> = new Set(["function_declaration", "method_declaration"]);
const STATE_NODES: ReadonlySet<string> = new Set([
  "field_declaration", "constant_declaration", "anonymous_initializer", "static_initializer", "block",
  "enum_entry", "enum_constant", "secondary_constructor",
]);
const MEMBER_NODES: ReadonlySet<string> = new Set(["constructor_declaration", ...CONTAINER_NODES]);
/** Declarations an annotation or modifier line can belong to (see declarationContinuesAfter). */
const DECLARATION_NODES: ReadonlySet<string> = new Set([
  ...CONTAINER_NODES, ...CALLABLE_NODES, ...STATE_NODES, ...MEMBER_NODES, "property_declaration", "companion_object",
]);

/** A parsed file. Call `delete()` when done: tree-sitter trees live in WASM memory. */
export interface SourceTree {
  root: Node;
  delete(): void;
}

/** Parse a Java or Kotlin file; null for any other language. */
export async function parseSourceTree(path: string, content: string): Promise<SourceTree | null> {
  const dot = path.lastIndexOf(".");
  const lang = extensionToLanguage(dot >= 0 ? path.slice(dot) : "");
  if (lang !== "java" && lang !== "kotlin") return null;
  await initParser();
  const tree: Tree | null = parseSource(content, await loadLanguage(lang));
  if (!tree) return null;
  return { root: tree.rootNode, delete: () => tree.delete() };
}

const first = (n: Node) => n.startPosition.row + 1;
const last = (n: Node) => n.endPosition.row + 1;
const named = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => c !== null);

function bodyOf(n: Node): Node | null {
  return named(n).find((c) => BODY_NODES.has(c.type)) ?? null;
}

/** The container node a symbol spanning [startLine, endLine] was extracted from. */
export function findContainerNode(root: Node, startLine: number, endLine: number): Node | null {
  const visit = (n: Node): Node | null => {
    if (CONTAINER_NODES.has(n.type) && first(n) === startLine && last(n) === endLine) return n;
    for (const c of named(n)) {
      if (first(c) <= startLine && last(c) >= endLine) {
        const hit = visit(c);
        if (hit) return hit;
      }
    }
    return null;
  };
  return visit(root);
}

function nameOf(n: Node): string {
  const id = n.childForFieldName("name") ?? named(n).find((c) => c.type === "identifier" || c.type === "type_identifier");
  return id?.text ?? (TRANSPARENT_NODES.has(n.type) ? "Companion" : "?");
}

/** Names of `n` and the containers around it, outermost first. */
export function containerPath(n: Node): string {
  const names: string[] = [];
  for (let p: Node | null = n; p; p = p.parent) {
    if (CONTAINER_NODES.has(p.type) || TRANSPARENT_NODES.has(p.type)) names.unshift(nameOf(p));
  }
  return names.join(".");
}

/** The container node in `root` with the same containerPath, for the head file of a base container. */
export function findContainerByPath(root: Node, path: string): Node | null {
  const visit = (n: Node): Node | null => {
    if (CONTAINER_NODES.has(n.type) && containerPath(n) === path) return n;
    for (const c of named(n)) {
      const hit = visit(c);
      if (hit) return hit;
    }
    return null;
  };
  return visit(root);
}

/**
 * A Kotlin property with an accessor and no initializer holds no state. (A delegated
 * property cannot declare an accessor, so it is always stored.)
 */
function isComputedProperty(n: Node): boolean {
  const kids = n.children.filter((c): c is Node => c !== null);
  return kids.some((c) => c.type === "getter" || c.type === "setter") && !kids.some((c) => c.type === "=");
}

function hasBody(n: Node): boolean {
  return named(n).some((c) => c.type === "function_body" || c.type === "block");
}

function overlapsLine(n: Node, line: number): boolean {
  return first(n) <= line && last(n) >= line;
}

/** Kind of body-level child `kid` for a hit on `line` (used to descend into wrappers). */
function childKind(kid: Node, line: number): HitKind {
  if (COMMENT_NODES.has(kid.type)) return "comment";
  if (TRANSPARENT_NODES.has(kid.type)) return classifyLine(kid, line) ?? "blank";
  if (kid.type === "enum_body_declarations") {
    return strongest(named(kid).filter((c) => overlapsLine(c, line)).map((c) => childKind(c, line))) ?? "blank";
  }
  if (CALLABLE_NODES.has(kid.type)) return hasBody(kid) ? "member" : "contract";
  if (kid.type === "property_declaration") return isComputedProperty(kid) ? "member" : "state";
  if (STATE_NODES.has(kid.type)) return "state";
  if (MEMBER_NODES.has(kid.type)) return "member";
  return "unknown";
}

/** Classify 1-based `line` against `container`; null when the line lies outside it. */
export function classifyLine(container: Node, line: number): HitKind | null {
  if (line < first(container) || line > last(container)) return null;
  const body = bodyOf(container);
  if (!body || line < first(body)) return "header";
  const kinds = named(body).filter((c) => overlapsLine(c, line)).map((c) => childKind(c, line));
  // The `{` line belongs to the header: `class K(val a: Int) {`.
  if (line === first(body)) kinds.push("header");
  return strongest(kinds) ?? "blank";
}

/**
 * Classify an insertion between base lines `after` and `after + 1` against `container`:
 * in the header, or inside the body-level child that holds both lines. Null when the
 * insertion falls between children, so only the inserted lines can classify it.
 */
export function classifyInsertion(container: Node, after: number): HitKind | null {
  const body = bodyOf(container);
  if (!body || after + 1 <= first(body)) return "header";
  const kid = named(body).find((c) => first(c) <= after && last(c) >= after + 1);
  if (!kid) return null;
  if (TRANSPARENT_NODES.has(kid.type)) return classifyInsertion(kid, after);
  if (kid.type === "enum_body_declarations") {
    const inner = named(kid).find((c) => first(c) <= after && last(c) >= after + 1);
    return inner ? childKind(inner, after) : null;
  }
  return childKind(kid, after);
}

/**
 * Does a declaration in the head file start on lines [from, to] and continue past `to`?
 * Then the inserted lines are annotations or modifiers of the declaration that starts on
 * the base line after the insertion point.
 */
export function declarationContinuesAfter(root: Node, from: number, to: number): boolean {
  const visit = (n: Node): boolean => {
    if (DECLARATION_NODES.has(n.type) && first(n) >= from && first(n) <= to && last(n) > to) return true;
    return named(n).some((c) => first(c) <= to && last(c) >= from && visit(c));
  };
  return visit(root);
}
