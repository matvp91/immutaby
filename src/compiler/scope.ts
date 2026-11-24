/** Which names each scope declares; pure, and cached per AST node. */
import { bindingNames, childNodes, isFunction, type AstNode } from "./ast.ts";

export type BindingKind = "var" | "let" | "const" | "param" | "catch" | "function" | "class" | "import";

/** Whether a variable of this kind can be assigned a new value (so it can hold an updated state root). */
export const isReassignable = (kind: BindingKind): boolean => kind === "let" || kind === "var" || kind === "param" || kind === "catch";

/** Names declared directly by a statement (not hoisted `var`s). */
function statementBindings(statement: AstNode): [string, BindingKind][] {
  switch (statement?.type) {
    case "VariableDeclaration": {
      if (statement.kind === "var") return [];
      const kind: BindingKind = statement.kind === "let" ? "let" : "const";
      return statement.declarations.flatMap((declarator: AstNode) => bindingNames(declarator.id).map((name): [string, BindingKind] => [name, kind]));
    }
    case "FunctionDeclaration":
      return statement.id ? [[statement.id.name, "function"]] : [];
    case "ClassDeclaration":
      return statement.id ? [[statement.id.name, "class"]] : [];
    case "TSEnumDeclaration":
      return [[statement.id.name, "const"]];
    case "ImportDeclaration":
      return statement.specifiers.map((specifier: AstNode): [string, BindingKind] => [specifier.local.name, "import"]);
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return statementBindings(statement.declaration);
    default:
      return [];
  }
}

/** `var` declarations anywhere below `node`, except inside nested functions. */
function hoistedVars(node: AstNode): [string, BindingKind][] {
  const own: [string, BindingKind][] =
    node.type === "VariableDeclaration" && node.kind === "var"
      ? node.declarations.flatMap((declarator: AstNode) => bindingNames(declarator.id).map((name): [string, BindingKind] => [name, "var"]))
      : [];
  return [...own, ...childNodes(node).filter((child) => !isFunction(child)).flatMap(hoistedVars)];
}

function bindingsOf(node: AstNode): [string, BindingKind][] | null {
  switch (node.type) {
    case "Program":
      return [...node.body.flatMap(statementBindings), ...hoistedVars(node)];
    case "BlockStatement":
    case "StaticBlock":
      return node.body.flatMap(statementBindings);
    case "SwitchStatement":
      return node.cases.flatMap((switchCase: AstNode) => switchCase.consequent.flatMap(statementBindings));
    case "ForStatement":
      return statementBindings(node.init);
    case "ForInStatement":
    case "ForOfStatement":
      return statementBindings(node.left);
    case "CatchClause":
      return bindingNames(node.param).map((name) => [name, "catch"]);
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return [
        ...(node.type === "FunctionExpression" && node.id ? [[node.id.name, "const"] as [string, BindingKind]] : []),
        ...node.params.flatMap((param: AstNode) => bindingNames(param).map((name): [string, BindingKind] => [name, "param"])),
        ...(node.body.type === "BlockStatement" ? hoistedVars(node.body) : []),
      ];
    default:
      return null;
  }
}

const cache = new WeakMap<AstNode, ReadonlyMap<string, BindingKind> | null>();

/** The names `node` declares, or null if it doesn't introduce a scope. */
export function scopeBindings(node: AstNode): ReadonlyMap<string, BindingKind> | null {
  if (!cache.has(node)) {
    const bindings = bindingsOf(node);
    cache.set(node, bindings && new Map(bindings));
  }
  return cache.get(node)!;
}
