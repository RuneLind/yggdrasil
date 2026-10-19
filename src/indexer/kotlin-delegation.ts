import type { Node as SyntaxNode } from "web-tree-sitter";
import { nodeText, walkTree } from "./ast-utils.ts";

/**
 * tree-sitter-kotlin can read the body of a delegating class (`class X(d: I) : I by d { … }`)
 * as a trailing lambda on the delegate expression; kotlinc always reads a `{` after a
 * by-clause as the class body. Whether it happens depends on the body's content and
 * layout, not only on the class's position: seen for the last declaration of a file, a
 * one-line body or companion nested anywhere, and a delegate ending in a call
 * (`by d ?: Impl() { … }`) in any position. So the body is found by shape, not position.
 */

/** Nodes whose rightmost operand is an expression, so a trailing lambda on it ends them. */
const SPINE: ReadonlySet<string> = new Set([
  "binary_expression", "if_expression", "infix_expression", "range_expression", "annotated_expression", "throw_expression",
]);

function lastNamed(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildCount > 0 ? node.namedChild(node.namedChildCount - 1) : null;
}

const DECLARATIONS: ReadonlySet<string> = new Set(["class_declaration", "object_declaration", "companion_object"]);

/**
 * The lambda_literal that is `decl`'s class body when the grammar misparsed it, else null.
 * It is the trailing lambda of the call at the end of the rightmost expression spine of
 * the last delegation specifier's delegate. A lambda in parentheses or an argument list
 * and an object literal are not on that spine.
 */
export function misparsedKotlinClassBody(decl: SyntaxNode): SyntaxNode | null {
  if (!DECLARATIONS.has(decl.type)) return null;
  // explicit_delegation sits only in delegation_specifiers > delegation_specifier, so this
  // also finds that the declaration ends in its delegation specifiers: it has no class body.
  const specs = lastNamed(decl);
  const spec = specs ? lastNamed(specs) : null;
  const delegation = spec ? lastNamed(spec) : null;
  if (delegation?.type !== "explicit_delegation") return null;
  let expr = lastNamed(delegation);
  while (expr && SPINE.has(expr.type)) expr = lastNamed(expr);
  return expr ? trailingLambda(expr) : null;
}

/** `f { … }` → its lambda_literal: annotated_lambda sits only in a call and ends in its lambda. */
function trailingLambda(call: SyntaxNode): SyntaxNode | null {
  const trailing = lastNamed(call);
  return trailing?.type === "annotated_lambda" ? lastNamed(trailing) : null;
}

/**
 * Inside a misparsed class body, the grammar reads `companion object { … }` as
 * `infix_expression(companion, object, lambda_literal)`, `companion object Name { … }` as
 * `infix_expression(companion, object, call_expression(Name, annotated_lambda))` and
 * `init { … }` as `call_expression(init, annotated_lambda)`. The lambda of such a member.
 */
export function misparsedKotlinMember(member: SyntaxNode, source: string): { kind: "companion" | "init"; lambda: SyntaxNode } | null {
  const parts = member.namedChildren.filter((c): c is SyntaxNode => c !== null);
  if (member.type === "call_expression" && nodeText(parts[0], source) === "init") {
    const lambda = trailingLambda(member);
    return lambda ? { kind: "init", lambda } : null;
  }
  if (member.type !== "infix_expression" || nodeText(parts[0], source) !== "companion" || nodeText(parts[1], source) !== "object") return null;
  const lambda = parts[2].type === "lambda_literal" ? parts[2] : trailingLambda(parts[2]);
  return lambda ? { kind: "companion", lambda } : null;
}

export type MisparsedLambda = { kind: "body" | "companion" | "init"; decl: SyntaxNode };

/**
 * Every misparsed class body in the tree, and the companion and init lambdas directly
 * inside one, by lambda_literal node id; `decl` is the class, object or companion.
 */
export function misparsedKotlinLambdas(root: SyntaxNode, source: string): Map<number, MisparsedLambda> {
  const out = new Map<number, MisparsedLambda>();
  walkTree(root, (n) => {
    const body = misparsedKotlinClassBody(n);
    if (!body) return;
    out.set(body.id, { kind: "body", decl: n });
    for (const m of body.namedChildren) {
      const member = m ? misparsedKotlinMember(m, source) : null;
      if (member) out.set(member.lambda.id, { kind: member.kind, decl: n });
    }
  });
  return out;
}
