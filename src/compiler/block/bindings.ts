/** Resolving names inside a block, and tracking locals that point into state. */
import { isFunction, isTypeOnly, memberChainBase, referenceChildNodes, type AstNode } from "../ast.ts";
import { isPlainKey, type Alias } from "../codegen.ts";
import { scopeBindings, type BindingKind } from "../scope.ts";
import { markReplaced, type BlockContext, type Scope } from "./context.ts";
import type { StatePath } from "./state-path.ts";

export type Binding =
  /** Declared outside the block: writes through it are state updates. */
  | { kind: "root"; declaredAs: BindingKind }
  /** A local compiled to a state location. */
  | { kind: "alias"; alias: Alias }
  /** A local that may point into state; `promotable` is its binding node if it can become an alias. */
  | { kind: "maybeState"; promotable: AstNode | null }
  /** A local that doesn't hold state. */
  | { kind: "local" }
  /** Not declared in this module. */
  | { kind: "global" };

export function resolveBinding(context: BlockContext, name: string): Binding {
  for (let i = context.scopes.length - 1; i >= 0; i--) {
    const scope = context.scopes[i];
    if (!scope.bindings.has(name)) continue;
    if (scope.aliases.has(name)) return { kind: "alias", alias: scope.aliases.get(name)! };
    if (scope.maybeState.has(name)) return { kind: "maybeState", promotable: scope.maybeState.get(name) };
    return { kind: "local" };
  }
  for (let i = context.enclosing.length - 1; i >= 0; i--) {
    const declaredAs = scopeBindings(context.enclosing[i])?.get(name);
    if (declaredAs) return { kind: "root", declaredAs };
  }
  return { kind: "global" };
}

const scopeDeclaring = (context: BlockContext, name: string): Scope | undefined => context.scopes.findLast((scope) => scope.bindings.has(name));

export function markMaybeState(context: BlockContext, name: string, promotable: AstNode | null): void {
  scopeDeclaring(context, name)?.maybeState.set(name, promotable);
}

/** Compiles the local bound by `binding` as `alias`; its declaration and the `replaced` nodes get no edits of their own. */
export function declareAlias(context: BlockContext, binding: AstNode, alias: Alias, replaced: readonly AstNode[] = []): void {
  scopeDeclaring(context, binding.name)?.aliases.set(binding.name, alias);
  markReplaced(context, [binding, ...replaced]);
}

/**
 * The alias for a local bound to `path`. Plain keys are kept; the others are
 * read from `holder`, which must then hold the resolved path at runtime.
 */
export function aliasForPath(path: StatePath, holder: string): { alias: Alias; needsHolder: boolean } {
  const keys = path.keys.map((key, i) => (isPlainKey(key) ? key[0] : `${holder}[${i}]`));
  return { alias: { root: path.root, keys }, needsHolder: !path.keys.every(isPlainKey) };
}

/**
 * For a member path on a local that may become an alias (`u.address`), that
 * local's binding: writing through something derived from it must promote it first.
 */
export function promotableBase(context: BlockContext, expression: AstNode): AstNode | null {
  const base = memberChainBase(expression);
  const binding = base && resolveBinding(context, base.name);
  return binding?.kind === "maybeState" ? binding.promotable : null;
}

/** Whether `node` (outside nested functions) reads anything that may hold state. */
export function touchesState(context: BlockContext, node: AstNode): boolean {
  if (!node || isFunction(node) || isTypeOnly(node)) return false;
  if (node.type === "Identifier") {
    const { kind } = resolveBinding(context, node.name);
    return kind !== "local" && kind !== "global";
  }
  // Calling a plain function doesn't read state by itself; its arguments might.
  if ((node.type === "CallExpression" || node.type === "NewExpression") && node.callee.type === "Identifier") {
    return node.arguments.some((argument: AstNode) => touchesState(context, argument));
  }
  return referenceChildNodes(node).some((child) => touchesState(context, child));
}
