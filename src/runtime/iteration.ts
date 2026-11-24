/** Helpers for iterating state where the loop body writes through the element. */
import type { StateNode } from "./draftable.ts";
import { readPath, type Path } from "./path.ts";

/** Compiled `for...of` loops over state are index loops, which only work on arrays. */
export function assertArray(value: unknown, loop = "for...of"): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`mut: ${loop} over state supports arrays only`);
}

/** `for (const item of root.path)` where keys aren't static: yields the path of each element. */
export function* elementPaths(getRoot: () => StateNode, path: Path): Generator<Path> {
  assertArray(readPath(getRoot(), path));
  for (let i = 0; i < readPath(getRoot(), path).length; i++) yield [...path, i];
}

/**
 * `root.path.method(callback, ...rest)` where keys aren't static and the
 * callback writes through its element: the callback receives element paths.
 */
export function iterateWithPaths(path: Path, method: string, args: unknown[], root: StateNode): unknown {
  const list = readPath(root, path);
  assertArray(list, method);
  const [callback, ...rest] = args as [(...callbackArgs: unknown[]) => unknown, ...unknown[]];
  const elementPath = (index: number): Path => [...path, index];
  const withPaths =
    method === "reduce" || method === "reduceRight"
      ? (accumulator: unknown, _element: unknown, index: number, array: unknown) => callback(accumulator, elementPath(index), index, array)
      : (_element: unknown, index: number, array: unknown) => callback(elementPath(index), index, array);
  return (list as StateNode)[method](withPaths, ...rest);
}
