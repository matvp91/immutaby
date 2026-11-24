import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import immutaby from "./src/index.ts";

export default defineConfig({
  // Test files contain `mut:` blocks themselves, compiled by the plugin under test.
  plugins: [immutaby({ runtime: fileURLToPath(new URL("./src/runtime.ts", import.meta.url)), opaqueCalls: "allow" })],
  test: { include: ["test/**/*.test.ts"] },
});
