/** Pure helpers over the ESTree (and TS-ESTree) AST produced by Rolldown's parser. */

/** An AST node; typed loosely, since the compiler only reads the fields it checks. */
// The AST is large and dynamically shaped; precise node types would add noise without catching bugs here.
export type AstNode = any;

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
/** TypeScript wrappers around a runtime expression, e.g. `x as T` or `x!`. */
const TS_EXPRESSION_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"]);
/** Node fields that don't hold code. */
const NON_CODE_FIELDS = new Set([
  ...["type", "start", "end", "range", "loc"],
  ...["typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeArguments", "implements", "decorators"],
]);

export const isFunction = (node: AstNode): boolean => FUNCTION_TYPES.has(node?.type);

/** Type-only TypeScript syntax (types, interfaces, …), which has no runtime code to compile. */
export const isTypeOnly = (node: AstNode): boolean =>
  node.type.startsWith("TS") && !TS_EXPRESSION_WRAPPERS.has(node.type) && node.type !== "TSInstantiationExpression";

/** The expression inside parentheses and TypeScript wrappers. */
export const unwrapExpression = (node: AstNode): AstNode =>
  node.type === "ParenthesizedExpression" || TS_EXPRESSION_WRAPPERS.has(node.type) ? unwrapExpression(node.expression) : node;

/** The child nodes that hold code, in source order. */
export function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const field in node) {
    if (NON_CODE_FIELDS.has(field)) continue;
    const value = node[field];
    if (Array.isArray(value)) children.push(...value.filter((child) => typeof child?.type === "string"));
    else if (typeof value?.type === "string") children.push(value);
  }
  return children;
}

/** Child nodes that hold code, skipping identifiers that aren't variable references (property names, labels). */
export function referenceChildNodes(node: AstNode): AstNode[] {
  switch (node.type) {
    case "MemberExpression":
      return node.computed ? [node.object, node.property] : [node.object];
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return node.computed ? childNodes(node) : childNodes(node).filter((child) => child !== node.key);
    case "LabeledStatement":
      return [node.body];
    case "BreakStatement":
    case "ContinueStatement":
      return [];
    default:
      return childNodes(node);
  }
}

/** `a.b.c` for an expression made of plain identifiers and property names, else undefined. */
export function dottedName(node: AstNode): string | undefined {
  const expression = unwrapExpression(node);
  if (expression.type === "Identifier") return expression.name;
  if (expression.type !== "MemberExpression" || expression.computed) return undefined;
  const object = dottedName(expression.object);
  return object && `${object}.${expression.property.name}`;
}

/**
 * The method name of a method call: a string when statically known, `null`
 * when computed (`a[m]()`), and undefined when the call isn't a method call.
 */
export function staticMethodName(call: AstNode): string | null | undefined {
  const callee = unwrapExpression(call.callee);
  if (callee.type !== "MemberExpression") return undefined;
  if (!callee.computed) return callee.property.name;
  const key = callee.property;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
}

/** The identifier a member chain starts from (`u` in `u.a.b`), if any. */
export function memberChainBase(node: AstNode): AstNode | undefined {
  let expression = unwrapExpression(node);
  while (expression.type === "MemberExpression") expression = unwrapExpression(expression.object);
  return expression.type === "Identifier" ? expression : undefined;
}

/** The names a binding pattern declares (`{ a, b: [c] }` → a, c). */
export function bindingNames(pattern: AstNode): string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: AstNode) => bindingNames(property.type === "RestElement" ? property.argument : property.value));
    case "ArrayPattern":
      return pattern.elements.flatMap(bindingNames);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
    case "TSParameterProperty":
      return bindingNames(pattern.parameter);
    default:
      return [];
  }
}
