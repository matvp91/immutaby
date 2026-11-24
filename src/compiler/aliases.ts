import * as Ast from "./ast.ts";
import type * as Block from "./block.ts";
import * as Calls from "./calls.ts";
import type { Alias } from "./codegen.ts";
import * as Codegen from "./codegen.ts";
import { isPlainKey, RUNTIME } from "./codegen.ts";
import * as State from "./state.ts";

/** A read of an alias becomes a read of its location. */
export function read(context: Block.Context, identifier: Ast.Node): void {
  const binding = State.resolve(context, identifier.name);
  if (binding.kind === "alias") {
    context.emit(identifier, [Codegen.aliasRead(binding.alias)]);
  }
}

/** `{ user }` with `user` an alias becomes `{ user: s.user }`. */
export function shorthandRead(context: Block.Context, property: Ast.Node): void {
  if (!property.shorthand || property.value.type !== "Identifier") {
    return;
  }
  const binding = State.resolve(context, property.value.name);
  if (binding.kind !== "alias") {
    return;
  }
  context.markReplaced([property.value]);
  context.emit(property, [`${property.value.name}: ${Codegen.aliasRead(binding.alias)}`]);
}

/** `const user = s.user`: an alias if written through; otherwise a plain local that may point into state. */
export function declarator(context: Block.Context, node: Ast.Node, depth: number): void {
  if (!node.init) {
    return;
  }
  const binding = node.id.type === "Identifier" ? node.id : null;
  const path = binding ? State.pathOf(context, node.init, { depth, forWrite: false }) : null;
  if (!path) {
    const promotable = binding ? State.promotableBase(context, node.init) : null;
    if (State.touches(context, node.init)) {
      for (const name of Ast.bindingNames(node.id)) {
        State.markMaybeState(context, name, promotable);
      }
    }
    return;
  }
  if (!context.promoted.has(binding)) {
    State.markMaybeState(context, binding.name, binding);
    return;
  }

  const { alias, needsHolder } = State.aliasFor(path, binding.name);
  State.declareAlias(context, binding, alias);
  if (!needsHolder) {
    return;
  }
  // Hold the path, with its computed keys captured now (and `find` resolved once).
  context.markReplaced(path.replaces);
  const keys = ["[", ...Codegen.joinKeys(path.keys), "]"];
  context.emit(node.init, path.hasFindKey ? [`${RUNTIME}.Path.resolve(`, ...keys, `, ${path.root})`] : keys);
}

/** `for (const item of s.todos)`: written through, it becomes an index loop with `item` read as `s.todos[item]`. */
export function forOf(context: Block.Context, loop: Ast.Node, depth: number): void {
  const declaration = loop.left.type === "VariableDeclaration" ? loop.left.declarations[0] : null;
  const binding = declaration?.id.type === "Identifier" ? declaration.id : null;
  const path = binding ? State.pathOf(context, loop.right, { depth, forWrite: false }) : null;
  if (!path) {
    const promotable = binding ? State.promotableBase(context, loop.right) : null;
    const pattern = declaration ? declaration.id : loop.left;
    if (State.touches(context, loop.right)) {
      for (const name of Ast.bindingNames(pattern)) {
        State.markMaybeState(context, name, promotable);
      }
    }
    return;
  }
  if (!context.promoted.has(binding)) {
    State.markMaybeState(context, binding.name, binding);
    return;
  }

  const item = binding.name;
  if (path.keys.every(isPlainKey) && !loop.await) {
    const keys = path.keys.map(([key]) => key as string);
    const list = Codegen.aliasRead({ root: path.root, keys });
    State.declareAlias(context, binding, { root: path.root, keys: [...keys, item] }, path.replaces);
    context.emitRange(loop.start, loop.body.start, [
      `for (let ${item} = (${RUNTIME}.Path.assertArray(${list}), 0); ${item} < ${list}.length; ${item}++) `,
    ]);
    return;
  }
  const { alias } = State.aliasFor(path, item);
  State.declareAlias(
    context,
    binding,
    { root: alias.root, keys: [...alias.keys, `${item}[${path.keys.length}]`] },
    path.replaces,
  );
  context.emit(loop.right, [`${RUNTIME}.Path.elements(() => ${path.root}, [`, ...Codegen.joinKeys(path.keys), "])"]);
}

// On a plain path the call stays as is and the element is read by index (`s.todos[i]`, adding
// the index parameter if needed); otherwise the call goes through `Path.iterate`, which passes
// element paths.
function elementAlias(
  context: Block.Context,
  call: Ast.Node,
  callback: Ast.Node,
  receiver: State.Path,
  method: string,
  elementIndex: number,
): Alias {
  const element = callback.params[elementIndex];
  const index = callback.params[elementIndex + 1];
  if (receiver.keys.every(isPlainKey) && element.type === "Identifier" && (!index || index.type === "Identifier")) {
    let indexName = index?.name;
    if (!indexName) {
      indexName = context.variables.nextIndex();
      const hasParens = /[(,]$/.test(context.code.slice(callback.start, element.start).trimEnd());
      context.emit(element, [hasParens ? "" : "(", element, `, ${indexName}`, hasParens ? "" : ")"]);
    }
    return { root: receiver.root, keys: [...receiver.keys.map(([key]) => key as string), indexName] };
  }
  context.markReplaced(receiver.replaces);
  const methodName = JSON.stringify(method);
  const keys = Codegen.joinKeys(receiver.keys);
  context.emit(call, [
    `${RUNTIME}.Path.iterate([`,
    ...keys,
    `], ${methodName}, [`,
    ...Codegen.joinArguments(call.arguments),
    `], ${receiver.root})`,
  ]);
  const { alias } = State.aliasFor(receiver, element.name);
  return { root: alias.root, keys: [...alias.keys, `${element.name}[${receiver.keys.length}]`] };
}

/**
 * Registers the inline callback of an iteration method on state (or on a
 * local that may become an alias). Returns false if `call` isn't one.
 */
export function registerCallback(
  context: Block.Context,
  call: Ast.Node,
  method: string | null | undefined,
  depth: number,
): boolean {
  const callback = call.arguments[0];
  if (!method || !Calls.isIteration(method) || !Ast.isFunction(callback)) {
    return false;
  }
  const elementIndex = Calls.elementIndex(method);
  const receiver = Ast.unwrap(call.callee).object;

  const path = State.pathOf(context, receiver, { depth, forWrite: false });
  if (path) {
    const registered: Block.IterationCallback = { receiver: path, elementIndex };
    context.iterationCallbacks.set(callback, registered);
    if (context.promoted.has(callback.params[elementIndex])) {
      registered.elementAlias = elementAlias(context, call, callback, path, method, elementIndex);
    }
    return true;
  }

  const promotable = State.promotableBase(context, receiver);
  if (!promotable) {
    return false;
  }
  context.callbacksPromotingReceiver.set(callback, { binding: promotable, elementIndex });
  return true;
}

/** Marks the parameters of other functions passed to calls that touch state as maybe pointing into state. */
export function markCallbackParams(context: Block.Context, call: Ast.Node): void {
  const touchesState =
    State.touches(context, call.callee) ||
    call.arguments.some((argument: Ast.Node) => State.touches(context, argument));
  if (!touchesState) {
    return;
  }
  for (const argument of call.arguments) {
    const isRegistered = context.iterationCallbacks.has(argument) || context.callbacksPromotingReceiver.has(argument);
    if (Ast.isFunction(argument) && !isRegistered) {
      context.callbacksWithStateParams.add(argument);
    }
  }
}

// The element goes to `onElement`, the index is left alone, and any other parameter may be state.
function bindIterationParams(
  context: Block.Context,
  callback: Ast.Node,
  elementIndex: number,
  onElement: (element: Ast.Node) => void,
): void {
  callback.params.forEach((param: Ast.Node, i: number) => {
    if (i === elementIndex && param.type === "Identifier") {
      onElement(param);
    } else if (i !== elementIndex + 1) {
      for (const name of Ast.bindingNames(param)) {
        State.markMaybeState(context, name, null);
      }
    }
  });
}

/** Binds a function's parameters as its scope is entered (the scope must already be pushed). */
export function bindParams(context: Block.Context, fn: Ast.Node): void {
  if (context.callbacksWithStateParams.has(fn)) {
    for (const param of fn.params) {
      for (const name of Ast.bindingNames(param)) {
        State.markMaybeState(context, name, null);
      }
    }
  }

  const promotingReceiver = context.callbacksPromotingReceiver.get(fn);
  if (promotingReceiver) {
    bindIterationParams(context, fn, promotingReceiver.elementIndex, (element) =>
      State.markMaybeState(context, element.name, promotingReceiver.binding),
    );
  }

  const callback = context.iterationCallbacks.get(fn);
  if (callback) {
    bindIterationParams(context, fn, callback.elementIndex, (element) => {
      if (context.promoted.has(element) && callback.elementAlias) {
        State.declareAlias(context, element, callback.elementAlias);
      } else {
        State.markMaybeState(context, element.name, element);
      }
    });
  }
}
