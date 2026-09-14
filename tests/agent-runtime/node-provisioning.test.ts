import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultPrivateNodeCacheRoot,
  ensurePrivateNode,
  NODE_DOWNLOAD_ROOT,
  NODE_LTS_VERSION,
} from "../../src/agent-runtime/node-provisioning.ts";
import {
  createPrivateNodeDownloadFixture,
  unreachableDownloadRoot,
} from "./private-node-download-fixture.ts";

// The packaged product provisions its own Node LTS runtime the way start.bat
// does -- same version constant, same SHASUMS256 verification, same private
// cache directory -- because a machine that only unzipped the release has no
// start.bat and no node. Every test here runs against the REAL download,
// checksum, extraction and read-back code; only the download source is a
// loopback HTTP endpoint, never nodejs.org.

const nodePackageName = `node-v${NODE_LTS_VERSION}-win-x64`;
const environment = { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA };

async function cacheRootFixture(
  register: (teardown: () => void) => void,
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uaw-node-cache-")));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  return root;
}

test("a cold cache provisions the private Node: download, verify, extract, read back", async (t) => {
  if (process.platform !== "win32") return;
  const cacheRoot = await cacheRootFixture((teardown) => t.after(teardown));
  const source = await createPrivateNodeDownloadFixture((teardown) => t.after(teardown));

  const outcome = await ensurePrivateNode({ cacheRoot, downloadRoot: source.downloadRoot, environment });

  assert.equal(outcome.kind, "ready");
  assert.ok(outcome.kind === "ready");
  assert.equal(outcome.source, "downloaded");
  assert.equal(outcome.executable, join(cacheRoot, "bin", "node.exe"));
  // The read-back ran the extracted binary, so it reports the node that is
  // actually on disk -- the same interpreter this test itself runs under.
  assert.equal(outcome.version, process.versions.node);
  assert.match(outcome.version, /^(2[3-9]|[3-9]\d)\./u);
  // The stage directory is gone; the cache holds only the published `bin`.
  assert.deepEqual(await readdir(cacheRoot), ["bin"]);
  // Both the archive and SHASUMS256.txt were fetched, each exactly once.
  assert.equal(source.requests(), 2);
});

test("a warm cache is used without touching the download source again", async (t) => {
  if (process.platform !== "win32") return;
  const cacheRoot = await cacheRootFixture((teardown) => t.after(teardown));
  const source = await createPrivateNodeDownloadFixture((teardown) => t.after(teardown));

  await ensurePrivateNode({ cacheRoot, downloadRoot: source.downloadRoot, environment });
  const again = await ensurePrivateNode({ cacheRoot, downloadRoot: source.downloadRoot, environment });

  assert.equal(again.kind, "ready");
  assert.ok(again.kind === "ready");
  assert.equal(again.source, "cached");
  assert.equal(again.version, process.versions.node);
  assert.equal(source.requests(), 2);
});

test("a checksum mismatch rejects the archive, publishes nothing, and says why", async (t) => {
  if (process.platform !== "win32") return;
  const cacheRoot = await cacheRootFixture((teardown) => t.after(teardown));
  const source = await createPrivateNodeDownloadFixture((teardown) => t.after(teardown));
  await source.corruptShasums();

  const outcome = await ensurePrivateNode({ cacheRoot, downloadRoot: source.downloadRoot, environment });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.reason, "checksum-mismatch");
  assert.match(outcome.detail, /SHA-256 .*did not match/u);
  assert.match(outcome.detail, /https:\/\/nodejs\.org\/dist\/v24\.20\.0\/SHASUMS256\.txt/u);
  // Nothing was published and no stage directory was left behind.
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("an archive whose node.exe does not run is rejected after extraction", async (t) => {
  if (process.platform !== "win32") return;
  const cacheRoot = await cacheRootFixture((teardown) => t.after(teardown));
  const source = await createPrivateNodeDownloadFixture((teardown) => t.after(teardown), {
    variant: "broken",
  });

  const outcome = await ensurePrivateNode({ cacheRoot, downloadRoot: source.downloadRoot, environment });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.reason, "extracted-node-invalid");
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("an unreachable download source fails with the reason and the manual address", async (t) => {
  if (process.platform !== "win32") return;
  const cacheRoot = await cacheRootFixture((teardown) => t.after(teardown));

  const outcome = await ensurePrivateNode({ cacheRoot, downloadRoot: unreachableDownloadRoot, environment });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.reason, "archive-download-failed");
  assert.match(outcome.detail, /could not be downloaded/u);
  assert.match(outcome.detail, /https:\/\/nodejs\.org\/dist\/v24\.20\.0\/node-v24\.20\.0-win-x64\.zip/u);
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("the version constant and cache directory are start.bat's, so both paths share one Node", async () => {
  const start = await readFile("start.bat", "utf8");
  // Both files must move together: a start.bat that bumps its LTS without the
  // packaged provisioner following leaves two Nodes in one cache directory.
  assert.match(start, /set "NODE_LTS_VERSION=24\.20\.0"/u);
  assert.equal(NODE_LTS_VERSION, "24.20.0");
  assert.equal(NODE_DOWNLOAD_ROOT, "https://nodejs.org/dist/v24.20.0");
  assert.match(start, /NODE_CACHE_ROOT=%LOCALAPPDATA%\\synchronized-intellect-network\\runtime\\node/u);
  assert.equal(
    defaultPrivateNodeCacheRoot({ LOCALAPPDATA: String.raw`C:\Users\someone\AppData\Local` }),
    join(String.raw`C:\Users\someone\AppData\Local`, "synchronized-intellect-network", "runtime", "node"),
  );
});
