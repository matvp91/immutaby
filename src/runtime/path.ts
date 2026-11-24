import type { StateNode } from "./draftable.ts";

/**
 * A path segment resolved at runtime: `s.todos.find(p)` becomes the index of
 * the first (or last) element matching `p`.
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
export type Path = (Key | FindIndexKey)[];

export function findIndexKey(method: FindIndexKey["method"], predicate: FindIndexKey["predicate"]): FindIndexKey {
  return new FindIndexKey(method, predicate);
}

/**
 * Reads `root` at `path` (or at its first `depth` keys). `FindIndexKey`
 * segments are replaced in `path` by the index they resolve to, so later
 * walks over the same path see plain keys.
 */
export function readPath(root: StateNode, path: Path, depth = path.length): StateNode {
  let node = root;
  for (let i = 0; i < depth; i++) {
    const segment = path[i];
    const key = segment instanceof FindIndexKey ? (path[i] = node[segment.method](segment.predicate) as number) : segment;
    node = node[key];
  }
  return node;
}

/** Resolves the `FindIndexKey` segments of `path` once, so it can be held by an alias. */
export function resolvePath(path: Path, root: StateNode): Path {
  readPath(root, path);
  return path;
}
