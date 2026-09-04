import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const productionRendererIndex = new URL(
  "../../src/workbench-shell/renderer/index.html",
  import.meta.url,
);
const expectedProductionCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

test("the production renderer retains its exact strict CSP", async () => {
  await assertStrictProductionCsp(productionRendererIndex);
});

test("the production CSP guard rejects every named relaxation", async (context) => {
  const productionHtml = await readFile(productionRendererIndex, "utf8");
  const mutations = [
    {
      name: "script unsafe-inline",
      html: replaceExactlyOnce(
        productionHtml,
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ),
    },
    {
      name: "script unsafe-eval",
      html: replaceExactlyOnce(
        productionHtml,
        "script-src 'self'",
        "script-src 'self' 'unsafe-eval'",
      ),
    },
    {
      name: "style unsafe-inline",
      html: replaceExactlyOnce(
        productionHtml,
        "style-src 'self'",
        "style-src 'self' 'unsafe-inline'",
      ),
    },
    {
      name: "style unsafe-eval",
      html: replaceExactlyOnce(
        productionHtml,
        "style-src 'self'",
        "style-src 'self' 'unsafe-eval'",
      ),
    },
    {
      name: "connect-src",
      html: replaceExactlyOnce(
        productionHtml,
        "connect-src 'none'",
        "connect-src 'self'",
      ),
    },
    {
      name: "object-src",
      html: replaceExactlyOnce(
        productionHtml,
        "object-src 'none'",
        "object-src 'self'",
      ),
    },
    {
      name: "frame-ancestors",
      html: replaceExactlyOnce(
        productionHtml,
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    },
    {
      name: "frame-src",
      html: replaceExactlyOnce(
        productionHtml,
        "frame-ancestors 'none'",
        "frame-src 'self'; frame-ancestors 'none'",
      ),
    },
    {
      name: "base-uri",
      html: replaceExactlyOnce(
        productionHtml,
        "base-uri 'none'",
        "base-uri 'self'",
      ),
    },
    {
      name: "form-action",
      html: replaceExactlyOnce(
        productionHtml,
        "form-action 'none'",
        "form-action 'self'",
      ),
    },
  ] as const;
  const fixtureRoot = await mkdtemp(join(tmpdir(), "uaw-production-csp-"));

  try {
    for (const [index, mutation] of mutations.entries()) {
      await context.test(mutation.name, async () => {
        const fixturePath = join(fixtureRoot, `${index}.html`);
        await writeFile(fixturePath, mutation.html, "utf8");
        await assert.rejects(
          assertStrictProductionCsp(fixturePath),
          /production renderer CSP must remain exact/u,
        );
      });
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

async function assertStrictProductionCsp(path: string | URL): Promise<void> {
  const html = await readFile(path, "utf8");
  const metaTags = html.match(/<meta\b[^>]*>/giu) ?? [];
  const cspTags = metaTags.filter((tag) =>
    /\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/iu.test(tag),
  );
  assert.equal(
    cspTags.length,
    1,
    "production renderer must declare exactly one CSP meta tag",
  );

  const content = cspTags[0]?.match(/\bcontent\s*=\s*(["'])(.*?)\1/iu)?.[2];
  assert.ok(content, "production renderer CSP must have a content value");
  assert.equal(
    content.replace(/\s+/gu, " ").trim(),
    expectedProductionCsp,
    "production renderer CSP must remain exact",
  );
}

function replaceExactlyOnce(
  source: string,
  target: string,
  replacement: string,
): string {
  assert.equal(
    source.split(target).length - 1,
    1,
    `production fixture must contain exactly one ${target}`,
  );
  return source.replace(target, replacement);
}
