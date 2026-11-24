import { fileURLToPath } from "node:url";
import { defineConfig } from "rolldown";
import immutaby from "../src/index.ts";

// Production settings: no freezing (immer's auto-freeze is disabled in the
// benchmark too).
export default defineConfig({
  input: "bench/updates.ts",
  platform: "node",
  external: ["immer", "tinybench"],
  output: { dir: "bench/dist" },
  plugins: [
    immutaby({
      runtime: fileURLToPath(
        new URL("../src/runtime/index.ts", import.meta.url),
      ),
      freeze: "never",
      opaqueCalls: "allow",
    }),
  ],
});
