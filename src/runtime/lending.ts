/**
 * Copy-in, reconcile-out: state passed to code the compiler can't see into
 * (e.g. `rename(s.user)`) is replaced by a deep copy the callee may mutate;
 * at the end of the block, unchanged parts are swapped back for the originals.
 */
import { copyAlongPath, ownedCopy, type Context } from "./context.ts";
import { isObject, type StateNode } from "./draftable.ts";
import { readPath, type Key, type Path } from "./path.ts";

/** Copies `value` and everything draftable below it, all owned by this block. */
function deepCopy(context: Context, value: StateNode, seen = new Map<object, StateNode>()): StateNode {
  if (!isObject(value)) return value;
  const known = seen.get(value);
  if (known) return known;
  const copy = ownedCopy(context, value);
  if (!context.copies.has(copy)) return value; // not draftable
  seen.set(value, copy);

  if (copy instanceof Map) {
    for (const [key, child] of copy) copy.set(key, deepCopy(context, child, seen));
  } else if (copy instanceof Set) {
    const items = [...copy];
    copy.clear();
    for (const item of items) copy.add(deepCopy(context, item, seen));
  } else {
    for (const key of Object.keys(copy)) copy[key] = deepCopy(context, copy[key], seen);
  }
  return copy;
}

/**
 * Puts a deep copy of `root.path` into the new tree and leaves it in
 * `context.result`, so it can be handed to the callee.
 */
export function lendDeepCopy(context: Context, path: Path, root: StateNode): StateNode {
  const value = readPath(root, path);
  if (!isObject(value)) {
    context.result = value;
    return root;
  }
  if (path.length === 0) {
    context.result = deepCopy(context, root);
    return context.result;
  }

  const newRoot = ownedCopy(context, root);
  const last = path.length - 1;
  const copy = deepCopy(context, value);
  copyAlongPath(context, newRoot, path, last)[path[last] as Key] = copy;
  context.result = copy;
  return newRoot;
}

/** Whether `copy` has the same own entries as `base` (compared with `Object.is`). */
function hasSameEntries(copy: StateNode, base: StateNode): boolean {
  if (!isObject(base) || Object.getPrototypeOf(copy) !== Object.getPrototypeOf(base)) return false;
  const other = base as StateNode;
  if (copy instanceof Map) return copy.size === other.size && [...copy].every(([key, value]) => other.has(key) && Object.is(other.get(key), value));
  if (copy instanceof Set) return copy.size === other.size && [...copy].every((item) => other.has(item));
  const keys = Object.keys(copy);
  return keys.length === Object.keys(other).length && keys.every((key) => Object.hasOwn(other, key) && Object.is(copy[key], other[key]));
}

/**
 * Walks the nodes copied in this block below `node` and swaps each one that
 * ended up equal to its counterpart in `base` back for that original.
 */
export function restoreSharing(context: Context, node: StateNode, base: StateNode): StateNode {
  if (node === base || !context.copies.has(node)) return node;
  if (node instanceof Map) {
    for (const [key, child] of node) node.set(key, restoreSharing(context, child, base instanceof Map ? base.get(key) : undefined));
  } else if (!(node instanceof Set)) {
    for (const key of Object.keys(node)) node[key] = restoreSharing(context, node[key], base?.[key]);
  }
  return hasSameEntries(node, base) ? base : node;
}
