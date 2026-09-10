// Offline CLI stub: no provider calls, no installed Codex, no home reads/writes.
//
// The same app-server wire as `future-codex-cli.mjs`, plus the shapes a CLI
// release actually arrives in:
//   default              non-protocol output on stdout (banner, blank line,
//                        upgrade notice) around the protocol frames
//   UAW_TEST_CODEX_REJECT the runtime refuses something the workbench wrote and
//                        explains itself on stderr before exiting, the way
//                        0.153-alpha refused `wire_api = "chat"`
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.UAW_TEST_CODEX_VERSION}\n`);
} else if (process.argv.includes("app-server") && process.argv.includes("--stdio")) {
  if (process.env.UAW_TEST_CODEX_REJECT === "1") {
    process.stderr.write("error: `model_context_window` is no longer supported in config.toml\n");
    process.exit(1);
  }
  process.stdout.write("\u001b[1mA new version of codex is available (9999.0.0).\u001b[0m\n");
  process.stdout.write("\n");
  const frames = (await readFile(new URL("./kimi-responses-turn.jsonl", import.meta.url), "utf8"))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  let offset = 0;
  let first = true;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    while (offset < frames.length) {
      const frame = frames[offset];
      if (frame.id !== undefined && frame.id !== request.id) break;
      offset += 1;
      const prefix = first ? "\ufeff" : "";
      first = false;
      process.stdout.write(`${prefix}${JSON.stringify(frame)}\n`);
      process.stdout.write("run `codex upgrade` to update\n");
    }
  }
} else {
  process.exitCode = 2;
}
