/**
 * Locals that point into state: declarations (`const user = s.user`),
 * `for...of` loops over state, and the element parameter of iteration
 * callbacks. They stay plain locals unless the block writes through them;
 * then (on the next pass) they are compiled as aliases of their location.
 */
import { bindingNames, isFunction, unwrapExpression, type AstNode } from "../ast.ts";
import { aliasAccess, isPlainKey, joinArguments, joinKeys, RUNTIME, type Alias } from "../codegen.ts";
import { elementParamIndex, isIterationMethod } from "../known-calls.ts";
import { aliasForPath, declareAlias, markMaybeState, promotableBase, resolveBinding, touchesState } from "./bindings.ts";
import { emit, emitRange, markReplaced, type BlockContext } from "./context.ts";
import { statePathOf, type StatePath } from "./state-path.ts";

/** A read of an alias becomes a read of its location. */
export function compileAliasRead(context: BlockContext, identifier: AstNode): void {
  const binding = resolveBinding(context, identifier.name);
  if (binding.kind === "alias") emit(context, identifier, [aliasAccess(binding.alias)]);
}

/** `{ user }` with `user` an alias becomes `{ user: s.user }`. */
export function compileShorthandAliasRead(context: BlockContext, property: AstNode): void {
  if (!property.shorthand || property.value.type !== "Identifier") return;
  const binding = resolveBinding(context, property.value.name);
  if (binding.kind !== "alias") return;
  markReplaced(context, [property.value]);
  emit(context, property, [`${property.value.name}: ${aliasAccess(binding.alias)}`]);
}

/** `const user = s.user`: an alias if written through; otherwise a plain local that may point into state. */
export function compileDeclarator(context: BlockContext, declarator: AstNode, depth: number): void {
  if (!declarator.init) return;
  const binding = declarator.id.type === "Identifier" ? declarator.id : null;
  const path = binding ? statePathOf(context, declarator.init, { depth, forWrite: false }) : null;
  if (!path) {
    const promotable = binding ? promotableBase(context, declarator.init) : null;
    if (touchesState(context, declarator.init)) for (const name of bindingNames(declarator.id)) markMaybeState(context, name, promotable);
    return;
  }
  if (!context.promoted.has(binding)) return markMaybeState(context, binding.name, binding);

  const { alias, needsHolder } = aliasForPath(path, binding.name);
  declareAlias(context, binding, alias);
  if (!needsHolder) return;
  // Hold the path, with its computed keys captured now (and `find` resolved once).
  markReplaced(context, path.replaces);
  const keys = ["[", ...joinKeys(path.keys), "]"];
  emit(context, declarator.init, path.hasFindKey ? [`${RUNTIME}.resolvePath(`, ...keys, `, ${path.root})`] : keys);
}

/** `for (const item of s.todos)`: written through, it becomes an index loop with `item` read as `s.todos[item]`. */
export function compileForOf(context: BlockContext, loop: AstNode, depth: number): void {
  const declarator = loop.left.type === "VariableDeclaration" ? loop.left.declarations[0] : null;
  const binding = declarator?.id.type === "Identifier" ? declarator.id : null;
  const path = binding ? statePathOf(context, loop.right, { depth, forWrite: false }) : null;
  if (!path) {
    const promotable = binding ? promotableBase(context, loop.right) : null;
    if (touchesState(context, loop.right)) for (const name of bindingNames(declarator ? declarator.id : loop.left)) markMaybeState(context, name, promotable);
    return;
  }
  if (!context.promoted.has(binding)) return markMaybeState(context, binding.name, binding);

  const item = binding.name;
  if (path.keys.every(isPlainKey) && !loop.await) {
    const keys = path.keys.map(([key]) => key as string);
    const list = aliasAccess({ root: path.root, keys });
    declareAlias(context, binding, { root: path.root, keys: [...keys, item] }, path.replaces);
    emitRange(context, loop.start, loop.body.start, [`for (let ${item} = (${RUNTIME}.assertArray(${list}), 0); ${item} < ${list}.length; ${item}++) `]);
    return;
  }
  const { alias } = aliasForPath(path, item);
  declareAlias(context, binding, { root: alias.root, keys: [...alias.keys, `${item}[${path.keys.length}]`] }, path.replaces);
  emit(context, loop.right, [`${RUNTIME}.elementPaths(() => ${path.root}, [`, ...joinKeys(path.keys), "])"]);
}

/**
 * The alias for the element of an iteration callback that writes through it.
 * On a plain path the call stays as is and the element is read by index
 * (`s.todos[i]`, adding the index parameter if needed); otherwise the call
 * goes through `iterateWithPaths`, which passes element paths.
 */
function iterationElementAlias(context: BlockContext, call: AstNode, callback: AstNode, receiver: StatePath, method: string, elementIndex: number): Alias {
  const element = callback.params[elementIndex];
  const index = callback.params[elementIndex + 1];
  if (receiver.keys.every(isPlainKey) && element.type === "Identifier" && (!index || index.type === "Identifier")) {
    let indexName = index?.name;
    if (!indexName) {
      indexName = context.variables.nextIndex();
      const hasParens = /[(,]$/.test(context.code.slice(callback.start, element.start).trimEnd());
      emit(context, element, [hasParens ? "" : "(", element, `, ${indexName}`, hasParens ? "" : ")"]);
    }
    return { root: receiver.root, keys: [...receiver.keys.map(([key]) => key as string), indexName] };
  }
  markReplaced(context, receiver.replaces);
  const methodName = JSON.stringify(method);
  emit(context, call, [`${RUNTIME}.iterateWithPaths([`, ...joinKeys(receiver.keys), `], ${methodName}, [`, ...joinArguments(call.arguments), `], ${receiver.root})`]);
  const { alias } = aliasForPath(receiver, element.name);
  return { root: alias.root, keys: [...alias.keys, `${element.name}[${receiver.keys.length}]`] };
}

/**
 * Registers the inline callback of an iteration method on state (or on a
 * local that may become an alias). Returns false if `call` isn't one.
 */
export function registerIterationCallback(context: BlockContext, call: AstNode, method: string | null | undefined, depth: number): boolean {
  const callback = call.arguments[0];
  if (!method || !isIterationMethod(method) || !isFunction(callback)) return false;
  const elementIndex = elementParamIndex(method);
  const receiver = unwrapExpression(call.callee).object;

  const path = statePathOf(context, receiver, { depth, forWrite: false });
  if (path) {
    const registered = { receiver: path, elementIndex, elementAlias: undefined as Alias | undefined };
    context.iterationCallbacks.set(callback, registered);
    if (context.promoted.has(callback.params[elementIndex])) {
      registered.elementAlias = iterationElementAlias(context, call, callback, path, method, elementIndex);
    }
    return true;
  }

  const promotable = promotableBase(context, receiver);
  if (!promotable) return false;
  context.callbacksPromotingReceiver.set(callback, { binding: promotable, elementIndex });
  return true;
}

/** Marks the parameters of functions passed to calls that touch state as maybe pointing into state. */
export function markCallbackParamsAsMaybeState(context: BlockContext, call: AstNode): void {
  const touches = touchesState(context, call.callee) || call.arguments.some((argument: AstNode) => touchesState(context, argument));
  if (!touches) return;
  for (const argument of call.arguments) {
    const isRegistered = context.iterationCallbacks.has(argument) || context.callbacksPromotingReceiver.has(argument);
    if (isFunction(argument) && !isRegistered) context.callbacksWithStateParams.add(argument);
  }
}

/** For each parameter: `onElement` for the element, nothing for the index, "may be state" for the rest. */
function bindIterationParams(context: BlockContext, callback: AstNode, elementIndex: number, onElement: (element: AstNode) => void): void {
  callback.params.forEach((param: AstNode, i: number) => {
    if (i === elementIndex && param.type === "Identifier") onElement(param);
    else if (i !== elementIndex + 1) for (const name of bindingNames(param)) markMaybeState(context, name, null);
  });
}

/** Binds the parameters of a function as its scope is entered (the scope must already be pushed). */
export function bindFunctionParams(context: BlockContext, fn: AstNode): void {
  if (context.callbacksWithStateParams.has(fn)) {
    for (const param of fn.params) for (const name of bindingNames(param)) markMaybeState(context, name, null);
  }

  const promotingReceiver = context.callbacksPromotingReceiver.get(fn);
  if (promotingReceiver) {
    bindIterationParams(context, fn, promotingReceiver.elementIndex, (element) => markMaybeState(context, element.name, promotingReceiver.binding));
  }

  const callback = context.iterationCallbacks.get(fn);
  if (callback) {
    bindIterationParams(context, fn, callback.elementIndex, (element) => {
      if (context.promoted.has(element) && callback.elementAlias) declareAlias(context, element, callback.elementAlias);
      else markMaybeState(context, element.name, element);
    });
  }
}
