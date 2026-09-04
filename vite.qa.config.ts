import { resolve } from "node:path";

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: resolve("tests/workbench-shell/visual-harness"),
  base: "./",
  plugins: [solid()],
  build: {
    outDir: resolve("dist/qa"),
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
  preview: {
    host: "127.0.0.1",
    port: 4187,
    strictPort: true,
  },
});
