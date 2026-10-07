import { Query, type Language } from "web-tree-sitter";
import type { SupportedLanguage } from "./parser.ts";
import type { SymbolInsert } from "../db/symbols.ts";
import { nodeText, findNamedChild } from "./ast-utils.ts";

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
      const visibility = extractVisibility(patternNode, lang);
      const name = nodeText(nameNode, source);

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
      });
    }
  }

  // Resolve parent indices by checking line containment
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) continue;
      const candidate = symbols[j];
      if (
        CONTAINER_KINDS.has(candidate.kind) &&
        sym.startLine >= candidate.startLine &&
        sym.endLine <= candidate.endLine
      ) {
        // Pick the tightest enclosing parent
        if (
          sym.parentIndex === null ||
          (candidate.startLine >= symbols[sym.parentIndex].startLine &&
            candidate.endLine <= symbols[sym.parentIndex].endLine)
        ) {
          sym.parentIndex = j;
        }
      }
    }
  }

  return { packageName, symbols, imports };
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

function extractVisibility(
  node: import("web-tree-sitter").SyntaxNode,
  lang: SupportedLanguage,
): string | null {
  const text = node.text ?? "";
  if (text.startsWith("public ")) return "public";
  if (text.startsWith("private ")) return "private";
  if (text.startsWith("protected ")) return "protected";
  if (lang === "kotlin" && text.startsWith("internal ")) return "internal";
  // Kotlin: check modifiers child
  if (lang === "kotlin") {
    const modifiers = node.childForFieldName?.("modifiers") ?? findNamedChild(node, "modifiers");
    if (modifiers) {
      const modText = modifiers.text ?? "";
      if (modText.includes("private")) return "private";
      if (modText.includes("internal")) return "internal";
      if (modText.includes("protected")) return "protected";
    }
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
  }));
}
