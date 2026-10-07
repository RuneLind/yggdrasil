import type { Node as SyntaxNode } from "web-tree-sitter";
import { nodeText, findNamedChild } from "./ast-utils.ts";
import { normalizeTypeName, kotlinVariableType } from "./symbol-extractor.ts";
import { canonicalType } from "./overloads.ts";

/**
 * One pass over a file's AST that keeps a stack of scopes and records every call with the
 * declared type of its receiver variable, its argument types and names, and (Kotlin) the
 * implicit receiver of an enclosing `with`/`apply`/`run` lambda.
 *
 * Each scope's declarations are read once, when the walk enters it; a block adds a local
 * after walking its declaration, so a call sees only locals declared before it (and not
 * the one its own initializer declares). Java fields and Kotlin constructor properties
 * are not symbols, and stored property symbols include function-local `val`s, so this
 * reads the AST, not ci_symbols.
 */

export type ReceiverKind = "none" | "this" | "identifier" | "static-type" | "chain-or-expression";

export interface ExtractedCall {
  /** Normalized: `this.`, `this@Label.`, `!!` and a trailing `.Companion` removed. */
  receiver: string | null;
  receiverKind: ReceiverKind;
  /** Declared type of a single-identifier receiver found in scope, else null. */
  receiverType: string | null;
  methodName: string;
  /** Positional and named arguments plus a Kotlin trailing lambda; null for a spread. */
  argCount: number | null;
  /** Per argument: canonical type when cheap and certain (see argType), else null. */
  argTypes: (string | null)[];
  /** Per argument: the Kotlin parameter name of a named argument; null when none is named. */
  argNames: (string | null)[] | null;
  /** Kotlin: declared type of the receiver of the innermost enclosing with/apply/run lambda. */
  implicitReceiverType: string | null;
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
 * qualified name, which is always an identifier path. A single uppercase name declared
 * as a variable in scope is reclassified as `identifier` (see withType).
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

/** A declaration's type: normalized, or null when declared without a usable type. */
type Decl = string | null;

interface Frame {
  names: Map<string, Decl>;
  /** Class bodies: the class's simple name, null for an anonymous class or object literal. */
  className?: string | null;
  /**
   * Kotlin: the type `this` means here, when this frame changes it: an extension
   * function's receiver, a with/apply/run lambda's receiver, null for another lambda.
   */
  thisType?: string | null;
  /** Kotlin with/apply/run lambdas only: the receiver's declared type (null: unknown). */
  implicitReceiver?: string | null;
}

class Scope {
  private frames: Frame[] = [];

  push(frame: Frame): void {
    this.frames.push(frame);
  }

  pop(): void {
    this.frames.pop();
  }

  /** Innermost frame. */
  top(): Frame {
    return this.frames[this.frames.length - 1];
  }

  /** The innermost declaration of `name`; undefined when nothing in scope declares it. */
  lookup(name: string): Decl | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const found = this.frames[i].names.get(name);
      if (found !== undefined || this.frames[i].names.has(name)) return found;
    }
    return undefined;
  }

  /**
   * `this.x` / `this@Label.x`: `name` among the members of the innermost class body, or
   * of the class body named `label`. Null when that class does not declare it.
   */
  member(name: string, label: string | null): Decl {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.className === undefined || (label !== null && f.className !== label)) continue;
      return f.names.get(name) ?? null;
    }
    return null;
  }

  /** What an unqualified `this` refers to, by simple name; null when unknown. */
  thisType(): string | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.thisType !== undefined) return f.thisType;
      if (f.className !== undefined) return f.className;
    }
    return null;
  }

  /** Kotlin: the innermost with/apply/run receiver type, not looking past a class body. */
  implicitReceiver(): string | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i];
      if (f.implicitReceiver !== undefined) return f.implicitReceiver;
      if (f.className !== undefined) return null;
    }
    return null;
  }
}

interface Receiver {
  receiver: string | null;
  receiverKind: ReceiverKind;
  receiverType: string | null;
}

/**
 * Normalize the receiver text and, for a single identifier, look up its declaration. A
 * declared variable is an `identifier` receiver even when named like a class, so an
 * untyped `val Foo = …` is never resolved as the class Foo.
 */
function withType(text: string, lookup: (name: string) => Decl | undefined): Receiver {
  const receiver = text.endsWith(".Companion") && classifyReceiver(text) === "static-type"
    ? text.slice(0, -".Companion".length)
    : text;
  const kind = classifyReceiver(receiver);
  if ((kind === "identifier" || kind === "static-type") && !receiver.includes(".")) {
    const found = lookup(receiver);
    if (found !== undefined) return { receiver, receiverKind: "identifier", receiverType: found };
  }
  return { receiver, receiverKind: kind, receiverType: null };
}

const NONE: Receiver = { receiver: null, receiverKind: "none", receiverType: null };

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function all(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((c): c is SyntaxNode => c !== null);
}

const declType = (d: Decl | undefined): string | null => (d ? canonicalType(d) : null);

// ── Java ──

function javaType(node: SyntaxNode | null, source: string): Decl {
  if (!node) return null;
  const text = nodeText(node, source);
  return text === "var" ? null : normalizeTypeName(text);
}

function addJavaDeclarators(decl: SyntaxNode, names: Map<string, Decl>, source: string): void {
  const type = javaType(decl.childForFieldName("type"), source);
  for (const d of decl.childrenForFieldName("declarator")) {
    if (d) names.set(nodeText(d.childForFieldName("name") ?? d, source), type);
  }
}

function javaClassFrame(body: SyntaxNode, source: string): Frame {
  const names = new Map<string, Decl>();
  const members = body.type === "enum_body" ? named(findNamedChild(body, "enum_body_declarations") ?? body) : named(body);
  for (const m of members) {
    if (m.type === "field_declaration" || m.type === "constant_declaration") addJavaDeclarators(m, names, source);
  }
  const owner = body.parent;
  // Record components are fields of the record.
  if (owner?.type === "record_declaration") {
    for (const p of named(owner.childForFieldName("parameters") ?? owner)) {
      if (p.type === "formal_parameter") names.set(nodeText(p.childForFieldName("name") ?? p, source), javaType(p.childForFieldName("type"), source));
    }
  }
  const nameNode = owner && owner.type !== "object_creation_expression" ? owner.childForFieldName("name") : null;
  return { names, className: nameNode ? nodeText(nameNode, source) : null };
}

function javaParamFrame(owner: SyntaxNode, source: string): Frame {
  const names = new Map<string, Decl>();
  const params = owner.childForFieldName("parameters");
  if (params?.type === "identifier") names.set(nodeText(params, source), null);
  for (const p of params ? named(params) : []) {
    if (p.type === "formal_parameter") names.set(nodeText(p.childForFieldName("name") ?? p, source), javaType(p.childForFieldName("type"), source));
    else if (p.type === "spread_parameter") {
      const n = findNamedChild(p, "variable_declarator")?.childForFieldName("name");
      if (n) names.set(nodeText(n, source), null);
    } else if (p.type === "identifier") names.set(nodeText(p, source), null);
  }
  return { names };
}

/** Pattern variables under `node` (type patterns, record pattern components) → `names`. */
function addJavaPatternBindings(node: SyntaxNode, names: Map<string, Decl>, source: string): void {
  if (node.type === "type_pattern" || node.type === "record_pattern_component") {
    const parts = named(node);
    const id = parts[parts.length - 1];
    if (parts.length >= 2 && id.type === "identifier") names.set(nodeText(id, source), javaType(parts[0], source));
    return;
  }
  for (const c of named(node)) addJavaPatternBindings(c, names, source);
}

const JAVA_CLASS_BODIES: ReadonlySet<string> = new Set(["class_body", "interface_body", "enum_body"]);
const JAVA_BLOCKS: ReadonlySet<string> = new Set(["block", "constructor_body", "switch_block_statement_group", "switch_rule"]);
const JAVA_PARAMETER_OWNERS: ReadonlySet<string> = new Set(["method_declaration", "constructor_declaration", "lambda_expression"]);
const JAVA_INT_LITERALS: ReadonlySet<string> = new Set([
  "decimal_integer_literal", "hex_integer_literal", "octal_integer_literal", "binary_integer_literal",
]);

function javaArgType(arg: SyntaxNode, scope: Scope, source: string): string | null {
  const text = () => nodeText(arg, source);
  if (JAVA_INT_LITERALS.has(arg.type)) return /[lL]$/.test(text()) ? "long" : "#int";
  switch (arg.type) {
    case "string_literal":
    case "text_block":
      return "String";
    case "character_literal":
      return "char";
    case "decimal_floating_point_literal":
    case "hex_floating_point_literal":
      return /[fF]$/.test(text()) ? "float" : "double";
    case "true":
    case "false":
      return "boolean";
    case "this":
      return scope.thisType();
    case "object_creation_expression":
      return declType(javaType(arg.childForFieldName("type"), source));
    case "identifier":
      return declType(scope.lookup(text()));
    case "parenthesized_expression":
    case "unary_expression": {
      const inner = named(arg)[0];
      const op = arg.childForFieldName("operator")?.type;
      if (!inner || (arg.type === "unary_expression" && op !== "-" && op !== "+")) return null;
      const t = javaArgType(inner, scope, source);
      return arg.type === "parenthesized_expression" || t === "#int" || t === "long" || t === "double" || t === "float" ? t : null;
    }
    default:
      return null;
  }
}

/** `this.x` names a field; strip it so the lookup reads the class's members only. */
function javaReceiver(objectNode: SyntaxNode | null, scope: Scope, source: string): Receiver {
  if (!objectNode) return NONE;
  if (objectNode.type === "field_access" && objectNode.childForFieldName("object")?.type === "this") {
    const field = objectNode.childForFieldName("field") ?? objectNode;
    return withType(nodeText(field, source), (name) => scope.member(name, null));
  }
  return withType(nodeText(objectNode, source), (name) => scope.lookup(name));
}

export function extractJavaCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]): void {
  const scope = new Scope();

  const visitChildren = (node: SyntaxNode) => {
    for (const c of all(node)) visit(c);
  };

  const visit = (node: SyntaxNode): void => {
    if (JAVA_CLASS_BODIES.has(node.type)) {
      scope.push(javaClassFrame(node, source));
      visitChildren(node);
      scope.pop();
      return;
    }
    if (JAVA_PARAMETER_OWNERS.has(node.type)) {
      scope.push(javaParamFrame(node, source));
      visitChildren(node);
      scope.pop();
      return;
    }
    if (JAVA_BLOCKS.has(node.type)) {
      const frame: Frame = { names: new Map() };
      scope.push(frame);
      for (const c of all(node)) {
        visit(c);
        if (c.type === "local_variable_declaration") addJavaDeclarators(c, frame.names, source);
      }
      scope.pop();
      return;
    }
    const frame = javaStatementFrame(node, source);
    if (frame) {
      scope.push(frame);
      visitChildren(node);
      scope.pop();
      return;
    }
    if (node.type === "method_invocation") recordJavaCall(node);
    visitChildren(node);
    // Pattern variables stay in scope for the rest of the enclosing block (an
    // approximation of flow scoping: the then-branch and after a negated test).
    if (node.type === "instanceof_expression") {
      const name = node.childForFieldName("name");
      if (name) scope.top().names.set(nodeText(name, source), javaType(node.childForFieldName("right"), source));
      else addJavaPatternBindings(node, scope.top().names, source);
    } else if (node.type === "switch_label") {
      addJavaPatternBindings(node, scope.top().names, source);
    }
  };

  const recordJavaCall = (node: SyntaxNode) => {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const args = node.childForFieldName("arguments");
    const argNodes = args ? named(args).filter((c) => c.type !== "line_comment" && c.type !== "block_comment") : [];
    calls.push({
      ...javaReceiver(node.childForFieldName("object"), scope, source),
      methodName: nodeText(nameNode, source),
      argCount: argNodes.length,
      argTypes: argNodes.map((a) => javaArgType(a, scope, source)),
      argNames: null,
      implicitReceiverType: null,
      line: node.startPosition.row + 1,
      startIndex: node.startIndex,
    });
  };

  scope.push({ names: new Map() });
  visit(root);
}

/** Declarations a Java statement scopes over its whole subtree, or null. */
function javaStatementFrame(n: SyntaxNode, source: string): Frame | null {
  const names = new Map<string, Decl>();
  if (n.type === "enhanced_for_statement") {
    names.set(nodeText(n.childForFieldName("name") ?? n, source), javaType(n.childForFieldName("type"), source));
  } else if (n.type === "for_statement") {
    for (const init of n.childrenForFieldName("init")) {
      if (init?.type === "local_variable_declaration") addJavaDeclarators(init, names, source);
    }
  } else if (n.type === "catch_clause") {
    const param = findNamedChild(n, "catch_formal_parameter");
    if (!param) return null;
    // A multi-catch variable's type is the types' least upper bound: unknown here.
    const types = named(findNamedChild(param, "catch_type") ?? param);
    names.set(nodeText(param.childForFieldName("name") ?? param, source), types.length === 1 ? javaType(types[0], source) : null);
  } else if (n.type === "try_with_resources_statement") {
    for (const r of named(findNamedChild(n, "resource_specification") ?? n)) {
      const name = r.type === "resource" ? r.childForFieldName("name") : null;
      if (name) names.set(nodeText(name, source), javaType(r.childForFieldName("type"), source));
    }
  } else {
    return null;
  }
  return { names };
}

// ── Kotlin ──

const KOTLIN_CLASS_BODIES: ReadonlySet<string> = new Set(["class_body", "enum_class_body"]);
const KOTLIN_BLOCKS: ReadonlySet<string> = new Set(["block", "statements"]);
const KOTLIN_PARAMETER_OWNERS: ReadonlySet<string> = new Set(["function_declaration", "secondary_constructor", "anonymous_function"]);
/** Scope functions whose lambda takes the receiver as `this`; let/also take it as `it`. */
const RECEIVER_SCOPE_FUNCTIONS: ReadonlySet<string> = new Set(["apply", "run"]);

/** Every name a property declaration declares (`val (a, b) = …` declares both, untyped). */
function addKotlinProperty(prop: SyntaxNode, names: Map<string, Decl>, source: string): void {
  const decl = findNamedChild(prop, "variable_declaration");
  if (!decl) {
    for (const d of named(findNamedChild(prop, "multi_variable_declaration") ?? prop)) {
      if (d.type === "variable_declaration") names.set(nodeText(d.namedChild(0) ?? d, source), null);
    }
    return;
  }
  const children = all(prop);
  const eq = children.findIndex((c) => c.type === "=");
  const value = eq >= 0 ? children.slice(eq + 1).find((c) => c.isNamed) : null;
  names.set(nodeText(decl.namedChild(0) ?? decl, source), kotlinVariableType(decl, value, source));
}

/** A variable_declaration (typed or not) or a destructuring multi_variable_declaration. */
function addKotlinVariable(d: SyntaxNode, names: Map<string, Decl>, source: string): void {
  if (d.type === "variable_declaration") names.set(nodeText(d.namedChild(0) ?? d, source), kotlinVariableType(d, null, source));
  else if (d.type === "multi_variable_declaration") {
    for (const v of named(d)) if (v.type === "variable_declaration") names.set(nodeText(v.namedChild(0) ?? v, source), null);
  }
}

function kotlinClassParameters(body: SyntaxNode): SyntaxNode[] {
  const ctor = body.parent?.type === "class_declaration" ? findNamedChild(body.parent, "primary_constructor") : null;
  return ctor ? named(findNamedChild(ctor, "class_parameters") ?? ctor).filter((p) => p.type === "class_parameter") : [];
}

function kotlinClassFrame(body: SyntaxNode, source: string): { frame: Frame; ctorParams: Map<string, Decl> } {
  const names = new Map<string, Decl>();
  for (const m of named(body)) if (m.type === "property_declaration") addKotlinProperty(m, names, source);
  // Constructor properties (`val`/`var`) are members; every constructor parameter is in
  // scope in property initializers and init blocks, where it shadows a member.
  const ctorParams = new Map<string, Decl>();
  for (const p of kotlinClassParameters(body)) {
    const name = nodeText(findNamedChild(p, "identifier") ?? p, source);
    const type = kotlinVariableType(p, null, source);
    ctorParams.set(name, type);
    if (all(p).some((c) => c.type === "val" || c.type === "var")) names.set(name, type);
  }
  const owner = body.parent;
  const nameNode = owner && (owner.type === "class_declaration" || owner.type === "object_declaration")
    ? owner.childForFieldName("name") ?? findNamedChild(owner, "identifier")
    : null;
  return { frame: { names, className: nameNode ? nodeText(nameNode, source) : null }, ctorParams };
}

function kotlinParamFrame(owner: SyntaxNode, source: string): Frame {
  const names = new Map<string, Decl>();
  for (const p of named(findNamedChild(owner, "function_value_parameters") ?? owner)) {
    if (p.type === "parameter") names.set(nodeText(p.namedChild(0) ?? p, source), kotlinVariableType(p, null, source));
  }
  const frame: Frame = { names };
  if (owner.type === "function_declaration") {
    const children = all(owner);
    const nameAt = children.findIndex((c) => c.id === owner.childForFieldName("name")?.id);
    if (nameAt >= 2 && children[nameAt - 1].type === ".") {
      const t = normalizeTypeName(nodeText(children[nameAt - 2], source));
      frame.thisType = t ? canonicalType(t) : null;
    }
  }
  return frame;
}

function kotlinArgType(arg: SyntaxNode, scope: Scope, source: string): string | null {
  const text = nodeText(arg, source);
  switch (arg.type) {
    case "string_literal":
      return "String";
    case "character_literal":
      return "char";
    case "number_literal":
      return /[uU]/.test(text) && !/^0[xX]/.test(text) ? null : /[lL]$/.test(text) ? "long" : "#int";
    case "float_literal":
      return /[fF]$/.test(text) ? "float" : "double";
    case "identifier":
      if (text === "true" || text === "false") return "boolean";
      if (text === "null") return null;
      return declType(scope.lookup(text));
    case "this_expression": {
      const label = findNamedChild(arg, "identifier");
      return label ? nodeText(label, source) : scope.thisType();
    }
    case "call_expression": {
      const callee = arg.namedChild(0);
      return callee?.type === "identifier" && /^\p{Lu}/u.test(nodeText(callee, source)) ? canonicalType(nodeText(callee, source)) : null;
    }
    case "parenthesized_expression":
    case "unary_expression": {
      const inner = named(arg)[0];
      if (!inner || (arg.type === "unary_expression" && !text.startsWith("-") && !text.startsWith("+"))) return null;
      const t = kotlinArgType(inner, scope, source);
      return arg.type === "parenthesized_expression" || t === "#int" || t === "long" || t === "double" || t === "float" ? t : null;
    }
    default:
      return null;
  }
}

/** The declared type of an expression used as a scope function's receiver, when cheap. */
function kotlinExpressionType(expr: SyntaxNode, scope: Scope, source: string): string | null {
  if (expr.type === "identifier") return scope.lookup(nodeText(expr, source)) ?? null;
  if (expr.type === "this_expression") return findNamedChild(expr, "identifier") ? null : scope.thisType();
  if (expr.type === "call_expression") return kotlinArgType(expr, scope, source);
  const r = kotlinReceiver(expr, scope, source);
  return r.receiverKind === "identifier" ? r.receiverType : null;
}

/**
 * For a lambda passed to `x.apply`, `x.run` or `with(x)`, the declared type of x (null
 * when unknown); undefined for any other lambda.
 */
function scopeFunctionReceiver(lambda: SyntaxNode, scope: Scope, source: string): string | null | undefined {
  const annotated = lambda.parent;
  const call = annotated?.type === "annotated_lambda" ? annotated.parent : null;
  if (call?.type !== "call_expression") return undefined;
  const callee = call.namedChild(0);
  if (callee?.type === "navigation_expression" && callee.namedChildCount === 2) {
    const fn = callee.namedChild(1)!;
    if (fn.type === "identifier" && RECEIVER_SCOPE_FUNCTIONS.has(nodeText(fn, source))) {
      return kotlinExpressionType(callee.namedChild(0)!, scope, source);
    }
  }
  if (callee?.type === "call_expression" && nodeText(callee.namedChild(0) ?? callee, source) === "with") {
    const args = named(findNamedChild(callee, "value_arguments") ?? callee).filter((a) => a.type === "value_argument");
    const expr = args.length === 1 ? named(args[0])[0] : undefined;
    return expr ? kotlinExpressionType(expr, scope, source) : null;
  }
  return undefined;
}

function kotlinLambdaFrame(lambda: SyntaxNode, scope: Scope, source: string): Frame {
  const names = new Map<string, Decl>();
  const params = findNamedChild(lambda, "lambda_parameters");
  if (params) for (const d of named(params)) addKotlinVariable(d, names, source);
  // A lambda without parameters may take an implicit `it`; its type is unknown here.
  else names.set("it", null);
  const receiver = scopeFunctionReceiver(lambda, scope, source);
  const frame: Frame = { names, thisType: receiver === undefined || receiver === null ? null : canonicalType(receiver) };
  if (receiver !== undefined) frame.implicitReceiver = receiver;
  return frame;
}

/** Strip `x!!`, `this.x` and `this@Label.x` before the lookup. */
function kotlinReceiver(node: SyntaxNode, scope: Scope, source: string): Receiver {
  let label: string | null | undefined;
  for (;;) {
    if (node.type === "unary_expression" && node.childForFieldName("operator")?.type === "!!") {
      node = node.childForFieldName("argument") ?? node;
    } else if (node.type === "navigation_expression" && node.namedChildCount === 2 && node.namedChild(0)?.type === "this_expression") {
      const labelNode = findNamedChild(node.namedChild(0)!, "identifier");
      label = labelNode ? nodeText(labelNode, source) : null;
      node = node.namedChild(1)!;
    } else break;
  }
  const text = nodeText(node, source);
  if (label !== undefined) return withType(text, (name) => scope.member(name, label!));
  return withType(text, (name) => scope.lookup(name));
}

/**
 * Argument count, types and names of a Kotlin call. The grammar parses `f(1) { … }` as
 * an outer call_expression wrapping `f(1)` with the annotated_lambda as its suffix, so
 * that trailing lambda is found on the parent; `f { … }` carries it directly.
 */
function kotlinArguments(call: SyntaxNode, scope: Scope, source: string): Pick<ExtractedCall, "argCount" | "argTypes" | "argNames"> {
  const argTypes: (string | null)[] = [];
  const argNames: (string | null)[] = [];
  let spread = false;
  for (const child of named(call)) {
    if (child.type === "annotated_lambda") {
      argTypes.push(null);
      argNames.push(null);
    }
    if (child.type !== "value_arguments") continue;
    for (const arg of named(child)) {
      if (arg.type !== "value_argument") continue;
      const parts = all(arg);
      const eq = parts.findIndex((c) => c.type === "=");
      if (parts.some((c) => c.type === "spread_expression")) spread = true;
      const expr = named(arg)[named(arg).length - 1];
      argNames.push(eq > 0 ? nodeText(parts[eq - 1], source) : null);
      argTypes.push(expr && eq !== parts.length - 1 ? kotlinArgType(expr, scope, source) : null);
    }
  }
  const parent = call.parent;
  if (
    parent?.type === "call_expression" &&
    parent.namedChild(0)?.id === call.id &&
    parent.namedChildren.length === 2 &&
    parent.namedChild(1)?.type === "annotated_lambda"
  ) {
    argTypes.push(null);
    argNames.push(null);
  }
  return {
    argCount: spread ? null : argTypes.length,
    argTypes,
    argNames: argNames.some((n) => n !== null) ? argNames : null,
  };
}

export function extractKotlinCalls(root: SyntaxNode, source: string, calls: ExtractedCall[]): void {
  const scope = new Scope();

  /** Walk `node`'s children in order, adding each local after walking its declaration. */
  const visitOrdered = (node: SyntaxNode, frame: Frame) => {
    for (const c of all(node)) {
      visit(c);
      if (c.type === "property_declaration") addKotlinProperty(c, frame.names, source);
    }
  };

  const visitIn = (frame: Frame, node: SyntaxNode, ordered = false) => {
    scope.push(frame);
    if (ordered) visitOrdered(node, frame);
    else for (const c of all(node)) visit(c);
    scope.pop();
  };

  const visit = (node: SyntaxNode): void => {
    if (KOTLIN_CLASS_BODIES.has(node.type)) {
      const { frame, ctorParams } = kotlinClassFrame(node, source);
      scope.push(frame);
      for (const c of all(node)) {
        const initializer = c.type === "property_declaration" || c.type === "anonymous_initializer";
        if (initializer && ctorParams.size > 0) visitIn({ names: ctorParams }, c);
        else visit(c);
      }
      scope.pop();
      return;
    }
    if (KOTLIN_PARAMETER_OWNERS.has(node.type)) return visitIn(kotlinParamFrame(node, source), node);
    if (KOTLIN_BLOCKS.has(node.type)) return visitIn({ names: new Map() }, node, true);
    if (node.type === "lambda_literal") return visitIn(kotlinLambdaFrame(node, scope, source), node, true);
    if (node.type === "for_statement") {
      const names = new Map<string, Decl>();
      for (const d of named(node)) if (d.type === "variable_declaration" || d.type === "multi_variable_declaration") addKotlinVariable(d, names, source);
      return visitIn({ names }, node);
    }
    if (node.type === "catch_block") {
      const id = findNamedChild(node, "identifier");
      const names = new Map<string, Decl>();
      if (id) names.set(nodeText(id, source), normalizeTypeName(nodeText(findNamedChild(node, "user_type") ?? id, source)));
      return visitIn({ names }, node);
    }
    if (node.type === "call_expression") recordKotlinCall(node);
    for (const c of all(node)) visit(c);
  };

  const recordKotlinCall = (node: SyntaxNode) => {
    const callee = node.namedChild(0);
    if (!callee) return;
    let receiver: Receiver;
    let methodName: string;
    if (callee.type === "navigation_expression") {
      const parts = named(callee);
      if (parts.length < 2) return;
      receiver = kotlinReceiver(parts[0], scope, source);
      methodName = nodeText(parts[parts.length - 1], source);
    } else if (callee.type === "identifier") {
      receiver = NONE;
      methodName = nodeText(callee, source);
    } else return;
    calls.push({
      ...receiver,
      methodName,
      ...kotlinArguments(node, scope, source),
      implicitReceiverType: receiver.receiverKind === "none" || receiver.receiverKind === "this" ? scope.implicitReceiver() : null,
      line: node.startPosition.row + 1,
      startIndex: node.startIndex,
    });
  };

  // Top-level properties are in scope wherever they are declared in the file.
  const top = new Map<string, Decl>();
  for (const c of named(root)) if (c.type === "property_declaration") addKotlinProperty(c, top, source);
  scope.push({ names: top });
  for (const c of all(root)) visit(c);
}
