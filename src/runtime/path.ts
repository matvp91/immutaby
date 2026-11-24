/**
 * Reading and writing state at a path, for code the compiler doesn't inline.
 *
 * Helpers that write take the root last and return the (possibly new) root:
 * taking it last means it is read after the right-hand side has run, so
 * writes nested in the right-hand side are kept.
 */
import * as Draft from "./draft.ts";
import type { StateNode } from "./draft.ts";

/**
 * A key resolved at runtime: `s.todos.find(p)` becomes the index of the first
 * (or last) element matching `p`.
 */
export class FindIndexKey {
  readonly method: "findIndex" | "findLastIndex";
  readonly predicate: (value: unknown, index: number, array: unknown[]) => unknown;

  constructor(method: FindIndexKey["method"], predicate: FindIndexKey["predicate"]) {
    this.method = method;
    this.predicate = predicate;
  }
}

export type Key = PropertyKey;
export type Keys = (Key | FindIndexKey)[];

export function findIndexKey(method: FindIndexKey["method"], predicate: FindIndexKey["predicate"]): FindIndexKey {
  return new FindIndexKey(method, predicate);
}

/**
 * Reads `root` at `path` (or at its first `depth` keys). `FindIndexKey`s are
 * replaced in `path` by the index they resolve to, so later walks over the
 * same path see plain keys.
 */
export function read(root: StateNode, path: Keys, depth = path.length): StateNode {
  let node = root;
  for (let i = 0; i < depth; i++) {
    const segment = path[i];
    const key = segment instanceof FindIndexKey ? (path[i] = node[segment.method](segment.predicate) as number) : segment;
    node = node[key];
  }
  return node;
}

/** Resolves the `FindIndexKey`s of `path` once, so it can be held by an alias. */
export function resolve(path: Keys, root: StateNode): Keys {
  read(root, path);
  return path;
}

/** Whether `parent[key] = value` would change nothing. */
export function isUnchanged(parent: StateNode, key: Key, value: unknown): boolean {
  return Object.is(parent[key], value) && (value !== undefined || key in parent);
}

/** `root.path = value`. */
export function write(context: Draft.Context, path: Keys, value: unknown, root: StateNode): StateNode {
  context.result = value;
  const last = path.length - 1;
  const key = path[last] as Key;
  if (isUnchanged(read(root, path, last), key, value)) return root;

  const newRoot = Draft.owned(context, root);
  Draft.ownAlong(context, newRoot, path, last)[key] = value;
  return newRoot;
}

/** `root.path++` / `root.path--`, with `delta` of 1 or -1. */
export function increment(context: Draft.Context, path: Keys, delta: 1 | -1, root: StateNode): StateNode {
  const current = read(root, path);
  const previous = typeof current === "bigint" ? current : Number(current);
  context.previousValue = previous;
  const next = typeof previous === "bigint" ? previous + BigInt(delta) : previous + delta;
  return write(context, path, next, root);
}

/** `delete root.path`. */
export function remove(context: Draft.Context, path: Keys, root: StateNode): StateNode {
  context.result = true;
  const last = path.length - 1;
  const key = path[last] as Key;
  if (!(key in read(root, path, last))) return root;

  const newRoot = Draft.owned(context, root);
  delete Draft.ownAlong(context, newRoot, path, last)[key];
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
export function callMethod(context: Draft.Context, path: Keys, method: Key, args: unknown[], root: StateNode): StateNode {
  const target = read(root, path);
  if (!wouldMutate(target, method, args)) {
    context.result = target[method](...args);
    return root;
  }

  const newRoot = Draft.owned(context, root);
  context.result = Draft.ownAlong(context, newRoot, path, path.length)[method](...args);
  return newRoot;
}

/** Compiled `for...of` loops over state are index loops, which only work on arrays. */
export function assertArray(value: unknown, loop = "for...of"): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`mut: ${loop} over state supports arrays only`);
}

/** `for (const item of root.path)` where keys aren't static: yields the path of each element. */
export function* elements(getRoot: () => StateNode, path: Keys): Generator<Keys> {
  assertArray(read(getRoot(), path));
  for (let i = 0; i < read(getRoot(), path).length; i++) yield [...path, i];
}

/**
 * `root.path.method(callback, ...rest)` where keys aren't static and the
 * callback writes through its element: the callback receives element paths.
 */
export function iterate(path: Keys, method: string, args: unknown[], root: StateNode): unknown {
  const list = read(root, path);
  assertArray(list, method);
  const [callback, ...rest] = args as [(...callbackArgs: unknown[]) => unknown, ...unknown[]];
  const elementPath = (index: number): Keys => [...path, index];
  const withPaths =
    method === "reduce" || method === "reduceRight"
      ? (accumulator: unknown, _element: unknown, index: number, array: unknown) => callback(accumulator, elementPath(index), index, array)
      : (_element: unknown, index: number, array: unknown) => callback(elementPath(index), index, array);
  return (list as StateNode)[method](withPaths, ...rest);
}
