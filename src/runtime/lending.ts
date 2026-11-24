import type { StateNode } from "./draft.ts";
import * as Draft from "./draft.ts";
import * as Path from "./path.ts";

/** Puts a deep copy of `root.path` into the new tree and leaves it in `context.result`, to hand to the callee. */
export function lend(context: Draft.Context, path: Path.Keys, root: StateNode): StateNode {
  const value = Path.read(root, path);
  if (!Draft.isObject(value)) {
    context.result = value;
    return root;
  }
  if (path.length === 0) {
    context.result = Draft.deepCopy(context, root);
    return context.result;
  }

  const newRoot = Draft.owned(context, root);
  const last = path.length - 1;
  const copy = Draft.deepCopy(context, value);
  Draft.ownAlong(context, newRoot, path, last)[path[last] as Path.Key] = copy;
  context.result = copy;
  return newRoot;
}

function hasSameEntries(copy: StateNode, base: StateNode): boolean {
  if (!Draft.isObject(base) || Object.getPrototypeOf(copy) !== Object.getPrototypeOf(base)) {
    return false;
  }
  const other = base as StateNode;
  if (copy instanceof Map) {
    return (
      copy.size === other.size && [...copy].every(([key, value]) => other.has(key) && Object.is(other.get(key), value))
    );
  }
  if (copy instanceof Set) {
    return copy.size === other.size && [...copy].every((item) => other.has(item));
  }
  const keys = Object.keys(copy);
  return (
    keys.length === Object.keys(other).length &&
    keys.every((key) => Object.hasOwn(other, key) && Object.is(copy[key], other[key]))
  );
}

/**
 * Walks the block's copies below `node` and swaps each one that ended up equal
 * to its counterpart in `base` back for that original.
 */
export function restoreSharing(context: Draft.Context, node: StateNode, base: StateNode): StateNode {
  if (node === base || !context.copies.has(node)) {
    return node;
  }
  if (node instanceof Map) {
    for (const [key, child] of node) {
      node.set(key, restoreSharing(context, child, base instanceof Map ? base.get(key) : undefined));
    }
  } else if (!(node instanceof Set)) {
    for (const key of Object.keys(node)) {
      node[key] = restoreSharing(context, node[key], base?.[key]);
    }
  }
  return hasSameEntries(node, base) ? base : node;
}
