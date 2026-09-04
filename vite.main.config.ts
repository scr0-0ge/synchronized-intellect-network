import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve("dist/main"),
    emptyOutDir: true,
    target: "node22",
    ssr: resolve("src/workbench-shell/electron/main.ts"),
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "main.js" },
    },
  },
});
