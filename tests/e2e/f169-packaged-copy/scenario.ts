import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { ElectronApplication, Page } from "playwright";

import { expectedCode } from "./fixture.ts";

const clipboardSentinel = "F169_CLIPBOARD_UNCHANGED_7c4d81";

export interface ClipboardRestoreState {
  originalClipboardText: string | undefined;
  clipboardWasPrimed: boolean;
}

export async function inspectPackagedCopy(
  application: ElectronApplication,
  page: Page,
  expectedRendererUrl: string,
  clipboardRestoreState: ClipboardRestoreState,
): Promise<Record<string, unknown>> {
  await page.locator(".app").waitFor({ state: "visible", timeout: 10_000 });
  const code = page.locator(".codeblock code");
  await code.waitFor({ state: "visible", timeout: 10_000 });
  const renderedCode = (await code.textContent()) ?? "";

  clipboardRestoreState.originalClipboardText = await application.evaluate(
    ({ clipboard }) => clipboard.readText(),
  );
  await application.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, clipboardSentinel);
  clipboardRestoreState.clipboardWasPrimed = true;
  const clipboardBeforeClick = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );

  const navigatorClipboard = await page.evaluate(() => ({
    clipboardType: typeof navigator.clipboard,
    writeTextType: typeof navigator.clipboard?.writeText,
  }));
  const copy = page.getByRole("button", { name: "Copy code", exact: true });
  await copy.click();
  await page.waitForFunction(() => {
    const label = document.querySelector(".codeblock-copy span")?.textContent;
    return label === "Copied" || label === "Copy failed";
  });
  const feedback = (await page.locator(".codeblock-copy span").textContent()) ?? "";
  const clipboardAfterClick = await application.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );

  const observation = {
    rendererUrl: page.url(),
    rendererProtocol: new URL(page.url()).protocol,
    navigatorClipboard,
    renderedCodeExact: renderedCode === expectedCode,
    renderedUtf8Bytes: Buffer.byteLength(renderedCode, "utf8"),
    renderedSha256: sha256(renderedCode),
    clipboardPrimed: clipboardBeforeClick === clipboardSentinel,
    feedback,
    clipboardExact: clipboardAfterClick === expectedCode,
    clipboardUnchanged: clipboardAfterClick === clipboardSentinel,
    clipboardUtf8Bytes: Buffer.byteLength(clipboardAfterClick, "utf8"),
    clipboardSha256: sha256(clipboardAfterClick),
    expectedUtf8Bytes: Buffer.byteLength(expectedCode, "utf8"),
    expectedSha256: sha256(expectedCode),
  };
  const serializedObservation = JSON.stringify(observation);
  console.log(`F169_PACKAGED_COPY_OBSERVATION ${serializedObservation}`);
  console.log(
    `F169_PACKAGED_COPY_OBSERVATION_SHA256 ${sha256(serializedObservation)}`,
  );

  assert.deepEqual(observation, {
    rendererUrl: expectedRendererUrl,
    rendererProtocol: "file:",
    navigatorClipboard: {
      clipboardType: navigatorClipboard.clipboardType,
      writeTextType: navigatorClipboard.writeTextType,
    },
    renderedCodeExact: true,
    renderedUtf8Bytes: Buffer.byteLength(expectedCode, "utf8"),
    renderedSha256: sha256(expectedCode),
    clipboardPrimed: true,
    feedback: "Copied",
    clipboardExact: true,
    clipboardUnchanged: false,
    clipboardUtf8Bytes: Buffer.byteLength(expectedCode, "utf8"),
    clipboardSha256: sha256(expectedCode),
    expectedUtf8Bytes: Buffer.byteLength(expectedCode, "utf8"),
    expectedSha256: sha256(expectedCode),
  });
  return observation;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
