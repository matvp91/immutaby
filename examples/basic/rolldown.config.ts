import { defineConfig } from "rolldown";
import immutaby from "immutaby";

export default defineConfig({
  input: "examples/basic/index.ts",
  output: { dir: "examples/basic/dist" },
  plugins: [immutaby()],
});
