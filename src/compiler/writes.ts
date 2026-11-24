/**
 * Writes to state: assignments, `++`/`--`, `delete` and mutating method calls,
 * plus calls the compiler can't see into, which get a deep copy of the state
 * they receive (sharing is restored when the block ends).
 */
import * as Ast from "./ast.ts";
import type * as Block from "./block.ts";
import * as Calls from "./calls.ts";
import type { InlineWrite, Part } from "./codegen.ts";
import * as Codegen from "./codegen.ts";
import { CONTEXT, RUNTIME } from "./codegen.ts";
import { MutError, PromoteToAlias } from "./errors.ts";
import * as State from "./state.ts";

/** Compiles a statement-level write to a direct path inline. Returns false when it isn't eligible. */
function emitInline(context: Block.Context, statement: Ast.Node, path: State.Path, write: InlineWrite): boolean {
  if (!context.inline || !path.isDirect || statement.type !== "ExpressionStatement") {
    return false;
  }
  context.markReplaced(path.replaces);
  context.output.writtenRoots.add(path.root);
  context.emit(statement, Codegen.inlineWrite(path.root, path.keys, write, context.sourceOf, context.variables));
  return true;
}

/** Compiles a write to a runtime helper call that rebinds the root. */
function emitHelper(
  context: Block.Context,
  write: Ast.Node,
  parent: Ast.Node,
  path: State.Path,
  helperCall: Part[],
  resultSlot: "result" | "previousValue" = "result",
): void {
  context.markReplaced(path.replaces);
  context.output.writtenRoots.add(path.root);
  context.output.usesContext = true;
  const asExpression = parent.type !== "ExpressionStatement";
  context.emit(write, Codegen.helperWrite(path.root, helperCall, asExpression, resultSlot));
}

export function assignment(context: Block.Context, node: Ast.Node, parent: Ast.Node, depth: number): void {
  const target = Ast.unwrap(node.left);

  if (target.type === "Identifier") {
    const binding = State.resolve(context, target.name);
    if (binding.kind === "alias") {
      throw new MutError(`\`${target.name}\` refers into state and can't be reassigned`, target.start);
    }
    if (binding.kind === "maybeState" || State.touches(context, node.right)) {
      State.markMaybeState(context, target.name, null);
    }
    return;
  }
  if (target.type !== "MemberExpression") {
    // Destructuring assignment: the assigned locals may now point into state.
    if (State.touches(context, node.right)) {
      for (const name of Ast.bindingNames(target)) {
        State.markMaybeState(context, name, null);
      }
    }
    return;
  }

  const path = State.pathOf(context, target, { depth, forWrite: true });
  if (!path) {
    return;
  }
  const isPlainAssignment = node.operator === "=";
  const operator = node.operator.slice(0, -1);
  const write: InlineWrite = isPlainAssignment
    ? { kind: "set", value: node.right }
    : { kind: "compound", operator, value: node.right };
  if (emitInline(context, parent, path, write)) {
    return;
  }

  const keys = Codegen.joinKeys(path.keys);
  const helperCall = isPlainAssignment
    ? [`writePath(${CONTEXT}, [`, ...keys, "], ", node.right]
    : [
        `writePath(${CONTEXT}, ${CONTEXT}.compoundPath = [`,
        ...keys,
        `], ${RUNTIME}.readPath(${path.root}, ${CONTEXT}.compoundPath) ${operator} (`,
        node.right,
        ")",
      ];
  emitHelper(context, node, parent, path, helperCall);
}

export function update(context: Block.Context, node: Ast.Node, parent: Ast.Node, depth: number): void {
  if (Ast.unwrap(node.argument).type !== "MemberExpression") {
    return;
  }
  const path = State.pathOf(context, node.argument, { depth, forWrite: true });
  if (!path || emitInline(context, parent, path, { kind: "update", operator: node.operator })) {
    return;
  }
  const delta = node.operator === "++" ? 1 : -1;
  const helperCall = [`incrementPath(${CONTEXT}, [`, ...Codegen.joinKeys(path.keys), `], ${delta}`];
  emitHelper(context, node, parent, path, helperCall, node.prefix ? "result" : "previousValue");
}

/** `delete path.key` (named `remove` since `delete` is reserved). */
export function remove(context: Block.Context, node: Ast.Node, parent: Ast.Node, depth: number): void {
  if (node.operator !== "delete" || Ast.unwrap(node.argument).type !== "MemberExpression") {
    return;
  }
  const path = State.pathOf(context, node.argument, { depth, forWrite: true, verb: "deletes" });
  if (!path || emitInline(context, parent, path, { kind: "delete" })) {
    return;
  }
  emitHelper(context, node, parent, path, [`deletePath(${CONTEXT}, [`, ...Codegen.joinKeys(path.keys), "]"]);
}

/** `path.push(x)`, `path.set(k, v)`, …, or a computed method (`path[m](x)`), which may mutate too. */
export function mutatingCall(
  context: Block.Context,
  call: Ast.Node,
  method: string | null,
  depth: number,
  parent: Ast.Node,
): void {
  const callee = Ast.unwrap(call.callee);
  if (callee.optional || call.optional) {
    if (State.touches(context, callee.object)) {
      throw new MutError("optional mutating calls on state aren't supported yet", call.start);
    }
    return;
  }
  const path = State.pathOf(context, callee.object, { depth, forWrite: true, verb: "mutating calls" });
  if (!path) {
    return;
  }
  const methodName = callee.computed ? callee.property : JSON.stringify(method);
  const helperCall = [
    `callMethodAtPath(${CONTEXT}, [`,
    ...Codegen.joinKeys(path.keys),
    "], ",
    methodName,
    ", [",
    ...Codegen.joinArguments(call.arguments),
    "]",
  ];
  emitHelper(context, call, parent, path, helperCall);
}

// ---------------------------------------------------------------------------- opaque calls

/** Calls known not to change their arguments: listed in `readonlyCalls`, or read-only globals. */
function isReadOnlyCall(context: Block.Context, callee: Ast.Node): boolean {
  const name = Ast.dottedName(callee);
  if (!name) {
    return false;
  }
  if (context.options.readonlyCalls.includes(name)) {
    return true;
  }
  return State.resolve(context, name.split(".")[0]).kind === "global" && Calls.isReadOnlyGlobal(name);
}

/** Whether a method call may change its receiver. */
function mayChangeReceiver(call: Ast.Node, method: string | null): boolean {
  if (!method || !Calls.isReadOnly(method)) {
    return true;
  }
  // An iteration method with a function reference (not an inline callback) may change the elements.
  return Calls.isIteration(method) && !Ast.isFunction(call.arguments[0]);
}

/** Replaces state passed as `argument` to `call` with a deep copy. */
function lendState(context: Block.Context, call: Ast.Node, argument: Ast.Node, depth: number): void {
  const value = argument.type === "SpreadElement" ? argument.argument : argument;
  const callee = context.sourceOf(call.callee);
  const expression = Ast.unwrap(value);
  const binding = expression.type === "Identifier" ? State.resolve(context, expression.name) : null;
  if (binding?.kind === "maybeState") {
    if (binding.promotable) {
      throw new PromoteToAlias(binding.promotable);
    }
    const message = `mut: \`${expression.name}\` may point into state; changes \`${callee}\` makes through it aren't tracked`;
    context.output.warnings.push({ message, pos: expression.start });
    return;
  }

  const path = State.pathOf(context, value, { depth, forWrite: false });
  if (!path || depth > 0) {
    return;
  }
  const root = State.resolve(context, path.root);
  if (root.kind === "root" && !Ast.isReassignable(root.declaredAs)) {
    return; // not state this block can rebind
  }

  const { opaqueCalls } = context.options;
  if (opaqueCalls === "error") {
    throw new MutError(`\`${callee}\` may change state the compiler can't see into`, call.start);
  }
  if (opaqueCalls === "warn") {
    const message = `mut: \`${callee}\` may change state, so it gets a deep copy (reconciled at the end of the block)`;
    context.output.warnings.push({ message, pos: call.start });
  }
  context.markReplaced(path.replaces);
  context.output.lentRoots.add(path.root);
  context.output.writtenRoots.add(path.root);
  context.output.usesContext = true;
  context.emit(value, [
    `(${path.root} = ${RUNTIME}.lendDeepCopy(${CONTEXT}, [`,
    ...Codegen.joinKeys(path.keys),
    `], ${path.root}), ${CONTEXT}.result)`,
  ]);
}

/** Lends state to the arguments (and the receiver, for unknown methods) of a call the compiler can't see into. */
export function opaqueCall(context: Block.Context, call: Ast.Node, depth: number): void {
  if (isReadOnlyCall(context, call.callee)) {
    return;
  }
  const method = call.type === "CallExpression" ? Ast.methodName(call) : undefined;
  if (method !== undefined && mayChangeReceiver(call, method)) {
    lendState(context, call, Ast.unwrap(call.callee).object, depth);
  }
  for (const argument of call.arguments) {
    if (!Ast.isFunction(argument)) {
      lendState(context, call, argument, depth);
    }
  }
}
