import type { Plugin } from "rolldown";
import { MutError } from "./compiler/errors.ts";
import { MAY_CONTAIN_MUT_BLOCK, transform } from "./compiler/transform.ts";
import type * as Options from "./options.ts";

export { MutError, type Warning } from "./compiler/errors.ts";
export { type TransformResult, transform } from "./compiler/transform.ts";
export type { Input as Options } from "./options.ts";
export { immerable } from "./runtime/index.ts";

const SCRIPT_MODULE = /\.[cm]?[jt]sx?(?:$|\?)/;

/** Rolldown plugin: compiles `mut: { ... }` blocks into copy-on-write updates. */
export default function immutaby(options: Options.Input = {}): Plugin {
  return {
    name: "immutaby",
    transform: {
      filter: { id: SCRIPT_MODULE, code: MAY_CONTAIN_MUT_BLOCK },
      handler(code, id) {
        try {
          const result = transform(code, id, options);
          if (!result) {
            return null;
          }
          for (const warning of result.warnings) {
            this.warn(warning.message, warning.pos);
          }
          return { code: result.code, map: result.map };
        } catch (error) {
          if (error instanceof MutError) {
            this.error(error.message, error.pos);
          }
          throw error;
        }
      },
    },
  };
}
