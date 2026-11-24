import type { Context, StateNode } from "./draft.ts";
import { deepCopy, isObject, ownAlong, ownedCopy } from "./draft.ts";
import type { Key, Keys } from "./path.ts";
import { read } from "./path.ts";

/**
 * Puts a deep copy of `root.path` into the new tree and leaves it in
 * `context.result`, to hand to the callee.
 */
export function lend(context: Context, path: Keys, root: StateNode): StateNode {
  const value = read(root, path);
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
  ownAlong(context, newRoot, path, last)[path[last] as Key] = copy;
  context.result = copy;
  return newRoot;
}

function hasSameEntries(copy: StateNode, base: StateNode): boolean {
  if (
    !isObject(base) ||
    Object.getPrototypeOf(copy) !== Object.getPrototypeOf(base)
  ) {
    return false;
  }
  const other = base as StateNode;
  if (copy instanceof Map) {
    return (
      copy.size === other.size &&
      [...copy].every(
        ([key, value]) => other.has(key) && Object.is(other.get(key), value),
      )
    );
  }
  if (copy instanceof Set) {
    return (
      copy.size === other.size && [...copy].every((item) => other.has(item))
    );
  }
  const keys = Object.keys(copy);
  return (
    keys.length === Object.keys(other).length &&
    keys.every(
      (key) => Object.hasOwn(other, key) && Object.is(copy[key], other[key]),
    )
  );
}

/**
 * Walks the block's copies below `node` and swaps each one that ended up equal
 * to its counterpart in `base` back for that original.
 */
export function restoreSharing(
  context: Context,
  node: StateNode,
  base: StateNode,
): StateNode {
  if (node === base || !context.copies.has(node)) {
    return node;
  }
  if (node instanceof Map) {
    for (const [key, child] of node) {
      node.set(
        key,
        restoreSharing(
          context,
          child,
          base instanceof Map ? base.get(key) : undefined,
        ),
      );
    }
  } else if (!(node instanceof Set)) {
    for (const key of Object.keys(node)) {
      node[key] = restoreSharing(context, node[key], base?.[key]);
    }
  }
  return hasSameEntries(node, base) ? base : node;
}
