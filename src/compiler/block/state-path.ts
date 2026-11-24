/** Which state location an expression denotes. */
import { staticMethodName, unwrapExpression, type AstNode } from "../ast.ts";
import { joinArguments, RUNTIME, type PathKey } from "../codegen.ts";
import { MutError, PromoteToAlias } from "../errors.ts";
import { findIndexMethodFor } from "../known-calls.ts";
import { isReassignable } from "../scope.ts";
import { resolveBinding, touchesState } from "./bindings.ts";
import type { BlockContext } from "./context.ts";

/** A state location: a root variable plus the keys leading to it. */
export interface StatePath {
  root: string;
  keys: PathKey[];
  /** Source nodes the path's generated code replaces (they must not get edits of their own). */
  replaces: AstNode[];
  /** Whether a key is resolved at runtime (`find`). */
  hasFindKey: boolean;
  /** Whether it is a root plus member keys, which inline writes can handle. */
  isDirect: boolean;
}

export interface StatePathQuery {
  /** Nesting depth of functions (other than inline iteration callbacks) inside the block. */
  depth: number;
  /** Whether the location is about to be written. */
  forWrite: boolean;
  /** What is being done, for error messages ("writes", "deletes", …). */
  verb?: string;
}

/** Throws unless `root` can be rebound to an updated value from here. */
export function assertWritableRoot(context: BlockContext, root: string, at: AstNode, depth: number, verb: string): void {
  const binding = resolveBinding(context, root);
  if (binding.kind !== "root") return;
  if (!isReassignable(binding.declaredAs)) {
    throw new MutError(`\`${root}\` can't be rebound (declared as ${binding.declaredAs}); use \`let\` so it can hold the new value`, at.start);
  }
  if (depth > 0) throw new MutError(`${verb} to \`${root}\` inside a nested function aren't supported yet`, at.start);
}

/**
 * The state location `expression` denotes, or null if it isn't state. For a
 * write, anything that may be state but can't be tracked is an error, and a
 * local that may point into state is promoted to an alias.
 */
export function statePathOf(context: BlockContext, expression: AstNode, query: StatePathQuery): StatePath | null {
  const { depth, forWrite, verb = "writes" } = query;
  const keys: PathKey[] = [];
  let node = unwrapExpression(expression);

  for (;;) {
    if (node.type === "MemberExpression" && node.property.type !== "PrivateIdentifier") {
      keys.unshift([node.computed ? node.property : JSON.stringify(node.property.name)]);
      node = unwrapExpression(node.object);
      continue;
    }
    const findIndexMethod = node.type === "CallExpression" ? findIndexMethodFor(staticMethodName(node) ?? "") : undefined;
    if (findIndexMethod && !node.optional && !unwrapExpression(node.callee).optional && node.arguments.length) {
      const list = statePathOf(context, unwrapExpression(node.callee).object, query);
      if (!list) return null;
      const findKey = [`${RUNTIME}.findIndexKey(${JSON.stringify(findIndexMethod)}, `, ...joinArguments(node.arguments), ")"];
      return { ...list, keys: [...list.keys, findKey, ...keys], replaces: [...list.replaces, node], hasFindKey: true, isDirect: false };
    }
    break;
  }

  if (node.type === "Identifier") {
    const binding = resolveBinding(context, node.name);
    if (binding.kind === "local") return null;
    if (binding.kind === "alias" || binding.kind === "root") {
      const root = binding.kind === "alias" ? binding.alias.root : node.name;
      if (forWrite) assertWritableRoot(context, root, node, depth, verb);
      const fullKeys = binding.kind === "alias" ? [...binding.alias.keys.map((key) => [key]), ...keys] : keys;
      return { root, keys: fullKeys, replaces: [node], hasFindKey: false, isDirect: true };
    }
    if (!forWrite) return null;
    if (binding.kind === "maybeState") {
      if (binding.promotable) throw new PromoteToAlias(binding.promotable);
      throw new MutError(`\`${node.name}\` may point into state but isn't a plain path (like \`s.a.b\`), so ${verb} through it can't be tracked`, node.start);
    }
    throw new MutError(`\`${node.name}\` isn't declared in this module`, node.start);
  }

  if (!forWrite) return null;
  if (node.type === "ThisExpression") throw new MutError(`${verb} through \`this\` aren't supported; copy it into a \`let\` first`, node.start);
  if (touchesState(context, node)) throw new MutError(`can't track ${verb} through this expression yet`, node.start);
  return null;
}
