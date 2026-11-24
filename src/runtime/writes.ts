/**
 * Helpers for writes the compiler doesn't inline. Each takes the root last
 * and returns the (possibly new) root: taking it last means it is read after
 * the right-hand side has run, so writes nested in the right-hand side are kept.
 */
import { copyAlongPath, ownedCopy, type Context } from "./context.ts";
import type { StateNode } from "./draftable.ts";
import { readPath, type Key, type Path } from "./path.ts";

/** Whether `parent[key] = value` would change nothing. */
export function isUnchanged(parent: StateNode, key: Key, value: unknown): boolean {
  return Object.is(parent[key], value) && (value !== undefined || key in parent);
}

/** `root.path = value`. */
export function writePath(context: Context, path: Path, value: unknown, root: StateNode): StateNode {
  context.result = value;
  const last = path.length - 1;
  const key = path[last] as Key;
  if (isUnchanged(readPath(root, path, last), key, value)) return root;

  const newRoot = ownedCopy(context, root);
  copyAlongPath(context, newRoot, path, last)[key] = value;
  return newRoot;
}

/** `root.path++` / `root.path--`, with `delta` of 1 or -1. */
export function incrementPath(context: Context, path: Path, delta: 1 | -1, root: StateNode): StateNode {
  const current = readPath(root, path);
  const previous = typeof current === "bigint" ? current : Number(current);
  context.previousValue = previous;
  const next = typeof previous === "bigint" ? previous + BigInt(delta) : previous + delta;
  return writePath(context, path, next, root);
}

/** `delete root.path`. */
export function deletePath(context: Context, path: Path, root: StateNode): StateNode {
  context.result = true;
  const last = path.length - 1;
  const key = path[last] as Key;
  if (!(key in readPath(root, path, last))) return root;

  const newRoot = ownedCopy(context, root);
  delete copyAlongPath(context, newRoot, path, last)[key];
  return newRoot;
}

const MUTATING_ARRAY_METHODS = new Set<Key>(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

/** Whether calling `method` with `args` on `target` would change it (calls that change nothing don't copy). */
function wouldMutate(target: StateNode, method: Key, args: unknown[]): boolean {
  if (Array.isArray(target)) return MUTATING_ARRAY_METHODS.has(method);

  if (target instanceof Map) {
    if (method === "set") return !(target.has(args[0]) && Object.is(target.get(args[0]), args[1]));
    if (method === "delete") return target.has(args[0]);
    if (method === "clear") return target.size > 0;
  }

  if (target instanceof Set) {
    if (method === "add") return !target.has(args[0]);
    if (method === "delete") return target.has(args[0]);
    if (method === "clear") return target.size > 0;
  }

  return false;
}

/** `root.path.method(...args)` for a method that may mutate its receiver (array, Map and Set mutators). */
export function callMethodAtPath(context: Context, path: Path, method: Key, args: unknown[], root: StateNode): StateNode {
  const target = readPath(root, path);
  if (!wouldMutate(target, method, args)) {
    context.result = target[method](...args);
    return root;
  }

  const newRoot = ownedCopy(context, root);
  context.result = copyAlongPath(context, newRoot, path, path.length)[method](...args);
  return newRoot;
}
