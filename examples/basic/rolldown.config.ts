import immutaby from "immutaby";
import { defineConfig } from "rolldown";

export default defineConfig({
  input: "examples/basic/index.ts",
  output: { dir: "examples/basic/dist" },
  plugins: [immutaby()],
});
