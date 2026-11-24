/** State is arbitrary user data; the runtime indexes into it dynamically. */
export type StateNode = any;

/** Classes marked with this symbol are copied like plain objects (the same symbol as immer's `immerable`). */
export const immerable: unique symbol = Symbol.for("immer-draftable") as never;

export function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Plain objects, arrays, Map, Set, null-prototype objects and classes marked `immerable`. */
export function isDraftable(value: object): boolean {
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || immerable in value || Boolean(proto.constructor?.[immerable]);
}

/**
 * A shallow copy of a draftable value, keeping its prototype. Other values are
 * returned as is: they are shared, and writes go straight through (as in immer).
 */
export function shallowCopy(value: StateNode): StateNode {
  if (Array.isArray(value)) return value.slice();
  if (value instanceof Map) return new Map(value);
  if (value instanceof Set) return new Set(value);
  if (Object.getPrototypeOf(value) === Object.prototype) return { ...value };
  if (isDraftable(value)) return Object.assign(Object.create(Object.getPrototypeOf(value)), value);
  return value;
}
