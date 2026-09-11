// An offline stand-in for a vendor CLI's sign-in command.
//
// It makes no network call and touches no credential. Every URL here is
// SYNTHETIC and points at `.invalid`, which can never resolve: a real
// authorisation URL carries a single-use code and must never be captured into
// a fixture, a log or a screenshot.
//
// The shapes mirror what the shipped binaries actually print -- codex 0.153.4:
// "Starting local login server on http://localhost:PORT." then "If your
// browser did not open, navigate to this URL to authenticate:"; claude
// 2.1.267: "If the browser did not open, visit:".

const mode = process.env.UAW_TEST_SIGN_IN_MODE ?? "with-url";
const url =
  "https://auth.example.invalid/oauth/authorize?client_id=synthetic&code=SYNTHETIC-NOT-A-REAL-CODE";

const write = (text) =>
  new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });

if (mode === "with-url") {
  // The localhost callback server is printed first and must NOT be mistaken
  // for the sign-in destination.
  await write("Starting local login server on http://localhost:1455.\n");
  await write("If your browser did not open, navigate to this URL to authenticate:\n");
  await write(`\n${url}\n`);
  await write("On a remote or headless machine? Use device auth instead.\n");
} else if (mode === "split") {
  // The URL arrives across three writes with no newline until the end, so a
  // reader that scans partial buffers would report it truncated.
  await write("If the browser did not open, visit:\n");
  await write(url.slice(0, 20));
  await write(url.slice(20, 45));
  await write(`${url.slice(45)}\n`);
} else if (mode === "stderr-url") {
  await new Promise((resolve) => {
    process.stderr.write(`If the browser did not open, visit:\n${url}\n`, () =>
      resolve(),
    );
  });
} else if (mode === "no-url") {
  // A run that opened the browser without printing any link, plus a callback
  // server line: the product must show nothing rather than offer localhost.
  await write("Starting local login server on http://localhost:1455.\n");
  await write("Opening browser to sign in\n");
} else if (mode === "hostile-url") {
  // Neither of these may ever reach the card.
  await write("javascript:alert(document.domain)\n");
  await write("data:text/html;base64,PHNjcmlwdD4=\n");
}

process.exit(0);
