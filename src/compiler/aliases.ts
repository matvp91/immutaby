import * as Ast from "./ast.ts";
import * as Codegen from "./codegen.ts";
import type { Context } from "./compile.ts";
import type { StatePath } from "./resolve.ts";
import {
  bindingOf,
  pathOf,
  promotableBaseOf,
  touchesState,
} from "./resolve.ts";

// The alias for a local bound to `path`. Plain keys are kept; the others are
// read from `holder`, which must then hold the resolved path at runtime.
function aliasFor(
  path: StatePath,
  holder: string,
): { alias: Codegen.Alias; needsHolder: boolean } {
  const keys = path.keys.map((key, i) =>
    Codegen.isPlainKey(key) ? key[0] : Codegen.member(holder, String(i)),
  );
  return {
    alias: { root: path.root, keys },
    needsHolder: !path.keys.every(Codegen.isPlainKey),
  };
}

// An alias to the element `holder` holds the path of, one key past `path`.
function elementAliasFor(path: StatePath, holder: string): Codegen.Alias {
  const { alias } = aliasFor(path, holder);
  return {
    root: alias.root,
    keys: [...alias.keys, Codegen.member(holder, String(path.keys.length))],
  };
}

/**
 * A read of an alias becomes a read of its location.
 */
export function read(context: Context, identifier: Ast.Node): void {
  const binding = bindingOf(context, identifier.name);
  if (binding.kind === "alias") {
    context.emit(identifier, [Codegen.aliasRead(binding.alias)]);
  }
}

/**
 * `{ user }` with `user` an alias becomes `{ user: s.user }`.
 */
export function shorthand(context: Context, property: Ast.Node): void {
  if (!property.shorthand || property.value.type !== "Identifier") {
    return;
  }
  const binding = bindingOf(context, property.value.name);
  if (binding.kind !== "alias") {
    return;
  }
  context.markReplaced([property.value]);
  context.emit(property, [
    `${property.value.name}: ${Codegen.aliasRead(binding.alias)}`,
  ]);
}

/**
 * `const user = s.user`: an alias if written through; otherwise a plain local
 * that may point into state.
 */
export function declarator(
  context: Context,
  node: Ast.Node,
  depth: number,
): void {
  if (!node.init) {
    return;
  }
  const binding = node.id.type === "Identifier" ? node.id : null;
  const path = binding
    ? pathOf(context, node.init, { depth, forWrite: false })
    : null;
  if (!path) {
    const promotable = binding ? promotableBaseOf(context, node.init) : null;
    if (touchesState(context, node.init)) {
      for (const name of Ast.bindingNames(node.id)) {
        context.markMaybeState(name, promotable);
      }
    }
    return;
  }
  if (!context.promoted.has(binding)) {
    context.markMaybeState(binding.name, binding);
    return;
  }

  const { alias, needsHolder } = aliasFor(path, binding.name);
  context.declareAlias(binding, alias);
  if (!needsHolder) {
    return;
  }
  context.markReplaced(path.replaces);
  context.emit(
    node.init,
    Codegen.pathHolder(path.root, path.keys, path.hasFindKey),
  );
}

/**
 * `for (const item of s.todos)`: written through, it becomes an index loop with
 * `item` read as `s.todos[item]`.
 */
export function forOf(context: Context, loop: Ast.Node, depth: number): void {
  const declaration =
    loop.left.type === "VariableDeclaration" ? loop.left.declarations[0] : null;
  const binding = declaration?.id.type === "Identifier" ? declaration.id : null;
  const path = binding
    ? pathOf(context, loop.right, { depth, forWrite: false })
    : null;
  if (!path) {
    const promotable = binding ? promotableBaseOf(context, loop.right) : null;
    const pattern = declaration ? declaration.id : loop.left;
    if (touchesState(context, loop.right)) {
      for (const name of Ast.bindingNames(pattern)) {
        context.markMaybeState(name, promotable);
      }
    }
    return;
  }
  if (!context.promoted.has(binding)) {
    context.markMaybeState(binding.name, binding);
    return;
  }

  const item = binding.name;
  if (path.keys.every(Codegen.isPlainKey) && !loop.await) {
    const keys = path.keys.map(([key]) => key as string);
    const list = Codegen.aliasRead({ root: path.root, keys });
    context.declareAlias(
      binding,
      { root: path.root, keys: [...keys, item] },
      path.replaces,
    );
    context.emitRange(loop.start, loop.body.start, [
      Codegen.indexLoopHeader(item, list),
    ]);
    return;
  }
  context.declareAlias(binding, elementAliasFor(path, item), path.replaces);
  context.emit(loop.right, Codegen.elementsCall(path.root, path.keys));
}

// On a plain path the call stays as is and the element is read by index
// (`s.todos[i]`, adding the index parameter if needed); otherwise the call goes
// through `Path.iterate`, which passes element paths.
function elementAlias(
  context: Context,
  call: Ast.Node,
  callback: Ast.Node,
  receiver: StatePath,
  method: string,
  elementIndex: number,
): Codegen.Alias {
  const element = callback.params[elementIndex];
  const index = callback.params[elementIndex + 1];
  if (
    receiver.keys.every(Codegen.isPlainKey) &&
    element.type === "Identifier" &&
    (!index || index.type === "Identifier")
  ) {
    let indexName = index?.name;
    if (!indexName) {
      indexName = context.names.nextIndex();
      const hasParens = /[(,]$/.test(
        context.code.slice(callback.start, element.start).trimEnd(),
      );
      context.emit(
        element,
        Codegen.withIndexParam(element, indexName, hasParens),
      );
    }
    return {
      root: receiver.root,
      keys: [...receiver.keys.map(([key]) => key as string), indexName],
    };
  }
  context.markReplaced(receiver.replaces);
  context.emit(
    call,
    Codegen.iterateCall(receiver.root, receiver.keys, method, call.arguments),
  );
  return elementAliasFor(receiver, element.name);
}

/**
 * Registers the inline callback of an iteration method on state (or on a
 * local that may become an alias). Returns false if `call` isn't one.
 */
export function registerCallback(
  context: Context,
  call: Ast.Node,
  method: string | null | undefined,
  depth: number,
): boolean {
  const callback = call.arguments[0];
  if (!method || !Ast.isIterationMethod(method) || !Ast.isFunction(callback)) {
    return false;
  }
  const elementIndex = Ast.elementParamIndex(method);
  const receiver = Ast.unwrap(call.callee).object;

  const path = pathOf(context, receiver, { depth, forWrite: false });
  if (path) {
    const isPromoted = context.promoted.has(callback.params[elementIndex]);
    context.registerIterationCallback(callback, {
      receiver: path,
      elementIndex,
      ...(isPromoted && {
        elementAlias: elementAlias(
          context,
          call,
          callback,
          path,
          method,
          elementIndex,
        ),
      }),
    });
    return true;
  }

  const promotable = promotableBaseOf(context, receiver);
  if (!promotable) {
    return false;
  }
  context.registerPromotingCallback(callback, {
    binding: promotable,
    elementIndex,
  });
  return true;
}

/**
 * Marks the parameters of other functions passed to calls that touch state as
 * maybe pointing into state.
 */
export function markCallbackParams(context: Context, call: Ast.Node): void {
  const involvesState =
    touchesState(context, call.callee) ||
    call.arguments.some((argument: Ast.Node) =>
      touchesState(context, argument),
    );
  if (!involvesState) {
    return;
  }
  for (const argument of call.arguments) {
    const isRegistered =
      context.iterationCallbacks.has(argument) ||
      context.promotingCallbacks.has(argument);
    if (Ast.isFunction(argument) && !isRegistered) {
      context.markStateParams(argument);
    }
  }
}

// The element goes to `onElement`, the index is left alone, and any other
// parameter may be state.
function bindIterationParams(
  context: Context,
  callback: Ast.Node,
  elementIndex: number,
  onElement: (element: Ast.Node) => void,
): void {
  callback.params.forEach((param: Ast.Node, i: number) => {
    if (i === elementIndex && param.type === "Identifier") {
      onElement(param);
    } else if (i !== elementIndex + 1) {
      for (const name of Ast.bindingNames(param)) {
        context.markMaybeState(name, null);
      }
    }
  });
}

/**
 * Binds a function's parameters as its scope is entered (the scope must already
 * be pushed).
 */
export function bindParams(context: Context, fn: Ast.Node): void {
  if (context.callbacksWithStateParams.has(fn)) {
    for (const param of fn.params) {
      for (const name of Ast.bindingNames(param)) {
        context.markMaybeState(name, null);
      }
    }
  }

  const promoting = context.promotingCallbacks.get(fn);
  if (promoting) {
    bindIterationParams(context, fn, promoting.elementIndex, (element) =>
      context.markMaybeState(element.name, promoting.binding),
    );
  }

  const callback = context.iterationCallbacks.get(fn);
  if (callback) {
    bindIterationParams(context, fn, callback.elementIndex, (element) => {
      if (context.promoted.has(element) && callback.elementAlias) {
        context.declareAlias(element, callback.elementAlias);
      } else {
        context.markMaybeState(element.name, element);
      }
    });
  }
}
