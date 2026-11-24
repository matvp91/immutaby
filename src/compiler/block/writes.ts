/** Compiling writes to state: assignments, `++`/`--`, `delete` and mutating method calls. */
import { bindingNames, unwrapExpression, type AstNode } from "../ast.ts";
import { CONTEXT, helperWriteCode, inlineWriteCode, joinArguments, joinKeys, RUNTIME, type InlineWrite, type Part } from "../codegen.ts";
import { MutError } from "../errors.ts";
import { markMaybeState, resolveBinding, touchesState } from "./bindings.ts";
import { emit, markReplaced, sourceOf, type BlockContext } from "./context.ts";
import { statePathOf, type StatePath } from "./state-path.ts";

/** Compiles a statement-level write to a direct path inline. Returns false when it isn't eligible. */
function emitInlineWrite(context: BlockContext, statement: AstNode, path: StatePath, write: InlineWrite): boolean {
  if (!context.inline || !path.isDirect || statement.type !== "ExpressionStatement") return false;
  markReplaced(context, path.replaces);
  context.output.writtenRoots.add(path.root);
  const code = inlineWriteCode(path.root, path.keys, write, (node) => sourceOf(context, node), context.variables);
  emit(context, statement, code);
  return true;
}

/** Compiles a write to a runtime helper call that rebinds the root. */
function emitHelperWrite(context: BlockContext, write: AstNode, parent: AstNode, path: StatePath, helperCall: Part[], resultSlot: "result" | "previousValue" = "result"): void {
  markReplaced(context, path.replaces);
  context.output.writtenRoots.add(path.root);
  context.output.usesContext = true;
  const asExpression = parent.type !== "ExpressionStatement";
  emit(context, write, helperWriteCode(path.root, helperCall, asExpression, resultSlot));
}

export function compileAssignment(context: BlockContext, assignment: AstNode, parent: AstNode, depth: number): void {
  const target = unwrapExpression(assignment.left);

  if (target.type === "Identifier") {
    const binding = resolveBinding(context, target.name);
    if (binding.kind === "alias") throw new MutError(`\`${target.name}\` refers into state and can't be reassigned`, target.start);
    if (binding.kind === "maybeState" || touchesState(context, assignment.right)) markMaybeState(context, target.name, null);
    return;
  }
  if (target.type !== "MemberExpression") {
    // Destructuring assignment: the assigned locals may now point into state.
    if (touchesState(context, assignment.right)) for (const name of bindingNames(target)) markMaybeState(context, name, null);
    return;
  }

  const path = statePathOf(context, target, { depth, forWrite: true });
  if (!path) return;
  const isPlainAssignment = assignment.operator === "=";
  const operator = assignment.operator.slice(0, -1);
  const write: InlineWrite = isPlainAssignment ? { kind: "set", value: assignment.right } : { kind: "compound", operator, value: assignment.right };
  if (emitInlineWrite(context, parent, path, write)) return;

  const keys = joinKeys(path.keys);
  const helperCall = isPlainAssignment
    ? [`writePath(${CONTEXT}, [`, ...keys, "], ", assignment.right]
    : [`writePath(${CONTEXT}, ${CONTEXT}.compoundPath = [`, ...keys, `], ${RUNTIME}.readPath(${path.root}, ${CONTEXT}.compoundPath) ${operator} (`, assignment.right, ")"];
  emitHelperWrite(context, assignment, parent, path, helperCall);
}

export function compileUpdate(context: BlockContext, update: AstNode, parent: AstNode, depth: number): void {
  if (unwrapExpression(update.argument).type !== "MemberExpression") return;
  const path = statePathOf(context, update.argument, { depth, forWrite: true });
  if (!path || emitInlineWrite(context, parent, path, { kind: "update", operator: update.operator })) return;
  const delta = update.operator === "++" ? 1 : -1;
  const helperCall = [`incrementPath(${CONTEXT}, [`, ...joinKeys(path.keys), `], ${delta}`];
  emitHelperWrite(context, update, parent, path, helperCall, update.prefix ? "result" : "previousValue");
}

export function compileDelete(context: BlockContext, unary: AstNode, parent: AstNode, depth: number): void {
  if (unary.operator !== "delete" || unwrapExpression(unary.argument).type !== "MemberExpression") return;
  const path = statePathOf(context, unary.argument, { depth, forWrite: true, verb: "deletes" });
  if (!path || emitInlineWrite(context, parent, path, { kind: "delete" })) return;
  emitHelperWrite(context, unary, parent, path, [`deletePath(${CONTEXT}, [`, ...joinKeys(path.keys), "]"]);
}

/** `path.push(x)`, `path.set(k, v)`, …, or a computed method (`path[m](x)`), which may mutate too. */
export function compileMutatingCall(context: BlockContext, call: AstNode, method: string | null, depth: number, parent: AstNode): void {
  const callee = unwrapExpression(call.callee);
  if (callee.optional || call.optional) {
    if (touchesState(context, callee.object)) throw new MutError("optional mutating calls on state aren't supported yet", call.start);
    return;
  }
  const path = statePathOf(context, callee.object, { depth, forWrite: true, verb: "mutating calls" });
  if (!path) return;
  const methodName = callee.computed ? callee.property : JSON.stringify(method);
  const helperCall = [`callMethodAtPath(${CONTEXT}, [`, ...joinKeys(path.keys), "], ", methodName, ", [", ...joinArguments(call.arguments), "]"];
  emitHelperWrite(context, call, parent, path, helperCall);
}
