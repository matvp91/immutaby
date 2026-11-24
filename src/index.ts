import type { Plugin } from "rolldown";
import { MutError, transform, type Options } from "./transform.ts";

export type { Options };
export { immerable } from "./runtime.ts";

/** Rolldown plugin: compiles `mut: { ... }` blocks into copy-on-write updates. */
export default function immutaby(options: Options = {}): Plugin {
  return {
    name: "immutaby",
    transform: {
      filter: { id: /\.[cm]?[jt]sx?(?:$|\?)/, code: /\bmut\s*:/ },
      handler(code, id) {
        try {
          return transform(code, id, options);
        } catch (error) {
          if (error instanceof MutError) this.error(error.message, error.pos);
          throw error;
        }
      },
    },
  };
}
