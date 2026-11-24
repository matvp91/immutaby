import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import immutaby, { type Options } from "./src/index.ts";

const runtime = fileURLToPath(new URL("./src/runtime/index.ts", import.meta.url));

// Test files contain `mut:` blocks themselves, compiled by the plugin under test.
// The suite runs twice: with inline writes, and with helper calls only.
const project = (name: string, options: Options) => ({
  plugins: [immutaby({ runtime, opaqueCalls: "allow", ...options })],
  test: { name, include: ["test/**/*.test.ts"] },
});

export default defineConfig({
  test: { projects: [project("inline", {}), project("helpers", { inline: false })] },
});
