import { isDraftable, isObject } from "./draftable.ts";

function throwFrozen(): never {
  throw new TypeError("mut: this collection is frozen; change it inside a `mut:` block");
}

/**
 * Deep-freezes draftable values, stopping at values that are already frozen
 * (so after the first block only new nodes are visited). Map and Set get
 * throwing mutators, since `Object.freeze` doesn't stop `set`/`add`.
 */
export function deepFreeze<T>(value: T): T {
  if (!isObject(value) || Object.isFrozen(value) || !isDraftable(value)) return value;
  let children: Iterable<unknown> = Object.values(value);
  if (value instanceof Map || value instanceof Set) {
    for (const method of ["set", "add", "delete", "clear"]) if (method in value) Object.defineProperty(value, method, { value: throwFrozen });
    children = value.values();
  }
  Object.freeze(value);
  for (const child of children) deepFreeze(child);
  return value;
}
