import type { SupportedLanguage } from "./parser.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import { CONTAINER_KINDS } from "./symbol-extractor.ts";
import { nodeText, walkTree, findNamedChild } from "./ast-utils.ts";
import type { SyntaxNode } from "web-tree-sitter";

export interface ExtractedCall {
  receiver: string | null;
  methodName: string;
  line: number;
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

    calls.push({
      receiver: objectNode ? nodeText(objectNode, source) : null,
      methodName: nodeText(nameNode, source),
      line: node.startPosition.row + 1,
    });
  });
}

function extractJavaInheritance(
  root: SyntaxNode,
  source: string,
  extraction: ExtractionResult,
  inheritance: ExtractedInheritance[],
) {
  walkTree(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "interface_declaration") return;

    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nodeText(nameNode, source);

    const symbolIndex = extraction.symbols.findIndex(
      (s) => s.name === className && CONTAINER_KINDS.has(s.kind),
    );
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
        const typeNode = findNamedChild(superclassNode, "type_identifier");
        if (typeNode) {
          inheritance.push({ kind: "extends", typeName: nodeText(typeNode, source), symbolIndex });
        }
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

/** Extract type names from a type_list node (handles both type_identifier and generic_type). */
function extractTypeListNames(typeList: SyntaxNode, source: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < typeList.namedChildCount; i++) {
    const child = typeList.namedChild(i)!;
    const typeNode = child.type === "generic_type"
      ? findNamedChild(child, "type_identifier")
      : child;
    if (typeNode) names.push(nodeText(typeNode, source));
  }
  return names;
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
        calls.push({
          receiver: nodeText(parts[0], source),
          methodName: nodeText(parts[parts.length - 1], source),
          line: node.startPosition.row + 1,
        });
      }
    } else if (firstChild.type === "identifier") {
      calls.push({
        receiver: null,
        methodName: nodeText(firstChild, source),
        line: node.startPosition.row + 1,
      });
    }
  });
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

    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nodeText(nameNode, source);

    const symbolIndex = extraction.symbols.findIndex(
      (s) => s.name === className && CONTAINER_KINDS.has(s.kind),
    );
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
        if (userType) {
          const typeName = nodeText(findNamedChild(userType, "identifier") ?? userType, source);
          inheritance.push({ kind: "extends", typeName, symbolIndex });
        }
      } else if (firstChild.type === "user_type") {
        const typeName = nodeText(findNamedChild(firstChild, "identifier") ?? firstChild, source);
        inheritance.push({ kind: "implements", typeName, symbolIndex });
      }
    }
  });
}
