import { resolve } from "node:path";

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: resolve("src/workbench-shell/renderer"),
  base: "./",
  plugins: [solid()],
  build: {
    outDir: resolve("dist/renderer"),
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
  },
});
