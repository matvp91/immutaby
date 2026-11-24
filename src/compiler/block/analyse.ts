/** One pass over a `mut:` block: walks its body and collects the edits that compile it. */
import { isFunction, isTypeOnly, referenceChildNodes, staticMethodName, type AstNode } from "../ast.ts";
import { isMutatingMethod } from "../known-calls.ts";
import { scopeBindings } from "../scope.ts";
import {
  bindFunctionParams,
  compileAliasRead,
  compileDeclarator,
  compileForOf,
  compileShorthandAliasRead,
  markCallbackParamsAsMaybeState,
  registerIterationCallback,
} from "./aliases.ts";
import { createBlockContext, type BlockContext, type BlockInput, type BlockOutput } from "./context.ts";
import { compileOpaqueCall } from "./opaque-calls.ts";
import { compileAssignment, compileDelete, compileMutatingCall, compileUpdate } from "./writes.ts";

function compileCall(context: BlockContext, call: AstNode, parent: AstNode, depth: number): void {
  const method = staticMethodName(call);
  const mayMutateReceiver = method === null || (method !== undefined && isMutatingMethod(method));
  if (mayMutateReceiver) compileMutatingCall(context, call, method, depth, parent);
  else if (!registerIterationCallback(context, call, method, depth)) compileOpaqueCall(context, call, depth);
  markCallbackParamsAsMaybeState(context, call);
}

function compileNode(context: BlockContext, node: AstNode, parent: AstNode, depth: number): void {
  switch (node.type) {
    case "Identifier":
      return compileAliasRead(context, node);
    case "Property":
      return compileShorthandAliasRead(context, node);
    case "BreakStatement":
      if (node.label?.name === "mut") context.output.breaksOut = true;
      return;
    case "AssignmentExpression":
      return compileAssignment(context, node, parent, depth);
    case "UpdateExpression":
      return compileUpdate(context, node, parent, depth);
    case "UnaryExpression":
      return compileDelete(context, node, parent, depth);
    case "CallExpression":
      return compileCall(context, node, parent, depth);
    case "NewExpression":
      return compileOpaqueCall(context, node, depth);
    case "VariableDeclarator":
      return compileDeclarator(context, node, depth);
    case "ForOfStatement":
      return compileForOf(context, node, depth);
  }
}

/**
 * `depth` counts the functions (other than inline iteration callbacks, which
 * run synchronously) between the block and `node`: writes there would happen
 * after the block ends.
 */
function visit(context: BlockContext, node: AstNode, parent: AstNode, depth: number): void {
  if (isTypeOnly(node)) return;
  const bindings = scopeBindings(node);
  if (bindings) {
    context.scopes.push({ bindings, aliases: new Map(), maybeState: new Map() });
    if (isFunction(node)) bindFunctionParams(context, node);
  }
  const innerDepth = isFunction(node) && !context.iterationCallbacks.has(node) ? depth + 1 : depth;
  if (!context.replaced.has(node)) compileNode(context, node, parent, innerDepth);
  for (const child of referenceChildNodes(node)) visit(context, child, node, innerDepth);
  if (bindings) context.scopes.pop();
}

/** Analyses the body of the `mut:` statement `label`. Throws `PromoteToAlias` when a local must become an alias. */
export function analyseBlock(label: AstNode, input: BlockInput): BlockOutput {
  const context = createBlockContext(input);
  visit(context, label.body, label, 0);
  return context.output;
}
