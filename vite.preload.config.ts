import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve("dist/preload"),
    emptyOutDir: true,
    target: "node22",
    lib: {
      entry: resolve("src/workbench-shell/electron/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
});
