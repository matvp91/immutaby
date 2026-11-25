import { createUnplugin } from "unplugin";
import { MutError } from "./compiler/errors.ts";
import { MAY_CONTAIN_MUT_BLOCK, transform } from "./compiler/transform.ts";
import type { Options } from "./options.ts";

export { MutError, type Warning } from "./compiler/errors.ts";
export { type TransformResult, transform } from "./compiler/transform.ts";
export type { Options } from "./options.ts";
export { immerable } from "./runtime/draft.ts";

const SCRIPT_MODULE = /\.[cm]?[jt]sx?(?:$|\?)/;

/**
 * Compiles `mut: { ... }` blocks into copy-on-write updates, as a plugin for
 * each bundler unplugin supports.
 */
const immutaby = createUnplugin((options: Options | undefined) => ({
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
          this.warn({
            message: warning.message,
            loc: locate(code, warning.pos, id),
          });
        }
        return { code: result.code, map: result.map };
      } catch (error) {
        if (error instanceof MutError) {
          // Rollup-style bundlers throw here; others (esbuild, webpack)
          // collect the error and fail the build after the hook returns.
          this.error({
            message: error.message,
            loc: locate(code, error.pos, id),
          });
          return null;
        }
        throw error;
      }
    },
  },
}));

export const {
  bun,
  esbuild,
  farm,
  rolldown,
  rollup,
  rsbuild,
  rspack,
  unloader,
  vite,
  webpack,
} = immutaby;

// 1-based line, 0-based column, as bundlers report them.
function locate(code: string, pos: number, file: string) {
  const before = code.slice(0, pos);
  const line = before.split("\n").length;
  const column = pos - (before.lastIndexOf("\n") + 1);
  return { line, column, file };
}
