# Synchronized Intellect Network

A local Windows desktop app that puts the coding agents you already pay for behind
one interface, organised by project, with conversations that survive closing the app.

It does not resell anyone's model. It drives the vendors' own command-line tools —
Codex CLI and Claude Code — under **your** subscriptions, on your machine. It never asks
for an API key and never brokers your sign-in: authentication stays inside each vendor's
own tool, where you already set it up. It goes further than "does not ask" — before
spawning a vendor CLI for a subscription session, it *deletes* `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and their siblings from the child's environment, so a key that happens to
be in your shell cannot quietly become the thing that pays for the turn.

---

## What it does today

- **Two runtimes, one interface.** Codex and Claude Code both hold a real conversation:
  start a session, send a turn, send another, get the reply attributed to the model that
  produced it.
- **Conversations survive a restart.** Close the app, reopen it, continue the same
  session on either runtime.
- **Projects, not folders.** A project is a local directory plus the agent sessions and
  work history attached to it. Create one or open an existing one; the app remembers.
- **Durable local history.** Sessions, turns and their outcomes are written to a local
  SQLite ledger, one per project. The Workbench itself opens no network connection of its own
  — there is no server behind it and no telemetry. Your turns do of course reach the vendor,
  through the vendor's own CLI, exactly as they would if you ran that CLI in a terminal.
- **Model and effort per session.** The model list and the effort/intensity choices come
  from each vendor's own tool at run time, in that vendor's own words — not from a
  hardcoded list that goes stale.
- **Windows-native shell.** Custom title bar, tray, themes (including a light and a dark
  acrylic, and a CRT skin).
- **English and Simplified Chinese.** Every copy module ships both dictionaries behind one
  runtime switch, and the choice is kept with your appearance preferences.

## What it is not, yet

- **Windows only.** Not a portability gap to work around — the shell, the process
  observer and the packaging are Windows by construction.
- **Early.** This is one person's project. Expect rough edges, and expect to read an
  error message occasionally rather than a fix.
- **No installer.** You run it from a checkout, or build a local package. It is not
  signed and not distributed.
- **Sessions created before the restart fix cannot be resumed after a restart.** Their
  native identity was never written down and cannot be reconstructed. Sessions created
  from a current build onward survive; older ones stay non-continuable across a restart.
  There is no migration, and there cannot be one.
- **Re-picking a model for an orphaned session is not built.** If a session was recorded
  against a model the vendor has since retired, that session cannot be continued. Start a
  new one; the app points you there.

---

## Requirements

- Windows. Developed and exercised on Windows 11; CI runs every job on `windows-latest`.
- [Node.js](https://nodejs.org) 22.5 or newer (24 is what CI uses; the tests import
  `node:sqlite`)
- [pnpm](https://pnpm.io) 11 — optional if you use `start.bat`, which runs the pinned version
  through Node's bundled `corepack` when pnpm is not on your PATH
- At least one of: [Codex CLI](https://github.com/openai/codex) or
  [Claude Code](https://claude.com/claude-code), installed and already signed in.
  The app finds them; it does not install or authenticate them.

## Run it

Double-click **`start.bat`** in the repository root.

It finds `node` on your PATH and checks it is 22.5 or newer; installs the dependencies from the
lockfile when they are missing or when `pnpm-lock.yaml` has moved ahead of them; builds the
three bundles; and launches the app. If pnpm is not on your PATH it runs the pinned pnpm
through Node's bundled `corepack` instead — nothing is installed globally on your machine,
either way. Every failure says what it looked for, where it looked, and where to get it, and
the window stays open so you can read it.

Or do the same thing yourself, from a shell:

```
pnpm install --frozen-lockfile
pnpm workbench:start
```

`workbench:start` builds the three bundles and launches Electron. Create or open a project,
then start an agent session in it. Electron's own `--user-data-dir` works if you want to keep
a throwaway profile separate from your real one, and `start.bat` passes it — and every other
argument — straight through:

```
.\start.bat --user-data-dir=C:\sin-throwaway
```

The leading `.\` is not decoration: neither PowerShell nor a hardened `cmd` searches the
current directory for a command to run.

To build without launching:

```
pnpm build
```

which produces `dist/main/main.js`, `dist/preload/preload.cjs` and
`dist/renderer/index.html`.

To build a local Windows package (unsigned, not distributed):

```
pnpm workbench:package:windows
```

## Check it

```
pnpm typecheck
pnpm test
```

`pnpm test` is the supported gate — it pins `--test-concurrency=1` and lists its globs
explicitly; bare `node --test` from the repository root is not supported. There is a
second, separate gate that drives a real Chromium and measures rendered pixels:

```
pnpm test:rendered-surfaces
```

It is sensitive to display resolution, so CI enlarges the runner's virtual display first.

The suite tells you what it does not cover: the visual and copy work is specified against
a design corpus that is not published, so the tests that read it are not in this tree.
`tests/harness/public-suite-scope.test.ts` names every one of them with its reason and
proves each is genuinely absent, rather than reporting green over a silence.

---

## How it is put together

- **Electron main** owns the project registry, the per-project SQLite ledger, and every
  capability that touches the filesystem or spawns a process.
- **A Solid renderer** owns the UI and holds no privileged capability; it talks to main
  across a narrow preload bridge.
- **Adapters** wrap each vendor's CLI over its own protocol. An adapter owns transport
  and native session identity; it never owns credentials.
- **Everything crossing a boundary is sanitized against an exact shape.** An unrecognised
  field fails closed rather than passing through — including the vendors' own catalog
  payloads, which is why a new model field makes a profile unavailable until the shape is
  deliberately extended.

Two files are worth reading before the code:

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every noun in this codebase (Project,
  Agent Session, Session Profile, Work Intensity, Access Mode…) is defined there, with
  the words the project deliberately avoids.
- [`docs/adr/`](docs/adr) — 21 architecture decision records, in the order they were
  taken.

`.gitattributes` sets `* -text`, so Git never translates line endings in either direction.
Do not remove it. A great many tests here read source files as text and assert on exact
strings, and `core.autocrlf` is `true` by default on plenty of Windows installs — without
this file, a fresh clone would rewrite every checked-out file and the failures would look
like wholesale corruption rather than like a line-ending setting.

---

## Feedback

Open an issue. The most useful report says what you did, what you expected, what happened,
and which vendor CLI and version you were driving. Rough edges are expected right now, so
"this was confusing" is a legitimate report.

## License

[MIT](LICENSE).
