/* Parent-owned launcher for the Worker 406 contact-sheet renderer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;
const driverPath = fileURLToPath(new URL("./phosphor-contact-sheet.mjs", import.meta.url));
const stage = await mkdtemp(join(tmpdir(), "uaw-worker-406-contact-sheet-"));

try {
  const child = spawn(
    electronBinary,
    [driverPath, `--user-data-dir=${join(stage, "user-data")}`],
    {
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        UAW_CONTACT_STAGE: stage,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
    },
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode ?? -1));
  });
  assert.equal(code, 0, `contact-sheet Electron driver exited ${code}`);
} finally {
  await rm(stage, { recursive: true, force: true, maxRetries: 5 });
}
