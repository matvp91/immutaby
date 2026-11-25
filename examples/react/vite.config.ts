import { vite as immutaby } from "immutaby";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [immutaby()],
  // Unminified, so the compiled `mut:` blocks are easy to read in dist/.
  build: { minify: false },
});
