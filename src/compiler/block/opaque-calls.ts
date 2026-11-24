/**
 * Calls the compiler can't see into (e.g. `rename(s.user)`): state passed to
 * them is lent as a deep copy, and sharing is restored when the block ends.
 */
import { dottedName, isFunction, staticMethodName, unwrapExpression, type AstNode } from "../ast.ts";
import { CONTEXT, joinKeys, RUNTIME } from "../codegen.ts";
import { MutError, PromoteToAlias } from "../errors.ts";
import { isIterationMethod, isReadOnlyGlobalCall, isReadOnlyMethod } from "../known-calls.ts";
import { isReassignable } from "../scope.ts";
import { resolveBinding } from "./bindings.ts";
import { emit, markReplaced, sourceOf, type BlockContext } from "./context.ts";
import { statePathOf } from "./state-path.ts";

/** Calls known not to change their arguments: listed in `readonlyCalls`, or read-only globals. */
function isReadOnlyCall(context: BlockContext, callee: AstNode): boolean {
  const name = dottedName(callee);
  if (!name) return false;
  if (context.options.readonlyCalls.includes(name)) return true;
  return resolveBinding(context, name.split(".")[0]).kind === "global" && isReadOnlyGlobalCall(name);
}

/** Whether a method call may change its receiver. */
function mayChangeReceiver(call: AstNode, method: string | null): boolean {
  if (!method || !isReadOnlyMethod(method)) return true;
  // An iteration method with a function reference (not an inline callback) may change the elements.
  return isIterationMethod(method) && !isFunction(call.arguments[0]);
}

/** Replaces state passed as `argument` to `call` with a deep copy. */
function lendState(context: BlockContext, call: AstNode, argument: AstNode, depth: number): void {
  const value = argument.type === "SpreadElement" ? argument.argument : argument;
  const callee = sourceOf(context, call.callee);
  const expression = unwrapExpression(value);
  const binding = expression.type === "Identifier" ? resolveBinding(context, expression.name) : null;
  if (binding?.kind === "maybeState") {
    if (binding.promotable) throw new PromoteToAlias(binding.promotable);
    const message = `mut: \`${expression.name}\` may point into state; changes \`${callee}\` makes through it aren't tracked`;
    context.output.warnings.push({ message, pos: expression.start });
    return;
  }

  const path = statePathOf(context, value, { depth, forWrite: false });
  if (!path || depth > 0) return;
  const root = resolveBinding(context, path.root);
  if (root.kind === "root" && !isReassignable(root.declaredAs)) return; // not state this block can rebind

  const { opaqueCalls } = context.options;
  if (opaqueCalls === "error") throw new MutError(`\`${callee}\` may change state the compiler can't see into`, call.start);
  if (opaqueCalls === "warn") {
    const message = `mut: \`${callee}\` may change state, so it gets a deep copy (reconciled at the end of the block)`;
    context.output.warnings.push({ message, pos: call.start });
  }
  markReplaced(context, path.replaces);
  context.output.lentRoots.add(path.root);
  context.output.writtenRoots.add(path.root);
  context.output.usesContext = true;
  emit(context, value, [`(${path.root} = ${RUNTIME}.lendDeepCopy(${CONTEXT}, [`, ...joinKeys(path.keys), `], ${path.root}), ${CONTEXT}.result)`]);
}

/** Lends state to the arguments (and the receiver, for unknown methods) of a call the compiler can't see into. */
export function compileOpaqueCall(context: BlockContext, call: AstNode, depth: number): void {
  if (isReadOnlyCall(context, call.callee)) return;
  const method = call.type === "CallExpression" ? staticMethodName(call) : undefined;
  if (method !== undefined && mayChangeReceiver(call, method)) lendState(context, call, unwrapExpression(call.callee).object, depth);
  for (const argument of call.arguments) if (!isFunction(argument)) lendState(context, call, argument, depth);
}
