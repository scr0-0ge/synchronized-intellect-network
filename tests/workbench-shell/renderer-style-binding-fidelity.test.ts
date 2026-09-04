import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/* The renderer ships `style-src 'self'` with no `'unsafe-inline'`
   (src/workbench-shell/renderer/index.html). Under that policy a style
   ATTRIBUTE — which is exactly what a string-form `style={"..."}` binding
   compiles to — is refused at parse time, so every custom property it carries
   silently falls back to its `var()` default. That is F213: the context ring
   read `var(--ctx-used, 0)` and sat pinned at zero while the number flowed
   correctly underneath. Object-form `style={{ ... }}` bindings are applied as
   CSSOM property sets, which `style-src` does not govern, so they are the only
   form that survives the shipped CSP. */

const rendererRoot = fileURLToPath(
  new URL("../../src/workbench-shell/renderer/", import.meta.url),
);

async function rendererSources(): Promise<ReadonlyArray<readonly [string, string]>> {
  const entries = await readdir(rendererRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")),
    )
    .map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.length > 0, "renderer sources must be discoverable");
  return Promise.all(
    files.map(
      async (file) => [file, await readFile(file, "utf8")] as const,
    ),
  );
}

test("the shipped CSP still refuses inline style attributes", async () => {
  const indexHtml = await readFile(join(rendererRoot, "index.html"), "utf8");
  assert.match(indexHtml, /style-src 'self'/u);
  assert.doesNotMatch(indexHtml, /style-src[^;]*unsafe-inline/u);
});

test("no renderer style binding uses the string form the CSP discards", async () => {
  for (const [file, source] of await rendererSources()) {
    assert.doesNotMatch(
      source,
      /style=\{\s*["'`]/u,
      `${file} binds style as a string; the CSP refuses the resulting attribute, so bind the object form instead`,
    );
  }
});

test("the context ring drives --ctx-used through the object form", async () => {
  const composerSource = await readFile(
    join(rendererRoot, "composer.tsx"),
    "utf8",
  );
  assert.match(
    composerSource,
    /style=\{\{\s*"--ctx-used":/u,
    "the ring must set --ctx-used as an object-form custom property",
  );
});
