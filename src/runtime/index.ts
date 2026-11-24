/**
 * `immutaby/runtime`: the helpers generated code imports, under flat names so
 * bundlers keep only the ones a module uses.
 */
export { createContext, freeze as deepFreeze, immerable, shallowCopy, type Context } from "./draft.ts";
export { lend as lendDeepCopy, restoreSharing } from "./lending.ts";
export {
  assertArray,
  callMethod as callMethodAtPath,
  elements as elementPaths,
  findIndexKey,
  increment as incrementPath,
  isUnchanged,
  iterate as iterateWithPaths,
  read as readPath,
  remove as deletePath,
  resolve as resolvePath,
  write as writePath,
} from "./path.ts";
