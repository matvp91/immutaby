/** Pure helpers over the ESTree (and TS-ESTree) AST produced by Rolldown's parser, including scopes. */

/**
 * An AST node, typed loosely: the AST is large and dynamically shaped, and the
 * compiler only reads the fields it checks.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the comment above.
export type Node = any;

export type BindingKind = "var" | "let" | "const" | "param" | "catch" | "function" | "class" | "import";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
/** TypeScript wrappers around a runtime expression, e.g. `x as T` or `x!`. */
const TS_EXPRESSION_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
/** Node fields that don't hold code. */
const NON_CODE_FIELDS = new Set([
  ...["type", "start", "end", "range", "loc"],
  ...[
    "typeAnnotation",
    "returnType",
    "typeParameters",
    "typeArguments",
    "superTypeArguments",
    "implements",
    "decorators",
  ],
]);

export const isFunction = (node: Node): boolean => FUNCTION_TYPES.has(node?.type);

/** Type-only TypeScript syntax (types, interfaces, …), which has no runtime code to compile. */
export const isTypeOnly = (node: Node): boolean =>
  node.type.startsWith("TS") && !TS_EXPRESSION_WRAPPERS.has(node.type) && node.type !== "TSInstantiationExpression";

/** The expression inside parentheses and TypeScript wrappers. */
export const unwrap = (node: Node): Node =>
  node.type === "ParenthesizedExpression" || TS_EXPRESSION_WRAPPERS.has(node.type) ? unwrap(node.expression) : node;

/** The child nodes that hold code, in source order. */
export function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const field in node) {
    if (NON_CODE_FIELDS.has(field)) {
      continue;
    }
    const value = node[field];
    if (Array.isArray(value)) {
      found.push(...value.filter((child) => typeof child?.type === "string"));
    } else if (typeof value?.type === "string") {
      found.push(value);
    }
  }
  return found;
}

/** Child nodes that hold code, skipping identifiers that aren't variable references (property names, labels). */
export function references(node: Node): Node[] {
  switch (node.type) {
    case "MemberExpression":
      return node.computed ? [node.object, node.property] : [node.object];
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      return node.computed ? children(node) : children(node).filter((child) => child !== node.key);
    case "LabeledStatement":
      return [node.body];
    case "BreakStatement":
    case "ContinueStatement":
      return [];
    default:
      return children(node);
  }
}

/** `a.b.c` for an expression made of plain identifiers and property names, else undefined. */
export function dottedName(node: Node): string | undefined {
  const expression = unwrap(node);
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type !== "MemberExpression" || expression.computed) {
    return undefined;
  }
  const object = dottedName(expression.object);
  return object && `${object}.${expression.property.name}`;
}

/**
 * The method name of a method call: a string when statically known, `null`
 * when computed (`a[m]()`), and undefined when the call isn't a method call.
 */
export function methodName(call: Node): string | null | undefined {
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  if (!callee.computed) {
    return callee.property.name;
  }
  const key = callee.property;
  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
}

/** The identifier a member chain starts from (`u` in `u.a.b`), if any. */
export function chainBase(node: Node): Node | undefined {
  let expression = unwrap(node);
  while (expression.type === "MemberExpression") {
    expression = unwrap(expression.object);
  }
  return expression.type === "Identifier" ? expression : undefined;
}

/** The names a binding pattern declares (`{ a, b: [c] }` → a, c). */
export function bindingNames(pattern: Node): string[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property: Node) =>
        bindingNames(property.type === "RestElement" ? property.argument : property.value),
      );
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

// ---------------------------------------------------------------------------- scopes

/** Whether a variable of this kind can be assigned a new value (so it can hold an updated state root). */
export const isReassignable = (kind: BindingKind): boolean =>
  kind === "let" || kind === "var" || kind === "param" || kind === "catch";

const withKind =
  (kind: BindingKind) =>
  (name: string): [string, BindingKind] => [name, kind];

/** Names declared directly by a statement (not hoisted `var`s). */
function statementBindings(statement: Node): [string, BindingKind][] {
  switch (statement?.type) {
    case "VariableDeclaration": {
      if (statement.kind === "var") {
        return [];
      }
      const kind = statement.kind === "let" ? "let" : "const";
      return statement.declarations.flatMap((declarator: Node) => bindingNames(declarator.id).map(withKind(kind)));
    }
    case "FunctionDeclaration":
      return statement.id ? [[statement.id.name, "function"]] : [];
    case "ClassDeclaration":
      return statement.id ? [[statement.id.name, "class"]] : [];
    case "TSEnumDeclaration":
      return [[statement.id.name, "const"]];
    case "ImportDeclaration":
      return statement.specifiers.map((specifier: Node) => withKind("import")(specifier.local.name));
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return statementBindings(statement.declaration);
    default:
      return [];
  }
}

/** `var` declarations anywhere below `node`, except inside nested functions. */
function hoistedVars(node: Node): [string, BindingKind][] {
  const own =
    node.type === "VariableDeclaration" && node.kind === "var"
      ? node.declarations.flatMap((declarator: Node) => bindingNames(declarator.id).map(withKind("var")))
      : [];
  return [
    ...own,
    ...children(node)
      .filter((child) => !isFunction(child))
      .flatMap(hoistedVars),
  ];
}

function declaredBy(node: Node): [string, BindingKind][] | null {
  switch (node.type) {
    case "Program":
      return [...node.body.flatMap(statementBindings), ...hoistedVars(node)];
    case "BlockStatement":
    case "StaticBlock":
      return node.body.flatMap(statementBindings);
    case "SwitchStatement":
      return node.cases.flatMap((switchCase: Node) => switchCase.consequent.flatMap(statementBindings));
    case "ForStatement":
      return statementBindings(node.init);
    case "ForInStatement":
    case "ForOfStatement":
      return statementBindings(node.left);
    case "CatchClause":
      return bindingNames(node.param).map(withKind("catch"));
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return [
        ...(node.type === "FunctionExpression" && node.id ? [withKind("const")(node.id.name)] : []),
        ...node.params.flatMap((param: Node) => bindingNames(param).map(withKind("param"))),
        ...(node.body.type === "BlockStatement" ? hoistedVars(node.body) : []),
      ];
    default:
      return null;
  }
}

const scopeCache = new WeakMap<Node, ReadonlyMap<string, BindingKind> | null>();

/** The names `node` declares, or null if it doesn't introduce a scope. */
export function scopeBindings(node: Node): ReadonlyMap<string, BindingKind> | null {
  const cached = scopeCache.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const declared = declaredBy(node);
  const bindings = declared && new Map(declared);
  scopeCache.set(node, bindings);
  return bindings;
}
