import * as Ast from "./ast.ts";
import * as Codegen from "./codegen.ts";
import type { Context } from "./compile.ts";
import { MutError, PromoteToAlias } from "./errors.ts";
import type { StatePath } from "./resolve.ts";
import { bindingOf, pathOf, touchesState } from "./resolve.ts";

// Returns false when the write can't be inlined (not a statement, not a direct
// path, or inlining is off).
function emitInline(
  context: Context,
  statement: Ast.Node,
  path: StatePath,
  write: Codegen.InlineWrite,
): boolean {
  if (
    !context.inline ||
    !path.isDirect ||
    statement.type !== "ExpressionStatement"
  ) {
    return false;
  }
  context.markReplaced(path.replaces);
  context.recordWrite(path.root, false);
  context.emit(
    statement,
    Codegen.inlineWrite(
      path.root,
      path.keys,
      write,
      context.sourceOf,
      context.names,
    ),
  );
  return true;
}

function emitHelper(
  context: Context,
  node: Ast.Node,
  parent: Ast.Node,
  path: StatePath,
  write: Codegen.HelperWrite,
): void {
  context.markReplaced(path.replaces);
  context.recordWrite(path.root, true);
  const asExpression = parent.type !== "ExpressionStatement";
  context.emit(
    node,
    Codegen.helperWrite(path.root, path.keys, write, asExpression),
  );
}

/**
 * Compiles an assignment: a write to state, or a local that may now point into
 * state.
 */
export function assignment(
  context: Context,
  node: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  const target = Ast.unwrap(node.left);

  if (target.type === "Identifier") {
    const binding = bindingOf(context, target.name);
    if (binding.kind === "alias") {
      throw new MutError(
        `\`${target.name}\` refers into state and can't be reassigned`,
        target.start,
      );
    }
    if (binding.kind === "maybeState" || touchesState(context, node.right)) {
      context.markMaybeState(target.name, null);
    }
    return;
  }
  if (target.type !== "MemberExpression") {
    // Destructuring assignment: the assigned locals may now point into state.
    if (touchesState(context, node.right)) {
      for (const name of Ast.bindingNames(target)) {
        context.markMaybeState(name, null);
      }
    }
    return;
  }

  const path = pathOf(context, target, { depth, forWrite: true });
  if (!path) {
    return;
  }
  const write: Codegen.InlineWrite & Codegen.HelperWrite =
    node.operator === "="
      ? { kind: "set", value: node.right }
      : {
          kind: "compound",
          operator: node.operator.slice(0, -1),
          value: node.right,
        };
  if (!emitInline(context, parent, path, write)) {
    emitHelper(context, node, parent, path, write);
  }
}

/**
 * Compiles `++` / `--` on state.
 */
export function update(
  context: Context,
  node: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  if (Ast.unwrap(node.argument).type !== "MemberExpression") {
    return;
  }
  const path = pathOf(context, node.argument, {
    depth,
    forWrite: true,
  });
  if (
    !path ||
    emitInline(context, parent, path, {
      kind: "update",
      operator: node.operator,
    })
  ) {
    return;
  }
  emitHelper(context, node, parent, path, {
    kind: "increment",
    delta: node.operator === "++" ? 1 : -1,
    prefix: node.prefix,
  });
}

/**
 * `delete path.key`.
 */
export function remove(
  context: Context,
  node: Ast.Node,
  parent: Ast.Node,
  depth: number,
): void {
  if (
    node.operator !== "delete" ||
    Ast.unwrap(node.argument).type !== "MemberExpression"
  ) {
    return;
  }
  const path = pathOf(context, node.argument, {
    depth,
    forWrite: true,
    verb: "deletes",
  });
  if (!path || emitInline(context, parent, path, { kind: "delete" })) {
    return;
  }
  emitHelper(context, node, parent, path, { kind: "remove" });
}

/**
 * `path.push(x)`, `path.set(k, v)`, …, or a computed method (`path[m](x)`),
 * which may mutate too.
 */
export function mutatingCall(
  context: Context,
  call: Ast.Node,
  method: string | null,
  depth: number,
  parent: Ast.Node,
): void {
  const callee = Ast.unwrap(call.callee);
  if (callee.optional || call.optional) {
    if (touchesState(context, callee.object)) {
      throw new MutError(
        "optional mutating calls on state aren't supported yet",
        call.start,
      );
    }
    return;
  }
  const path = pathOf(context, callee.object, {
    depth,
    forWrite: true,
    verb: "mutating calls",
  });
  if (!path) {
    return;
  }
  emitHelper(context, call, parent, path, {
    kind: "callMethod",
    method: callee.computed ? callee.property : JSON.stringify(method),
    args: call.arguments,
  });
}

function isReadOnlyCall(context: Context, callee: Ast.Node): boolean {
  const name = Ast.dottedName(callee);
  if (!name) {
    return false;
  }
  if (context.options.readonlyCalls.includes(name)) {
    return true;
  }
  return (
    bindingOf(context, name.split(".")[0]).kind === "global" &&
    Ast.isReadOnlyGlobal(name)
  );
}

function mayChangeReceiver(call: Ast.Node, method: string | null): boolean {
  if (!method || !Ast.isReadOnlyMethod(method)) {
    return true;
  }

  // An iteration method with a function reference (not an inline callback) may
  // change the elements.
  return Ast.isIterationMethod(method) && !Ast.isFunction(call.arguments[0]);
}

function lendState(
  context: Context,
  call: Ast.Node,
  argument: Ast.Node,
  depth: number,
): void {
  const value =
    argument.type === "SpreadElement" ? argument.argument : argument;
  const callee = context.sourceOf(call.callee);
  const expression = Ast.unwrap(value);
  const binding =
    expression.type === "Identifier"
      ? bindingOf(context, expression.name)
      : null;
  if (binding?.kind === "maybeState") {
    if (binding.promotable) {
      throw new PromoteToAlias(binding.promotable);
    }
    context.warn(
      `\`${expression.name}\` may point into state; ` +
        `changes \`${callee}\` makes through it aren't tracked`,
      expression.start,
    );
    return;
  }

  const path = pathOf(context, value, { depth, forWrite: false });
  if (!path || depth > 0) {
    return;
  }
  const root = bindingOf(context, path.root);
  if (root.kind === "root" && !Ast.isReassignable(root.declaredAs)) {
    return; // not state this block can rebind
  }

  const { opaqueCalls } = context.options;
  if (opaqueCalls === "error") {
    throw new MutError(
      `\`${callee}\` may change state the compiler can't see into`,
      call.start,
    );
  }
  if (opaqueCalls === "warn") {
    context.warn(
      `\`${callee}\` may change state, so it gets a deep copy ` +
        "(reconciled at the end of the block)",
      call.start,
    );
  }
  context.markReplaced(path.replaces);
  context.recordLend(path.root);
  context.emit(value, Codegen.lendCall(path.root, path.keys));
}

/**
 * Lends state to the arguments (and the receiver, for unknown methods) of a
 * call the compiler can't see into.
 */
export function opaqueCall(
  context: Context,
  call: Ast.Node,
  depth: number,
): void {
  if (isReadOnlyCall(context, call.callee)) {
    return;
  }
  const method =
    call.type === "CallExpression" ? Ast.methodName(call) : undefined;
  if (method !== undefined && mayChangeReceiver(call, method)) {
    lendState(context, call, Ast.unwrap(call.callee).object, depth);
  }
  for (const argument of call.arguments) {
    if (!Ast.isFunction(argument)) {
      lendState(context, call, argument, depth);
    }
  }
}
