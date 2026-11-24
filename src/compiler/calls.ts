const words = (list: string): string[] => list.trim().split(/\s+/);

// Array, Map and Set mutators.
const MUTATING_METHODS = new Set(
  words(`
    push pop shift unshift splice sort reverse fill copyWithin set add delete
    clear
  `),
);

// Array methods that call their callback synchronously, once per element.
const ITERATION_METHODS = new Set(
  words(`
    forEach map filter find findLast findIndex findLastIndex some every flatMap
    reduce reduceRight
  `),
);

// A `find`-like method → the method giving the index of the same element.
const FIND_INDEX_METHODS = new Map([
  ["find", "findIndex"],
  ["findLast", "findLastIndex"],
]);

// On arrays, strings, numbers, Map/Set, dates and plain objects.
const READ_ONLY_METHODS = new Set(
  words(`
    at concat entries every filter find findIndex findLast findLastIndex flat
    flatMap forEach includes indexOf join keys lastIndexOf map reduce
    reduceRight slice some values toReversed toSorted toSpliced with charAt
    charCodeAt codePointAt endsWith localeCompare match matchAll normalize
    padEnd padStart repeat replace replaceAll search split startsWith substring
    toLowerCase toUpperCase toLocaleLowerCase toLocaleUpperCase trim trimEnd
    trimStart toFixed toPrecision toExponential get has getTime toISOString
    toJSON hasOwnProperty isPrototypeOf propertyIsEnumerable valueOf toString
    toLocaleString
  `),
);

const READ_ONLY_GLOBALS = new Set(
  words(`
    String Number Boolean BigInt Symbol isNaN isFinite parseInt parseFloat
    structuredClone JSON.stringify Object.keys Object.values Object.entries
    Object.is Object.hasOwn Object.getPrototypeOf Object.isFrozen Array.isArray
    Array.from Array.of Number.isInteger Number.isFinite Number.isNaN
    Number.isSafeInteger
  `),
);

const READ_ONLY_GLOBAL_NAMESPACES = new Set(["console", "Math"]);

/**
 * Whether `method` mutates its receiver (array, Map and Set mutators).
 */
export const isMutating = (method: string): boolean =>
  MUTATING_METHODS.has(method);

/**
 * Whether `method` is an array method that calls its callback synchronously for
 * each element.
 */
export const isIteration = (method: string): boolean =>
  ITERATION_METHODS.has(method);

/**
 * Whether `method` never changes its receiver.
 */
export const isReadOnly = (method: string): boolean =>
  READ_ONLY_METHODS.has(method);

/**
 * For `find` / `findLast`, the method that gives the index of the same element.
 */
export const findIndexFor = (method: string): string | undefined =>
  FIND_INDEX_METHODS.get(method);

/**
 * Position of the element parameter in an iteration callback (`reduce` passes
 * the accumulator first).
 */
export const elementIndex = (method: string): number =>
  method.startsWith("reduce") ? 1 : 0;

/**
 * Whether the global function `name` (e.g. "JSON.stringify") doesn't change its
 * arguments.
 */
export function isReadOnlyGlobal(name: string): boolean {
  return (
    READ_ONLY_GLOBALS.has(name) ||
    READ_ONLY_GLOBAL_NAMESPACES.has(name.split(".")[0])
  );
}
