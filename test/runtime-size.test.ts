import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";
import { expect, it } from "vitest";

it("keeps the whole runtime under 2 KB minified and gzipped", async () => {
  const bundle = await rolldown({ input: new URL("../src/runtime/index.ts", import.meta.url).pathname, logLevel: "silent" });
  const { output } = await bundle.generate({ format: "esm", minify: true });
  expect(gzipSync(output[0].code).length).toBeLessThan(2048);
});
