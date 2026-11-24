/** What the compiler knows about built-in methods and functions. */

/** Methods that mutate their receiver: array mutators, and Map/Set mutators. */
const MUTATING_METHODS = new Set([
  ...["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"],
  ...["set", "add", "delete", "clear"],
]);

/** Array methods that call a callback with each element, synchronously. */
const ITERATION_METHODS = new Set(["forEach", "map", "filter", "find", "findLast", "findIndex", "findLastIndex", "some", "every", "flatMap", "reduce", "reduceRight"]);

/** `find`-like methods, and the method that gives the index of the same element. */
const FIND_INDEX_METHODS = new Map([
  ["find", "findIndex"],
  ["findLast", "findLastIndex"],
]);

/** Methods that don't change their receiver (on arrays, strings, numbers, Map/Set, dates and objects). */
const READ_ONLY_METHODS = new Set([
  ...["at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap", "forEach", "includes"],
  ...["indexOf", "join", "keys", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "values", "toReversed", "toSorted", "toSpliced", "with"],
  ...["charAt", "charCodeAt", "codePointAt", "endsWith", "localeCompare", "match", "matchAll", "normalize", "padEnd", "padStart", "repeat"],
  ...["replace", "replaceAll", "search", "split", "startsWith", "substring", "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase"],
  ...["trim", "trimEnd", "trimStart", "toFixed", "toPrecision", "toExponential", "get", "has", "getTime", "toISOString", "toJSON"],
  ...["hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "valueOf", "toString", "toLocaleString"],
]);

/** Global functions that don't change their arguments. */
const READ_ONLY_GLOBAL_CALLS = new Set([
  ...["String", "Number", "Boolean", "BigInt", "Symbol", "isNaN", "isFinite", "parseInt", "parseFloat", "structuredClone"],
  ...["JSON.stringify", "Object.keys", "Object.values", "Object.entries", "Object.is", "Object.hasOwn", "Object.getPrototypeOf", "Object.isFrozen"],
  ...["Array.isArray", "Array.from", "Array.of", "Number.isInteger", "Number.isFinite", "Number.isNaN", "Number.isSafeInteger"],
]);

/** Global namespaces whose functions don't change their arguments. */
const READ_ONLY_GLOBAL_NAMESPACES = new Set(["console", "Math"]);

export const isMutatingMethod = (name: string): boolean => MUTATING_METHODS.has(name);
export const isIterationMethod = (name: string): boolean => ITERATION_METHODS.has(name);
export const isReadOnlyMethod = (name: string): boolean => READ_ONLY_METHODS.has(name);
export const findIndexMethodFor = (name: string): string | undefined => FIND_INDEX_METHODS.get(name);

/** Position of the element parameter in an iteration callback (`reduce` passes the accumulator first). */
export const elementParamIndex = (method: string): number => (method.startsWith("reduce") ? 1 : 0);

/** Whether the global function `dottedName` (e.g. "JSON.stringify") doesn't change its arguments. */
export function isReadOnlyGlobalCall(dottedName: string): boolean {
  return READ_ONLY_GLOBAL_CALLS.has(dottedName) || READ_ONLY_GLOBAL_NAMESPACES.has(dottedName.split(".")[0]);
}
