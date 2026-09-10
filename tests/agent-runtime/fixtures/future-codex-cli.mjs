// Offline CLI stub: no provider calls, no installed Codex, no home reads/writes.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.UAW_TEST_CODEX_VERSION}\n`);
} else if (process.argv.includes("app-server") && process.argv.includes("--stdio")) {
  const frames = (await readFile(new URL("./kimi-responses-turn.jsonl", import.meta.url), "utf8"))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  let offset = 0;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    while (offset < frames.length) {
      const frame = frames[offset];
      if (frame.id !== undefined && frame.id !== request.id) break;
      offset += 1;
      if (frame.result?.thread) frame.result.thread.cliVersion = process.env.UAW_TEST_CODEX_VERSION;
      if (frame.params?.thread) frame.params.thread.cliVersion = process.env.UAW_TEST_CODEX_VERSION;
      frame.futureField = { private: "UNCONSUMED_VENDOR_CANARY" };
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    }
  }
} else {
  process.exitCode = 2;
}
