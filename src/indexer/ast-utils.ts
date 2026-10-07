import type { Node as SyntaxNode } from "web-tree-sitter";

/** Get node text with fallback for WASM builds where .text can be undefined. */
export function nodeText(node: SyntaxNode, source: string): string {
  return node.text ?? source.slice(node.startIndex, node.endIndex);
}

export function walkTree(node: SyntaxNode, visitor: (node: SyntaxNode) => void) {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i)!, visitor);
  }
}

export function findNamedChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === type) return child;
  }
  return null;
}
