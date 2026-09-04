import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createServer,
  type InlineConfig,
  type ViteDevServer,
} from "vite";

import { removeTestDirectory } from "./test-lifecycle.ts";

export function createViteSsrTestServer(
  config: InlineConfig,
): Promise<ViteDevServer> {
  return createIsolatedViteTestServer({
    ...config,
    optimizeDeps: {
      ...config.optimizeDeps,
      noDiscovery: true,
    },
  });
}

export function createViteBrowserTestServer(
  config: InlineConfig,
): Promise<ViteDevServer> {
  return createIsolatedViteTestServer(config);
}

async function createIsolatedViteTestServer(
  config: InlineConfig,
): Promise<ViteDevServer> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "uaw-vite-test-"));
  let server: ViteDevServer;
  try {
    server = await createServer({
      ...config,
      cacheDir: join(cacheRoot, "cache"),
    });
  } catch (error) {
    await removeAfterFailure(cacheRoot, error);
  }

  const closeUnderlyingServer = server!.close.bind(server!);
  let closeResult: Promise<void> | undefined;
  server!.close = (): Promise<void> => {
    closeResult ??= closeServerAndCache(closeUnderlyingServer, cacheRoot);
    return closeResult;
  };
  return server!;
}

async function closeServerAndCache(
  closeServer: () => Promise<void>,
  cacheRoot: string,
): Promise<void> {
  let closeError: unknown;
  try {
    await closeServer();
  } catch (error) {
    closeError = error;
  }

  try {
    await removeTestDirectory(cacheRoot);
  } catch (removeError) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [closeError, removeError],
        "Vite server close and cache cleanup both failed.",
      );
    }
    throw removeError;
  }

  if (closeError !== undefined) throw closeError;
}

async function removeAfterFailure(
  cacheRoot: string,
  creationError: unknown,
): Promise<never> {
  try {
    await removeTestDirectory(cacheRoot);
  } catch (removeError) {
    throw new AggregateError(
      [creationError, removeError],
      "Vite server creation and cache cleanup both failed.",
    );
  }
  throw creationError;
}
