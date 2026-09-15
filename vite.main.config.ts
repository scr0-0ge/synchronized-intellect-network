import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve("dist/main"),
    emptyOutDir: true,
    target: "node22",
    // Two SSR entries: the Electron main bundle and the standalone MCP
    // bootstrap the CLIs spawn (`workbench` stdio server). Named entries keep
    // `dist/main/main.js` byte-stable for the launcher and packaging stage.
    ssr: true,
    rollupOptions: {
      external: ["electron"],
      input: {
        main: resolve("src/workbench-shell/electron/main.ts"),
        "auto-iteration-mcp-bootstrap": resolve(
          "src/workbench-shell/auto-iteration-mcp-bootstrap.ts",
        ),
      },
      output: { entryFileNames: "[name].js" },
    },
  },
});
