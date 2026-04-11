import type { SupportedLanguage } from "./parser.ts";
import type { ExtractionResult } from "./symbol-extractor.ts";
import type { SyntaxNode } from "web-tree-sitter";

export interface ExtractedCall {
  /** The receiver expression text (e.g., "behandlingService" or "this") */
  receiver: string | null;
  /** The method/function name being called */
  methodName: string;
  /** Line number of the call */
  line: number;
}

export interface ExtractedInheritance {
  /** "extends" or "implements" */
  kind: "extends" | "implements";
  /** The supertype name (simple name, not qualified) */
  typeName: string;
  /** The symbol that declares this inheritance (class/interface index in extraction result) */
  symbolIndex: number;
}

export interface CallGraphResult {
  calls: ExtractedCall[];
  inheritance: ExtractedInheritance[];
}

/** Extract call expressions and inheritance relationships from a parsed tree. */
export function extractCallGraph(
  source: string,
  tree: ReturnType<import("web-tree-sitter").Parser["parse"]>,
  lang: SupportedLanguage,
  extraction: ExtractionResult,
): CallGraphResult {
  const calls: ExtractedCall[] = [];
  const inheritance: ExtractedInheritance[] = [];

  if (lang === "java") {
    extractJavaCalls(tree.rootNode, source, calls);
    extractJavaInheritance(tree.rootNode, source, extraction, inheritance);
  } else if (lang === "kotlin") {
    extractKotlinCalls(tree.rootNode, source, calls);
    extractKotlinInheritance(tree.rootNode, source, extraction, inheritance);
  }

  return { calls, inheritance };
}

// ── Java ──

function extractJavaCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]) {
  walkTree(root, (node) => {
    if (node.type !== "method_invocation") return;

    const nameNode = node.childForFieldName("name");
    const objectNode = node.childForFieldName("object");
    if (!nameNode) return;

    const methodName = nodeText(nameNode, source);
    const receiver = objectNode ? nodeText(objectNode, source) : null;

    calls.push({
      receiver,
      methodName,
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

    // Find the index of this class in the extraction result
    const symbolIndex = extraction.symbols.findIndex(
      (s) => s.name === className && (s.kind === "class" || s.kind === "interface"),
    );
    if (symbolIndex < 0) return;

    // extends
    const superclassNode = node.childForFieldName("superclass");
    if (superclassNode) {
      const typeNode = findNamedChild(superclassNode, "type_identifier");
      if (typeNode) {
        inheritance.push({
          kind: "extends",
          typeName: nodeText(typeNode, source),
          symbolIndex,
        });
      }
    }

    // implements
    const interfacesNode = node.childForFieldName("interfaces");
    if (interfacesNode) {
      // super_interfaces → type_list → type_identifier*
      const typeList = findNamedChild(interfacesNode, "type_list");
      if (typeList) {
        for (let i = 0; i < typeList.namedChildCount; i++) {
          const child = typeList.namedChild(i)!;
          // Could be type_identifier or generic_type
          const typeName = child.type === "generic_type"
            ? nodeText(findNamedChild(child, "type_identifier")!, source)
            : nodeText(child, source);
          if (typeName) {
            inheritance.push({
              kind: "implements",
              typeName,
              symbolIndex,
            });
          }
        }
      }
    }
  });
}

// ── Kotlin ──

function extractKotlinCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]) {
  walkTree(root, (node) => {
    if (node.type !== "call_expression") return;

    // call_expression children: navigation_expression (receiver.method) + value_arguments
    // or: identifier (simple function call) + value_arguments
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    if (firstChild.type === "navigation_expression") {
      // receiver.method(...)
      const parts = firstChild.namedChildren;
      if (parts.length >= 2) {
        const receiver = nodeText(parts[0], source);
        const methodName = nodeText(parts[parts.length - 1], source);
        calls.push({ receiver, methodName, line: node.startPosition.row + 1 });
      }
    } else if (firstChild.type === "identifier") {
      // direct function call: functionName(...)
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
    if (node.type !== "class_declaration" && node.type !== "object_declaration") return;

    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const className = nodeText(nameNode, source);

    const symbolIndex = extraction.symbols.findIndex(
      (s) => s.name === className && (s.kind === "class" || s.kind === "object"),
    );
    if (symbolIndex < 0) return;

    // delegation_specifiers → delegation_specifier*
    const delegationSpecs = findNamedChild(node, "delegation_specifiers");
    if (!delegationSpecs) return;

    for (let i = 0; i < delegationSpecs.namedChildCount; i++) {
      const spec = delegationSpecs.namedChild(i)!;
      if (spec.type !== "delegation_specifier") continue;

      const firstChild = spec.namedChild(0);
      if (!firstChild) continue;

      if (firstChild.type === "constructor_invocation") {
        // extends a class: constructor_invocation → user_type
        const userType = findNamedChild(firstChild, "user_type");
        if (userType) {
          const typeName = nodeText(findNamedChild(userType, "identifier") ?? userType, source);
          inheritance.push({ kind: "extends", typeName, symbolIndex });
        }
      } else if (firstChild.type === "user_type") {
        // implements an interface: user_type directly
        const typeName = nodeText(findNamedChild(firstChild, "identifier") ?? firstChild, source);
        inheritance.push({ kind: "implements", typeName, symbolIndex });
      }
    }
  });
}

// ── Helpers ──

function nodeText(node: SyntaxNode, source: string): string {
  return node.text ?? source.slice(node.startIndex, node.endIndex);
}

function walkTree(node: SyntaxNode, visitor: (node: SyntaxNode) => void) {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i)!, visitor);
  }
}

function findNamedChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === type) return child;
  }
  return null;
}
