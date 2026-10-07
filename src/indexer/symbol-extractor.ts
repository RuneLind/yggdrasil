import { Query, type Language } from "web-tree-sitter";
import type { SupportedLanguage } from "./parser.ts";
import type { SymbolInsert } from "../db/symbols.ts";
import { nodeText, findNamedChild } from "./ast-utils.ts";
import { canonicalType } from "./overloads.ts";
import type { Node as SyntaxNode } from "web-tree-sitter";

export type SymbolKind = "class" | "interface" | "enum" | "method" | "function" |
  "constructor" | "object" | "field" | "property" | "type" | "unknown";

export const CONTAINER_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "object"]);

const TS_QUERY = `
    (import_statement) @import
    (class_declaration name: (type_identifier) @name) @class
    (interface_declaration name: (type_identifier) @name) @interface
    (function_declaration name: (identifier) @name) @function
    (method_definition name: (property_identifier) @name) @method
    (type_alias_declaration name: (type_identifier) @name) @type_alias
    (enum_declaration name: (identifier) @name) @enum
`;

const QUERIES: Record<SupportedLanguage, string> = {
  java: `
    (package_declaration) @package
    (import_declaration) @import
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @interface
    (enum_declaration name: (identifier) @name) @enum
    (record_declaration name: (identifier) @name) @class
    (method_declaration name: (identifier) @name) @method
    (constructor_declaration name: (identifier) @name) @constructor
    (field_declaration) @field
  `,
  kotlin: `
    (package_header) @package
    (import) @import
    (class_declaration name: (identifier) @name) @class
    (object_declaration name: (identifier) @name) @object
    (function_declaration name: (identifier) @name) @function
    (property_declaration (variable_declaration (identifier) @name)) @property
  `,
  typescript: TS_QUERY,
  tsx: TS_QUERY,
};

const queryCache: Partial<Record<SupportedLanguage, Query>> = {};

function getQuery(lang: SupportedLanguage, language: Language): Query {
  if (!queryCache[lang]) {
    queryCache[lang] = new Query(language, QUERIES[lang]);
  }
  return queryCache[lang]!;
}

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Declaration node's start/end offsets in the parsed source; call-site ownership compares them. */
  startIndex: number;
  endIndex: number;
  signature: string | null;
  docComment: string | null;
  visibility: string | null;
  isStatic: boolean;
  /** For building qualified names — parent symbol index in the same extraction batch */
  parentIndex: number | null;
  /**
   * A Kotlin property's type or a method's return type, normalized (see
   * normalizeTypeName). Java fields are not symbols.
   */
  declaredType: string | null;
  /** Callables only: parameters without a default; all parameters, null for a vararg. */
  minParams: number | null;
  maxParams: number | null;
  /**
   * Callables only, one entry per parameter: canonical simple type (see canonicalType),
   * null for a type parameter, array, function type or vararg; and the parameter name.
   */
  paramTypes: (string | null)[] | null;
  paramNames: (string | null)[] | null;
  /** Kotlin extension function: the receiver type, normalized. */
  extensionReceiver: string | null;
}

export interface ExtractedImport {
  importPath: string;
  alias: string | null;
  isWildcard: boolean;
}

export interface ExtractionResult {
  packageName: string | null;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

/** Extract symbols and imports from a parsed tree. */
export function extractSymbols(
  source: string,
  tree: ReturnType<import("web-tree-sitter").Parser["parse"]>,
  lang: SupportedLanguage,
  language: Language,
): ExtractionResult {
  const query = getQuery(lang, language);
  const matches = query.matches(tree.rootNode);

  let packageName: string | null = null;
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];

  for (const match of matches) {
    // Use a Map to avoid prototype chain issues with capture names like "constructor"
    const captures = new Map<string, import("web-tree-sitter").SyntaxNode>();
    for (const c of match.captures) {
      captures.set(c.name, c.node);
    }

    const patternNode = captures.get("class") ?? captures.get("interface") ?? captures.get("enum") ??
      captures.get("method") ?? captures.get("function") ?? captures.get("constructor") ??
      captures.get("object") ?? captures.get("field") ?? captures.get("property") ??
      captures.get("type_alias");
    const nameNode = captures.get("name");

    // Package declarations
    if (captures.has("package")) {
      const pkgNode = captures.get("package")!;
      const pkgText = nodeText(pkgNode, source);
      packageName = pkgText
        .replace(/^package\s+/, "")
        .replace(/;?\s*$/, "")
        .trim();
      continue;
    }

    // Import declarations
    if (captures.has("import")) {
      const impNode = captures.get("import")!;
      if (lang === "kotlin") {
        imports.push(kotlinImport(impNode, source));
        continue;
      }
      const importText = nodeText(impNode, source);
      const isWildcard = importText.includes(".*") || importText.includes("* as");
      const importPath = importText
        .replace(/^import\s+(static\s+)?/, "")
        .replace(/;\s*$/, "")
        .replace(/\.\*$/, "")
        .trim();
      imports.push({ importPath, alias: null, isWildcard });
      continue;
    }

    // Symbol declarations
    if (patternNode && nameNode) {
      const kind = getSymbolKind(match);
      const signature = extractSignature(source, patternNode);
      const docComment = extractDocComment(source, patternNode);
      const visibility = extractVisibility(patternNode, lang, source);
      const name = nodeText(nameNode, source);
      const shape = declarationShape(patternNode, lang, source);

      symbols.push({
        name,
        kind,
        startLine: patternNode.startPosition.row + 1,
        endLine: patternNode.endPosition.row + 1,
        startIndex: patternNode.startIndex,
        endIndex: patternNode.endIndex,
        signature,
        docComment,
        visibility,
        isStatic: checkStatic(patternNode),
        parentIndex: null, // resolved in a second pass
        ...shape,
      });
    }
  }

  // Parent = tightest enclosing container by source range; lines tie when two
  // declarations share one, which nested every one-line class inside its own child.
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) continue;
      const candidate = symbols[j];
      if (
        CONTAINER_KINDS.has(candidate.kind) &&
        sym.startIndex >= candidate.startIndex &&
        sym.endIndex <= candidate.endIndex &&
        (sym.parentIndex === null || candidate.startIndex >= symbols[sym.parentIndex].startIndex)
      ) {
        sym.parentIndex = j;
      }
    }
  }

  return { packageName, symbols, imports };
}

/** `import a.b.C`, `import a.b.*`, `import a.b.C as D`, read from the AST. */
function kotlinImport(node: SyntaxNode, source: string): ExtractedImport {
  const children = node.children;
  const path = findNamedChild(node, "qualified_identifier") ?? findNamedChild(node, "identifier");
  const asAt = children.findIndex((c: SyntaxNode) => c.type === "as");
  const aliasNode = asAt >= 0 ? children.slice(asAt + 1).find((c: SyntaxNode) => c.type === "identifier") : undefined;
  return {
    importPath: path ? nodeText(path, source) : "",
    alias: aliasNode ? nodeText(aliasNode, source) : null,
    isWildcard: children.some((c: SyntaxNode) => c.type === "*"),
  };
}

const TYPE_PATH = /^[\p{L}_$][\p{L}\p{M}\p{N}\p{Pc}\p{Sc}]*(\.[\p{L}_$][\p{L}\p{M}\p{N}\p{Pc}\p{Sc}]*)*$/u;

/**
 * A type as written → the identifier path a class lookup can match: generic arguments,
 * nullable `?` and whitespace removed. Null for anything else (function types, arrays).
 */
export function normalizeTypeName(text: string | null | undefined): string | null {
  if (!text) return null;
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">" && text[i - 1] !== "-") depth--;
    else if (depth === 0) out += ch;
  }
  out = out.replace(/[?\s]/g, "");
  return TYPE_PATH.test(out) ? out : null;
}

const KOTLIN_TYPE_NODES: ReadonlySet<string> = new Set(["user_type", "nullable_type", "function_type", "parenthesized_type", "non_nullable_type"]);

/**
 * Kotlin `val x: T` → T; `val x = Foo(…)` → Foo (an uppercase callee is a constructor
 * call); `val x = "…"` (or another literal) → the literal's type.
 */
export function kotlinVariableType(decl: SyntaxNode, value: SyntaxNode | null | undefined, source: string): string | null {
  const typeNode = decl.namedChildren.find((c: SyntaxNode) => KOTLIN_TYPE_NODES.has(c.type));
  if (typeNode) return normalizeTypeName(nodeText(typeNode, source));
  const literal = value ? kotlinLiteralType(value, source) : null;
  if (literal) return literal;
  if (value?.type === "call_expression") {
    const callee = value.namedChild(0);
    if (callee?.type === "identifier" && /^\p{Lu}/u.test(nodeText(callee, source))) return nodeText(callee, source);
  }
  return null;
}

function kotlinLiteralType(value: SyntaxNode, source: string): string | null {
  const text = nodeText(value, source);
  switch (value.type) {
    case "string_literal": return "String";
    case "character_literal": return "Char";
    case "number_literal": return /[uU]/.test(text) && !/^0[xX]/.test(text) ? null : /[lL]$/.test(text) ? "Long" : "Int";
    case "float_literal": return /[fF]$/.test(text) ? "Float" : "Double";
    case "identifier": return text === "true" || text === "false" ? "Boolean" : null;
    default: return null;
  }
}

type DeclarationShape = Pick<
  ExtractedSymbol,
  "declaredType" | "minParams" | "maxParams" | "paramTypes" | "paramNames" | "extensionReceiver"
>;

/** Names of the type parameters in scope at `node`: its own and every enclosing declaration's. */
function typeParameterNames(node: SyntaxNode, source: string): Set<string> {
  const names = new Set<string>();
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    for (const tp of findNamedChild(n, "type_parameters")?.namedChildren ?? []) {
      const id = tp?.type === "type_parameter"
        ? tp.namedChildren.find((c) => c?.type === "identifier" || c?.type === "type_identifier")
        : undefined;
      if (id) names.add(nodeText(id, source));
    }
  }
  return names;
}

/** A parameter's declared type → canonical simple name; null for a type parameter or a non-path type. */
function paramType(typeNode: SyntaxNode | null | undefined, typeParams: Set<string>, source: string): string | null {
  const normalized = typeNode ? normalizeTypeName(nodeText(typeNode, source)) : null;
  return normalized === null || typeParams.has(normalized) ? null : canonicalType(normalized);
}

function declarationShape(node: SyntaxNode, lang: SupportedLanguage, source: string): DeclarationShape {
  const none: DeclarationShape = {
    declaredType: null, minParams: null, maxParams: null, paramTypes: null, paramNames: null, extensionReceiver: null,
  };
  if (lang === "java" && (node.type === "method_declaration" || node.type === "constructor_declaration")) {
    const typeParams = typeParameterNames(node, source);
    const params = node.childForFieldName("parameters");
    const paramTypes: (string | null)[] = [];
    const paramNames: (string | null)[] = [];
    let vararg = false;
    for (const p of params?.namedChildren ?? []) {
      if (p?.type === "formal_parameter") {
        paramTypes.push(paramType(p.childForFieldName("type"), typeParams, source));
        paramNames.push(nodeText(p.childForFieldName("name") ?? p, source));
      } else if (p?.type === "spread_parameter") {
        vararg = true;
        paramTypes.push(null);
        const name = findNamedChild(p, "variable_declarator")?.childForFieldName("name");
        paramNames.push(name ? nodeText(name, source) : null);
      }
    }
    const count = paramTypes.length - (vararg ? 1 : 0);
    const type = node.childForFieldName("type");
    return {
      ...none,
      declaredType: type ? normalizeTypeName(nodeText(type, source)) : null,
      minParams: count,
      maxParams: vararg ? null : count,
      paramTypes,
      paramNames,
    };
  }
  if (lang === "kotlin" && node.type === "function_declaration") {
    const children = node.children.filter((c): c is SyntaxNode => c !== null);
    const paramsAt = children.findIndex((c) => c.type === "function_value_parameters");
    if (paramsAt < 0) return none;
    const typeParams = typeParameterNames(node, source);
    let min = 0;
    let max: number | null = 0;
    let varargNext = false;
    const paramTypes: (string | null)[] = [];
    const paramNames: (string | null)[] = [];
    const params = children[paramsAt].children.filter((c): c is SyntaxNode => c !== null);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.type === "parameter_modifiers") varargNext = nodeText(p, source).includes("vararg");
      if (p.type !== "parameter") continue;
      const vararg = varargNext || nodeText(p, source).startsWith("vararg");
      varargNext = false;
      paramNames.push(nodeText(p.namedChild(0) ?? p, source));
      paramTypes.push(vararg ? null : paramType(p.namedChildren.find((c) => c !== null && KOTLIN_TYPE_NODES.has(c.type)), typeParams, source));
      if (vararg) max = null;
      else {
        if (max !== null) max++;
        if (params[i + 1]?.type !== "=") min++;
      }
    }
    const colon = children[paramsAt + 1]?.type === ":" ? children[paramsAt + 2] : undefined;
    // `fun Foo.name(…)`: the receiver type is the named node before the `.` before the name.
    const nameAt = children.findIndex((c) => c.id === node.childForFieldName("name")?.id);
    const receiver = nameAt >= 2 && children[nameAt - 1].type === "." ? children[nameAt - 2] : undefined;
    return {
      declaredType: colon ? normalizeTypeName(nodeText(colon, source)) : null,
      minParams: min,
      maxParams: max,
      paramTypes,
      paramNames,
      extensionReceiver: receiver ? normalizeTypeName(nodeText(receiver, source)) : null,
    };
  }
  if (lang === "kotlin" && node.type === "property_declaration") {
    const decl = findNamedChild(node, "variable_declaration");
    const eq = node.children.findIndex((c) => c?.type === "=");
    const value = eq >= 0 ? node.children.slice(eq + 1).find((c) => c?.isNamed) : null;
    return { ...none, declaredType: decl ? kotlinVariableType(decl, value, source) : null };
  }
  return none;
}

const CAPTURE_TO_KIND: Record<string, SymbolKind> = {
  class: "class", interface: "interface", enum: "enum",
  method: "method", function: "function", constructor: "constructor",
  object: "object", field: "field", property: "property", type_alias: "type",
};

function getSymbolKind(match: ReturnType<Query["matches"]>[0]): SymbolKind {
  for (const capture of match.captures) {
    const kind = CAPTURE_TO_KIND[capture.name];
    if (kind) return kind;
  }
  return "unknown";
}

function extractSignature(source: string, node: import("web-tree-sitter").SyntaxNode): string | null {
  // Get text from start of node to first { or = (declaration without body)
  // Use source substring as fallback — some tree-sitter WASM builds don't populate .text reliably
  const text = nodeText(node, source);
  if (!text) return null;
  const braceIdx = text.indexOf("{");
  const sig = braceIdx >= 0 ? text.slice(0, braceIdx).trim() : text.split("\n")[0].trim();
  return sig.length > 200 ? sig.slice(0, 200) + "..." : sig;
}

function extractDocComment(
  source: string,
  node: import("web-tree-sitter").SyntaxNode,
): string | null {
  // Look for a comment node immediately before this node
  const prev = node.previousNamedSibling;
  if (prev && (prev.type === "comment" || prev.type === "block_comment" || prev.type === "multiline_comment")) {
    const text = nodeText(prev, source);
    if (text && (text.startsWith("/**") || text.startsWith("///"))) {
      return text
        .replace(/^\/\*\*\s*/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .trim();
    }
  }
  return null;
}

/** From the modifiers node, so an annotation before the keyword does not hide it. */
function extractVisibility(node: SyntaxNode, lang: SupportedLanguage, source: string): string | null {
  const modifiers = findNamedChild(node, "modifiers");
  if (!modifiers) return null;
  if (lang === "kotlin") {
    const v = findNamedChild(modifiers, "visibility_modifier");
    return v ? nodeText(v, source).trim() : null;
  }
  for (const c of modifiers.children) {
    if (c && (c.type === "public" || c.type === "private" || c.type === "protected")) return c.type;
  }
  return null;
}

function checkStatic(node: import("web-tree-sitter").SyntaxNode): boolean {
  const modifiers = findNamedChild(node, "modifiers");
  if (modifiers) return (modifiers.text ?? "").includes("static");
  // Fallback: check the first line of the declaration text
  const firstLine = (node.text ?? "").split("\n")[0];
  return /\bstatic\b/.test(firstLine);
}

/** Build qualified names from extraction result and a package name. */
export function buildQualifiedNames(
  result: ExtractionResult,
): string[] {
  const prefix = result.packageName ? result.packageName + "." : "";
  const qualifiedNames: string[] = [];

  for (let i = 0; i < result.symbols.length; i++) {
    const sym = result.symbols[i];
    if (sym.parentIndex !== null) {
      qualifiedNames.push(qualifiedNames[sym.parentIndex] + "." + sym.name);
    } else {
      qualifiedNames.push(prefix + sym.name);
    }
  }

  return qualifiedNames;
}

/**
 * Map each symbol's in-batch `parentIndex` to its parent's DB id, producing the
 * (childId, parentId) links for a post-insert parent_id update.
 *
 * `symbolDbIds[i]` must correspond to `symbols[i]` — the same positional contract
 * the edge resolver relies on (insert order == RETURNING order for a single INSERT).
 * Only symbols that actually have a parent are returned.
 */
export function buildParentLinks(
  symbols: { parentIndex: number | null }[],
  symbolDbIds: string[],
): { id: string; parent_id: string }[] {
  const links: { id: string; parent_id: string }[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const parentIndex = symbols[i].parentIndex;
    if (parentIndex === null) continue;
    const id = symbolDbIds[i];
    const parentId = symbolDbIds[parentIndex];
    if (id && parentId) links.push({ id, parent_id: parentId });
  }
  return links;
}

/** Convert extraction result to SymbolInsert array. Requires file_id and resolved parent DB ids. */
export function toSymbolInserts(
  result: ExtractionResult,
  fileId: string,
  qualifiedNames: string[],
  parentDbIds: (string | null)[],
): SymbolInsert[] {
  return result.symbols.map((sym, i) => ({
    file_id: fileId,
    name: sym.name,
    qualified_name: qualifiedNames[i],
    kind: sym.kind,
    parent_id: parentDbIds[i],
    start_line: sym.startLine,
    end_line: sym.endLine,
    signature: sym.signature,
    doc_comment: sym.docComment,
    visibility: sym.visibility,
    is_static: sym.isStatic,
    declared_type: sym.declaredType,
    min_params: sym.minParams,
    max_params: sym.maxParams,
    param_types: sym.paramTypes,
    param_names: sym.paramNames,
    extension_receiver: sym.extensionReceiver,
  }));
}
