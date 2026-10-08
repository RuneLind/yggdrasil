import type { SupportedLanguage } from "./parser.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import { CONTAINER_KINDS, normalizeTypeName } from "./symbol-extractor.ts";
import { nodeText, walkTree, findNamedChild } from "./ast-utils.ts";
import { extractJavaCalls, extractKotlinCalls, type ExtractedCall } from "./scope-walk.ts";
import type { Node as SyntaxNode } from "web-tree-sitter";

export { classifyReceiver, type ExtractedCall, type ReceiverKind } from "./scope-walk.ts";

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
      } else if (firstChild.type === "user_type" || firstChild.type === "explicit_delegation") {
        // `I by impl` (explicit_delegation) implements I like a plain `I`.
        const userType = firstChild.type === "user_type" ? firstChild : findNamedChild(firstChild, "user_type");
        const typeName = userType && normalizeTypeName(nodeText(userType, source));
        if (typeName) inheritance.push({ kind: "implements", typeName, symbolIndex });
      }
    }
  });
}
