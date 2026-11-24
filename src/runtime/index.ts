// Helpers called by compiled `mut:` blocks. The `__imm_` prefix marks them as
// generated-code imports; keep this list in sync with `RUNTIME_HELPERS` in
// compiler/codegen.ts.
export {
  createContext as __imm_createContext,
  freeze as __imm_freeze,
  shallowCopy as __imm_shallowCopy,
} from "./draft.ts";
export {
  lend as __imm_lend,
  restoreSharing as __imm_restoreSharing,
} from "./lending.ts";
export {
  assertArray as __imm_assertArray,
  callMethod as __imm_callMethod,
  elements as __imm_elements,
  findIndexKey as __imm_findIndexKey,
  increment as __imm_increment,
  isUnchanged as __imm_isUnchanged,
  iterate as __imm_iterate,
  read as __imm_read,
  remove as __imm_remove,
  resolve as __imm_resolve,
  write as __imm_write,
} from "./path.ts";
