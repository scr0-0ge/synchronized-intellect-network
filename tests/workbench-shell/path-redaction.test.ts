import assert from "node:assert/strict";
import test from "node:test";

import { redactFilesystemPaths } from "../../src/workbench-shell/path-redaction.ts";

/* Both directions are load-bearing. The survive rows are F222: comment and URL
   shapes the old fourth rule ate, rendering `// comments` as the literal token
   `[path]`. The redact rows are the privacy boundary itself: transcripts and
   evidence must carry no raw filesystem path, in prose and inside code blocks,
   and a rule change that stops redacting them is a worse defect than F222. */

const mustSurvive: readonly string[] = [
  "// a line comment",
  "//TODO: fix this before release",
  "code(); // trailing comment",
  "/* a block comment */",
  "end of block */ then prose",
  "////////////////////////////",
  "// see src/utils for details",
  "// 主进程 main.js",
  "window.api.ping().then(console.log) // 输出: pong from main",
  "prose with https://example.com/docs/page in it",
  "(https://example.com/x)",
  "3 / 4 of the time",
  "a // b in integer math",
];

const mustRedact: ReadonlyArray<readonly [string, string, string]> = [
  ["/usr/local/bin/node", "[path]", "usr/local"],
  ["/etc/passwd", "[path]", "passwd"],
  ["see /private/ledger.sqlite now", "see [path] now", "ledger.sqlite"],
  ["(see /home/user/.ssh/id_rsa)", "(see [path])", "id_rsa"],
  ["path C:\\Users\\someone\\secret.txt here", "path [path] here", "secret.txt"],
  ["forward C:/Users/someone/secret.txt too", "forward [path] too", "secret.txt"],
  ["unc \\\\server\\share\\file.docx here", "unc [path] here", "file.docx"],
  ["forward unc //server/share/file.docx here", "forward unc [path] here", "file.docx"],
  ["url file:///C:/Users/someone/token.key here", "url [path] here", "token.key"],
  ["single-segment /etc stays covered", "single-segment [path] stays covered", "/etc"],
  ["```\ncat /home/user/key.pem\n```", "```\ncat [path]\n```", "key.pem"],
];

test("comment and URL shapes render as written", () => {
  for (const row of mustSurvive) {
    assert.equal(redactFilesystemPaths(row), row, JSON.stringify(row));
  }
});

test("real filesystem paths still redact, in prose and inside code blocks", () => {
  for (const [row, expected, secret] of mustRedact) {
    const redacted = redactFilesystemPaths(row);
    assert.equal(redacted, expected, JSON.stringify(row));
    assert.equal(
      redacted.includes(secret),
      false,
      `${JSON.stringify(row)} must not leak ${JSON.stringify(secret)}`,
    );
  }
});

test("a deliberate conservatism: host-shaped double-slash text redacts", () => {
  /* `//host/path` is forward-slash UNC — a real path form — and a
     protocol-relative URL is indistinguishable from it, so both redact.
     Privacy wins the tie; this row documents the choice so a later reader
     does not mistake it for an accident. */
  assert.equal(
    redactFilesystemPaths("script at //cdn.example.com/lib.js here"),
    "script at [path] here",
  );
});
