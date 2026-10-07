import type { SupportedLanguage } from "./parser.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import { CONTAINER_KINDS, normalizeTypeName, kotlinVariableType } from "./symbol-extractor.ts";
import { nodeText, walkTree, findNamedChild } from "./ast-utils.ts";
import type { SyntaxNode } from "web-tree-sitter";

export type ReceiverKind = "none" | "this" | "identifier" | "static-type" | "chain-or-expression";

export interface ExtractedCall {
  /** Normalized: `this.`, `!!` and a trailing `.Companion` removed. */
  receiver: string | null;
  receiverKind: ReceiverKind;
  /** Declared type of a single-identifier receiver found in scope (see javaVariableType), else null. */
  receiverType: string | null;
  methodName: string;
  /** Includes a Kotlin trailing lambda; null when a spread or named argument makes the count unreliable. */
  argCount: number | null;
  line: number;
  /** Call node's start offset, same units as ExtractedSymbol.startIndex. */
  startIndex: number;
}

// Continuation allows combining marks, so an NFD-encoded Å (A + U+030A) stays one identifier.
const IDENT_PATH_SEGMENT = /^[\p{L}_$][\p{L}\p{M}\p{N}\p{Pc}\p{Sc}]*$/u;

/**
 * Classify a receiver as extracted. `static-type` is an identifier path starting with an
 * uppercase letter (\p{Lu}, so Æ/Ø/Å count): it covers every receiver the static-call
 * rule can resolve, because that rule matches the receiver against a container's
 * qualified name, which is always an identifier path.
 */
export function classifyReceiver(receiver: string | null): ReceiverKind {
  if (receiver === null) return "none";
  if (receiver === "this") return "this";
  const segments = receiver.split(".");
  const isPath = segments.every(
    (seg) => IDENT_PATH_SEGMENT.test(seg) && seg !== "this" && seg !== "super",
  );
  if (!isPath) return "chain-or-expression";
  if (/^\p{Lu}/u.test(receiver)) return "static-type";
  return segments.length === 1 ? "identifier" : "chain-or-expression";
}

export interface ExtractedInheritance {
  kind: "extends" | "implements";
  typeName: string;
  symbolIndex: number;
}

export interface CallGraphResult {
  calls: ExtractedCall[];
  inheritance: ExtractedInheritance[];
}

interface CallGraphAdapter {
  extractCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]): void;
  extractInheritance(
    root: SyntaxNode,
    source: string,
    extraction: ExtractionResult,
    inheritance: ExtractedInheritance[],
  ): void;
}

// One entry per language with a wired call/inheritance extractor. Keeping the dispatch
// table-driven (rather than a hardcoded if/else) means a language that's declared
// SupportedLanguage but has no extractor surfaces as a logged gap below, instead of
// silently indexing symbols with a permanently empty call graph.
//
// TypeScript/tsx are deliberately absent: a useful TS call graph also needs TS import
// resolution (module-specifier parsing + relative-path resolution), which is a separate
// piece of work — see the review follow-ups (#18). Until that lands, TS files index
// their symbols and the warning below makes the missing edges explicit.
const CALL_GRAPH_ADAPTERS: Partial<Record<SupportedLanguage, CallGraphAdapter>> = {
  java: { extractCalls: extractJavaCalls, extractInheritance: extractJavaInheritance },
  kotlin: { extractCalls: extractKotlinCalls, extractInheritance: extractKotlinInheritance },
};

const warnedMissingExtractor = new Set<SupportedLanguage>();

export function extractCallGraph(
  source: string,
  tree: ReturnType<import("web-tree-sitter").Parser["parse"]>,
  lang: SupportedLanguage,
  extraction: ExtractionResult,
): CallGraphResult {
  const calls: ExtractedCall[] = [];
  const inheritance: ExtractedInheritance[] = [];

  const adapter = CALL_GRAPH_ADAPTERS[lang];
  if (!adapter) {
    if (!warnedMissingExtractor.has(lang)) {
      warnedMissingExtractor.add(lang);
      console.warn(
        `[call-graph] no call/inheritance extractor for language '${lang}' — its files ` +
          `index symbols but contribute no call-graph edges (impact/detect_changes will ` +
          `under-report for them).`,
      );
    }
    return { calls, inheritance };
  }

  adapter.extractCalls(tree.rootNode, source, calls);
  adapter.extractInheritance(tree.rootNode, source, extraction, inheritance);

  return { calls, inheritance };
}

// ── Java ──

function extractJavaCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]) {
  walkTree(root, (node) => {
    if (node.type !== "method_invocation") return;

    const nameNode = node.childForFieldName("name");
    const objectNode = node.childForFieldName("object");
    if (!nameNode) return;

    const { receiver, receiverType } = javaReceiver(objectNode, node, source);
    const args = node.childForFieldName("arguments");
    calls.push({
      receiver,
      receiverKind: classifyReceiver(receiver),
      receiverType,
      methodName: nodeText(nameNode, source),
      argCount: args ? args.namedChildren.filter((c: SyntaxNode) => !isComment(c)).length : 0,
      line: node.startPosition.row + 1,
      startIndex: node.startIndex,
    });
  });
}

interface Receiver {
  receiver: string | null;
  receiverType: string | null;
}

/** `this.x` names a field; strip it so the scope lookup can find `x` among fields only. */
function javaReceiver(objectNode: SyntaxNode | null, call: SyntaxNode, source: string): Receiver {
  if (!objectNode) return { receiver: null, receiverType: null };
  let node = objectNode;
  let fieldsOnly = false;
  if (node.type === "field_access" && node.childForFieldName("object")?.type === "this") {
    node = node.childForFieldName("field") ?? node;
    fieldsOnly = true;
  }
  return withType(nodeText(node, source), (name) => javaVariableType(call, name, fieldsOnly, source));
}

/** Normalize the receiver text and, for a single identifier, look up its declared type. */
function withType(text: string, lookup: (name: string) => string | null): Receiver {
  const receiver = text.endsWith(".Companion") && classifyReceiver(text) === "static-type"
    ? text.slice(0, -".Companion".length)
    : text;
  const kind = classifyReceiver(receiver);
  const single = (kind === "identifier" || kind === "static-type") && !receiver.includes(".");
  return { receiver, receiverType: single ? lookup(receiver) : null };
}

function extractJavaInheritance(
  root: SyntaxNode,
  source: string,
  extraction: ExtractionResult,
  inheritance: ExtractedInheritance[],
) {
  walkTree(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "interface_declaration"
      && node.type !== "record_declaration") return;

    const symbolIndex = declaringSymbolIndex(extraction, node);
    if (symbolIndex < 0) return;

    // extends (class superclass or interface extends)
    const superclassNode = node.childForFieldName("superclass")
      ?? findNamedChild(node, "extends_interfaces");
    if (superclassNode) {
      const typeList = findNamedChild(superclassNode, "type_list");
      if (typeList) {
        extractTypeListNames(typeList, source).forEach((typeName) =>
          inheritance.push({ kind: "extends", typeName, symbolIndex }),
        );
      } else {
        const typeName = superclassNode.namedChild(0) && normalizeTypeName(nodeText(superclassNode.namedChild(0)!, source));
        if (typeName) inheritance.push({ kind: "extends", typeName, symbolIndex });
      }
    }

    // implements
    const interfacesNode = node.childForFieldName("interfaces");
    if (interfacesNode) {
      const typeList = findNamedChild(interfacesNode, "type_list");
      if (typeList) {
        extractTypeListNames(typeList, source).forEach((typeName) =>
          inheritance.push({ kind: "implements", typeName, symbolIndex }),
        );
      }
    }
  });
}

/** Type names of a type_list, normalized (generic arguments dropped, `Outer.Inner` kept). */
function extractTypeListNames(typeList: SyntaxNode, source: string): string[] {
  return typeList.namedChildren
    .map((child: SyntaxNode) => normalizeTypeName(nodeText(child, source)))
    .filter((name: string | null): name is string => name !== null);
}

/**
 * The container symbol declared by `node`. By source range: matching by name credited a
 * nested class's clause to the first container of that name in the file.
 */
function declaringSymbolIndex(extraction: ExtractionResult, node: SyntaxNode): number {
  return extraction.symbols.findIndex(
    (s) => CONTAINER_KINDS.has(s.kind) && s.startIndex === node.startIndex && s.endIndex === node.endIndex,
  );
}

// ── Kotlin ──

function extractKotlinCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]) {
  walkTree(root, (node) => {
    if (node.type !== "call_expression") return;

    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    if (firstChild.type === "navigation_expression") {
      const parts = firstChild.namedChildren;
      if (parts.length >= 2) {
        const { receiver, receiverType } = kotlinReceiver(parts[0], node, source);
        calls.push({
          receiver,
          receiverKind: classifyReceiver(receiver),
          receiverType,
          methodName: nodeText(parts[parts.length - 1], source),
          argCount: kotlinArgCount(node),
          line: node.startPosition.row + 1,
          startIndex: node.startIndex,
        });
      }
    } else if (firstChild.type === "identifier") {
      calls.push({
        receiver: null,
        receiverKind: "none",
        receiverType: null,
        methodName: nodeText(firstChild, source),
        argCount: kotlinArgCount(node),
        line: node.startPosition.row + 1,
        startIndex: node.startIndex,
      });
    }
  });
}

/** Strip `x!!` and `this.x` (fields and properties only) before the scope lookup. */
function kotlinReceiver(node: SyntaxNode, call: SyntaxNode, source: string): Receiver {
  let fieldsOnly = false;
  for (;;) {
    if (node.type === "unary_expression" && node.childForFieldName("operator")?.type === "!!") {
      node = node.childForFieldName("argument") ?? node;
    } else if (
      node.type === "navigation_expression" &&
      node.namedChildCount === 2 &&
      node.namedChild(0)?.type === "this_expression"
    ) {
      node = node.namedChild(1)!;
      fieldsOnly = true;
    } else break;
  }
  return withType(nodeText(node, source), (name) => kotlinScopeVariableType(call, name, fieldsOnly, source));
}

function isComment(node: SyntaxNode): boolean {
  return node.type === "line_comment" || node.type === "block_comment";
}

/**
 * Count a Kotlin call's arguments. The grammar parses `f(1) { … }` as an outer
 * call_expression wrapping `f(1)` with the annotated_lambda as its suffix, so the
 * trailing lambda is found on the parent; `f { … }` carries it directly.
 */
function kotlinArgCount(call: SyntaxNode): number | null {
  let count = 0;
  for (const child of call.namedChildren) {
    if (child.type === "annotated_lambda") count++;
    if (child.type !== "value_arguments") continue;
    for (const arg of child.namedChildren) {
      if (arg.type !== "value_argument") continue;
      const named = arg.children.some((c: SyntaxNode) => c.type === "=");
      const spread = arg.namedChildren.some((c: SyntaxNode) => c.type === "spread_expression");
      if (named || spread) return null;
      count++;
    }
  }
  const parent = call.parent;
  if (
    parent?.type === "call_expression" &&
    parent.namedChild(0)?.id === call.id &&
    parent.namedChildren.length === 2 &&
    parent.namedChild(1)?.type === "annotated_lambda"
  ) {
    count++;
  }
  return count;
}

function extractKotlinInheritance(
  root: SyntaxNode,
  source: string,
  extraction: ExtractionResult,
  inheritance: ExtractedInheritance[],
) {
  walkTree(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "object_declaration"
      && node.type !== "interface_declaration") return;

    const symbolIndex = declaringSymbolIndex(extraction, node);
    if (symbolIndex < 0) return;

    const delegationSpecs = findNamedChild(node, "delegation_specifiers");
    if (!delegationSpecs) return;

    for (let i = 0; i < delegationSpecs.namedChildCount; i++) {
      const spec = delegationSpecs.namedChild(i)!;
      if (spec.type !== "delegation_specifier") continue;

      const firstChild = spec.namedChild(0);
      if (!firstChild) continue;

      if (firstChild.type === "constructor_invocation") {
        const userType = findNamedChild(firstChild, "user_type");
        const typeName = userType && normalizeTypeName(nodeText(userType, source));
        if (typeName) inheritance.push({ kind: "extends", typeName, symbolIndex });
      } else if (firstChild.type === "user_type") {
        const typeName = normalizeTypeName(nodeText(firstChild, source));
        if (typeName) inheritance.push({ kind: "implements", typeName, symbolIndex });
      }
    }
  });
}

// ── Receiver scope ──

/**
 * Declared type of a receiver variable, looked up from the call outward through the AST:
 * locals declared before the call, enclosing parameters, then the enclosing class body
 * (Java fields, Kotlin properties and constructor properties), then outer classes.
 * Java fields and Kotlin constructor properties are not symbols, and the stored
 * property symbols include function-local `val`s, so this reads the AST, not ci_symbols.
 *
 * Each lookup returns the type, null when the name is declared without a usable type
 * (the declaration still shadows outer ones), or undefined when not declared there.
 * `fieldsOnly` (`this.x`) skips locals and stops at the innermost class body.
 */
type Found = string | null | undefined;

const JAVA_CLASS_BODIES: ReadonlySet<string> = new Set(["class_body", "interface_body", "enum_body"]);
const JAVA_BLOCKS: ReadonlySet<string> = new Set(["block", "constructor_body", "switch_block_statement_group"]);
const JAVA_PARAMETER_OWNERS: ReadonlySet<string> = new Set([
  "method_declaration", "constructor_declaration", "lambda_expression",
]);

function javaVariableType(call: SyntaxNode, name: string, fieldsOnly: boolean, source: string): string | null {
  for (let n = call.parent; n; n = n.parent) {
    if (!fieldsOnly) {
      const local = javaLocal(n, name, call.startIndex, source);
      if (local !== undefined) return local;
    }
    if (JAVA_CLASS_BODIES.has(n.type)) {
      const field = javaFields(n, name, source);
      if (field !== undefined) return field;
      if (fieldsOnly) return null;
    }
  }
  return null;
}

function javaType(node: SyntaxNode | null, source: string): string | null {
  return node ? normalizeTypeName(nodeText(node, source)) : null;
}

function javaDeclarators(decl: SyntaxNode, name: string, source: string): Found {
  for (const d of decl.childrenForFieldName("declarator")) {
    if (d && nodeText(d.childForFieldName("name") ?? d, source) === name) {
      return javaType(decl.childForFieldName("type"), source);
    }
  }
  return undefined;
}

function javaLocal(n: SyntaxNode, name: string, position: number, source: string): Found {
  if (JAVA_BLOCKS.has(n.type)) {
    for (const child of n.namedChildren) {
      if (child.endIndex > position) break;
      if (child.type === "local_variable_declaration") {
        const found = javaDeclarators(child, name, source);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
  if (JAVA_PARAMETER_OWNERS.has(n.type)) {
    const params = n.childForFieldName("parameters");
    if (!params) return undefined;
    if (params.type === "identifier") return nodeText(params, source) === name ? null : undefined;
    for (const p of params.namedChildren) {
      if (p.type === "formal_parameter" && nodeText(p.childForFieldName("name") ?? p, source) === name) {
        return javaType(p.childForFieldName("type"), source);
      }
      const spreadName = p.type === "spread_parameter" ? findNamedChild(p, "variable_declarator")?.childForFieldName("name") : null;
      if (spreadName && nodeText(spreadName, source) === name) return null;
      if (p.type === "identifier" && nodeText(p, source) === name) return null;
    }
    return undefined;
  }
  if (n.type === "enhanced_for_statement" && nodeText(n.childForFieldName("name") ?? n, source) === name) {
    return javaType(n.childForFieldName("type"), source);
  }
  if (n.type === "for_statement") {
    for (const init of n.childrenForFieldName("init")) {
      if (init?.type === "local_variable_declaration") {
        const found = javaDeclarators(init, name, source);
        if (found !== undefined) return found;
      }
    }
  }
  if (n.type === "catch_clause") {
    const param = findNamedChild(n, "catch_formal_parameter");
    if (param && nodeText(param.childForFieldName("name") ?? param, source) === name) {
      const types = findNamedChild(param, "catch_type")?.namedChildren ?? [];
      return types.length === 1 ? javaType(types[0], source) : null;
    }
  }
  if (n.type === "try_with_resources_statement") {
    for (const r of findNamedChild(n, "resource_specification")?.namedChildren ?? []) {
      if (r.type === "resource" && r.childForFieldName("name") && nodeText(r.childForFieldName("name")!, source) === name) {
        return javaType(r.childForFieldName("type"), source);
      }
    }
  }
  return undefined;
}

function javaFields(body: SyntaxNode, name: string, source: string): Found {
  const members = body.type === "enum_body"
    ? findNamedChild(body, "enum_body_declarations")?.namedChildren ?? []
    : body.namedChildren;
  for (const m of members) {
    if (m.type === "field_declaration" || m.type === "constant_declaration") {
      const found = javaDeclarators(m, name, source);
      if (found !== undefined) return found;
    }
  }
  // Record components are fields of the record.
  if (body.parent?.type === "record_declaration") {
    for (const p of body.parent.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type === "formal_parameter" && nodeText(p.childForFieldName("name") ?? p, source) === name) {
        return javaType(p.childForFieldName("type"), source);
      }
    }
  }
  return undefined;
}

// ── Kotlin ──

const KOTLIN_CLASS_BODIES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);
const KOTLIN_BLOCKS: ReadonlySet<string> = new Set(["block", "statements", "lambda_literal", "source_file"]);
const KOTLIN_PARAMETER_OWNERS: ReadonlySet<string> = new Set([
  "function_declaration", "secondary_constructor", "anonymous_function",
]);

function kotlinScopeVariableType(call: SyntaxNode, name: string, fieldsOnly: boolean, source: string): string | null {
  for (let n = call.parent; n; n = n.parent) {
    if (!fieldsOnly) {
      const local = kotlinLocal(n, name, call.startIndex, source);
      if (local !== undefined) return local;
    }
    if (KOTLIN_CLASS_BODIES.has(n.type)) {
      const member = kotlinMembers(n, name, source);
      if (member !== undefined) return member;
      if (fieldsOnly) return null;
    }
  }
  return null;
}

function kotlinProperty(prop: SyntaxNode, name: string, source: string): Found {
  const decl = findNamedChild(prop, "variable_declaration");
  if (!decl) {
    const multi = findNamedChild(prop, "multi_variable_declaration");
    return multi?.namedChildren.some((d: SyntaxNode) => nodeText(d.namedChild(0) ?? d, source) === name) ? null : undefined;
  }
  if (nodeText(decl.namedChild(0) ?? decl, source) !== name) return undefined;
  const eq = prop.children.findIndex((c: SyntaxNode) => c.type === "=");
  const value = eq >= 0 ? prop.children.slice(eq + 1).find((c: SyntaxNode) => c.isNamed) : null;
  return kotlinVariableType(decl, value, source);
}

function kotlinLocal(n: SyntaxNode, name: string, position: number, source: string): Found {
  if (KOTLIN_BLOCKS.has(n.type)) {
    // Top-level properties are in scope wherever they are declared in the file.
    const ordered = n.type !== "source_file";
    for (const child of n.namedChildren) {
      if (ordered && child.endIndex > position) break;
      if (child.type === "property_declaration") {
        const found = kotlinProperty(child, name, source);
        if (found !== undefined) return found;
      }
    }
  }
  if (KOTLIN_PARAMETER_OWNERS.has(n.type)) {
    for (const p of findNamedChild(n, "function_value_parameters")?.namedChildren ?? []) {
      if (p.type === "parameter" && nodeText(p.namedChild(0) ?? p, source) === name) {
        return kotlinVariableType(p, null, source);
      }
    }
  }
  if (n.type === "lambda_literal") {
    for (const d of findNamedChild(n, "lambda_parameters")?.namedChildren ?? []) {
      if (d.type === "variable_declaration" && nodeText(d.namedChild(0) ?? d, source) === name) {
        return kotlinVariableType(d, null, source);
      }
    }
  }
  if (n.type === "for_statement") {
    const d = findNamedChild(n, "variable_declaration");
    if (d && nodeText(d.namedChild(0) ?? d, source) === name) return kotlinVariableType(d, null, source);
  }
  if (n.type === "catch_block") {
    const id = findNamedChild(n, "identifier");
    if (id && nodeText(id, source) === name) return normalizeTypeName(nodeText(findNamedChild(n, "user_type") ?? id, source));
  }
  return undefined;
}

function kotlinMembers(body: SyntaxNode, name: string, source: string): Found {
  for (const m of body.namedChildren) {
    if (m.type === "property_declaration") {
      const found = kotlinProperty(m, name, source);
      if (found !== undefined) return found;
    }
  }
  // `class C(private val x: T)`: constructor properties; plain parameters are not members.
  const ctor = body.parent?.type === "class_declaration" ? findNamedChild(body.parent, "primary_constructor") : null;
  for (const p of findNamedChild(ctor ?? body, "class_parameters")?.namedChildren ?? []) {
    if (p.type !== "class_parameter") continue;
    const isProperty = p.children.some((c: SyntaxNode) => c.type === "val" || c.type === "var");
    if (isProperty && nodeText(findNamedChild(p, "identifier") ?? p, source) === name) {
      return kotlinVariableType(p, null, source);
    }
  }
  return undefined;
}
