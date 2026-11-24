import { isObject, shallowCopy, type StateNode } from "./draftable.ts";
import type { Key, Path } from "./path.ts";

/**
 * State for one `mut:` block that uses helpers: the nodes copied within the
 * block, plus slots the generated code reads results from.
 */
export interface Context {
  copies: Set<object>;
  /** Result of the last helper, for writes used as expressions. */
  result: unknown;
  /** Value before a postfix `++` / `--`. */
  previousValue: unknown;
  /** Path of a compound assignment (`+=`), so its keys are evaluated once. */
  compoundPath: Path;
}

export function createContext(): Context {
  return { copies: new Set(), result: undefined, previousValue: undefined, compoundPath: [] };
}

/** The copy of `value` owned by this block, made at most once. Primitives and non-draftables pass through. */
export function ownedCopy(context: Context, value: StateNode): StateNode {
  if (!isObject(value) || context.copies.has(value)) return value;
  const copy = shallowCopy(value);
  if (copy !== value) context.copies.add(copy);
  return copy;
}

/**
 * Copies the nodes along the first `depth` keys of `path` below `root` (which
 * must already be owned), linking each copy into its parent. Returns the owned
 * node at that depth. The path must already be resolved by `readPath`.
 */
export function copyAlongPath(context: Context, root: StateNode, path: Path, depth: number): StateNode {
  let node = root;
  for (let i = 0; i < depth; i++) {
    const key = path[i] as Key;
    const child = node[key];
    const copy = ownedCopy(context, child);
    if (copy !== child) node[key] = copy;
    node = copy;
  }
  return node;
}
