import type { Keys } from "./path.ts";

// biome-ignore lint/suspicious/noExplicitAny: state is arbitrary user data.
export type StateNode = any;

/**
 * Classes marked with this symbol are copied like plain objects (the same
 * symbol as immer's `immerable`).
 */
export const immerable: unique symbol = Symbol.for("immer-draftable") as never;

/**
 * Whether `value` is a non-null object.
 */
export function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Plain objects, arrays, Map, Set, null-prototype objects and classes marked
 * `immerable`.
 */
export function isDraftable(value: object): boolean {
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) {
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  return (
    proto === Object.prototype ||
    proto === null ||
    immerable in value ||
    Boolean(proto.constructor?.[immerable])
  );
}

/**
 * A shallow copy of a draftable value, keeping its prototype. Other values are
 * returned as is: they are shared, and writes go straight through (as in
 * immer).
 */
export function shallowCopy(value: StateNode): StateNode {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (value instanceof Map) {
    return new Map(value);
  }
  if (value instanceof Set) {
    return new Set(value);
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return { ...value };
  }
  if (isDraftable(value)) {
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value);
  }
  return value;
}

/**
 * State for one `mut:` block that uses helpers: the copies made within the
 * block, plus slots the generated code reads results from.
 */
export interface Context {
  /**
   * The copies made in this block; the block may write to them directly.
   */
  copies: Set<object>;

  /**
   * Result of the last helper, for writes used as expressions.
   */
  result: unknown;

  /**
   * Value before a postfix `++` / `--`.
   */
  previousValue: unknown;

  /**
   * Path of a compound assignment (`+=`), so its keys are evaluated once.
   */
  compoundPath: Keys;
}

/**
 * A fresh context for a block that uses helpers.
 */
export function createContext(): Context {
  return {
    copies: new Set(),
    result: undefined,
    previousValue: undefined,
    compoundPath: [],
  };
}

/**
 * The block's copy of `value`, made at most once. Primitives and non-draftables
 * pass through.
 */
export function ownedCopy(context: Context, value: StateNode): StateNode {
  if (!isObject(value) || context.copies.has(value)) {
    return value;
  }
  const copy = shallowCopy(value);
  if (copy !== value) {
    context.copies.add(copy);
  }
  return copy;
}

/**
 * Copies the nodes along the first `depth` keys of `path` below `root` (which
 * must already be owned), linking each copy into its parent. Returns the owned
 * node at that depth. The path must already be resolved by `Path.read`.
 */
export function ownAlong(
  context: Context,
  root: StateNode,
  path: Keys,
  depth: number,
): StateNode {
  let node = root;
  for (let i = 0; i < depth; i++) {
    const key = path[i] as PropertyKey;
    const child = node[key];
    const copy = ownedCopy(context, child);
    if (copy !== child) {
      node[key] = copy;
    }
    node = copy;
  }
  return node;
}

/**
 * The block's copy of `value` and of everything draftable below it.
 */
export function deepCopy(
  context: Context,
  value: StateNode,
  seen = new Map<object, StateNode>(),
): StateNode {
  if (!isObject(value)) {
    return value;
  }
  const known = seen.get(value);
  if (known) {
    return known;
  }
  const copy = ownedCopy(context, value);
  if (!context.copies.has(copy)) {
    return value; // not draftable
  }
  seen.set(value, copy);

  if (copy instanceof Map) {
    for (const [key, child] of copy) {
      copy.set(key, deepCopy(context, child, seen));
    }
  } else if (copy instanceof Set) {
    const items = [...copy];
    copy.clear();
    for (const item of items) {
      copy.add(deepCopy(context, item, seen));
    }
  } else {
    for (const key of Object.keys(copy)) {
      copy[key] = deepCopy(context, copy[key], seen);
    }
  }
  return copy;
}

function throwFrozen(): never {
  throw new TypeError(
    "mut: this collection is frozen; change it inside a `mut:` block",
  );
}

/**
 * Deep-freezes draftable values, stopping at values that are already frozen
 * (so after the first block only new nodes are visited). Map and Set get
 * throwing mutators, since `Object.freeze` doesn't stop `set`/`add`.
 */
export function freeze<T>(value: T): T {
  if (!isObject(value) || Object.isFrozen(value) || !isDraftable(value)) {
    return value;
  }
  let children: Iterable<unknown> = Object.values(value);
  if (value instanceof Map || value instanceof Set) {
    for (const method of ["set", "add", "delete", "clear"]) {
      if (method in value) {
        Object.defineProperty(value, method, { value: throwFrozen });
      }
    }
    children = value.values();
  }
  Object.freeze(value);
  for (const child of children) {
    freeze(child);
  }
  return value;
}
