import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NODE_ARCHIVE_NAME, NODE_LTS_VERSION } from "../../src/agent-runtime/node-provisioning.ts";

// A fake nodejs.org: the exact archive shape the official dist publishes
// (a top-level `node-v<LTS>-win-x64/` directory), plus the SHASUMS256.txt
// beside it, served over a loopback HTTP endpoint so a full provisioning run
// exercises the REAL download/verify/extract/read-back code with zero
// network. The zip-building technique is the one tests/launcher/start.test.mjs
// already uses against start.bat's provisioning, so both sides of the cache
// are tested the same way.

const nodePackageName = `node-v${NODE_LTS_VERSION}-win-x64`;
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? String.raw`C:\Windows`;
const powershellExecutable = join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/** Zip bytes are expensive to build (~80 MB of real node.exe); build once per variant. */
const archiveBytesByVariant = new Map<string, Buffer>();

export interface PrivateNodeDownloadFixture {
  readonly root: string;
  readonly downloadRoot: string;
  readonly requests: () => number;
  /** Rewrites SHASUMS256.txt so the archive no longer matches it. */
  corruptShasums(): Promise<void>;
}

export interface PrivateNodeDownloadFixtureOptions {
  /**
   * `real` zips this process's own node.exe (a working node, so the read-back
   * really runs); `broken` zips a file that cannot execute. `real` additionally
   * lays down npm's cli shim beside it, the way the official archive does.
   */
  readonly variant?: "real" | "broken";
  /** Extra files inside the package directory, relative to it. */
  readonly extraFiles?: readonly { readonly relativePath: string; readonly contents: string }[];
}

export async function createPrivateNodeDownloadFixture(
  register: (teardown: () => void) => void,
  options: PrivateNodeDownloadFixtureOptions = {},
): Promise<PrivateNodeDownloadFixture> {
  const variant = options.variant ?? "real";
  const root = await realpath(await mkdtemp(join(tmpdir(), "uaw-node-dist-")));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });

  const packageRoot = join(root, nodePackageName);
  await mkdir(packageRoot, { recursive: true });
  if (variant === "real") {
    await copyFile(process.execPath, join(packageRoot, "node.exe"));
    await mkdir(join(packageRoot, "node_modules", "npm", "bin"), { recursive: true });
    await writeFile(join(packageRoot, "node_modules", "npm", "bin", "npm-cli.js"), "// npm\n");
  } else {
    await writeFile(join(packageRoot, "node.exe"), "not an executable\n");
  }
  for (const extra of options.extraFiles ?? []) {
    const destination = join(packageRoot, ...extra.relativePath.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, extra.contents);
  }

  const archive = join(root, NODE_ARCHIVE_NAME);
  let bytes = archiveBytesByVariant.get(variant);
  if (bytes === undefined) {
    const zipped = spawnSync(
      powershellExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          "[System.IO.Compression.ZipFile]::CreateFromDirectory(" +
          "$env:SIN_TEST_PACKAGE, $env:SIN_TEST_ARCHIVE, " +
          "[System.IO.Compression.CompressionLevel]::Optimal, $true)",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SIN_TEST_PACKAGE: packageRoot, SIN_TEST_ARCHIVE: archive },
        windowsHide: true,
      },
    );
    if (zipped.status !== 0) {
      throw new Error(`fixture zip build failed: ${zipped.stderr}\n${zipped.stdout}`);
    }
    bytes = await readFile(archive);
    archiveBytesByVariant.set(variant, bytes);
  } else {
    await writeFile(archive, bytes);
  }

  const shasumsPath = join(root, "SHASUMS256.txt");
  await writeFile(
    shasumsPath,
    `${createHash("sha256").update(bytes).digest("hex")}  ${NODE_ARCHIVE_NAME}\n`,
  );

  const served = new Map<string, Buffer>([
    [`/${NODE_ARCHIVE_NAME}`, bytes],
    ["/SHASUMS256.txt", await readFile(shasumsPath)],
  ]);
  let requests = 0;
  const server: Server = createServer((request, response) => {
    requests += 1;
    const body = served.get(request.url ?? "");
    if (body === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-length", String(body.byteLength));
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  register(() => {
    // Every server, not just the listener: a live connection keeps the port
    // held after close and the next fixture silently fails on EADDRINUSE.
    server.closeAllConnections?.();
    server.close();
  });

  return {
    root,
    downloadRoot: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    async corruptShasums(): Promise<void> {
      await writeFile(shasumsPath, `${"0".repeat(64)}  ${NODE_ARCHIVE_NAME}\n`);
      served.set("/SHASUMS256.txt", await readFile(shasumsPath));
    },
  };
}

/** A URL whose connection is refused, for the offline failure shape. */
export const unreachableDownloadRoot = "http://127.0.0.1:9";
