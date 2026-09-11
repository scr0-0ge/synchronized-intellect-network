<h1 align="center">Synchronized Intellect Network</h1>

<p align="center">
  <strong>Eight coding agents. One window. Your own subscriptions.</strong>
</p>

<p align="center">
  Codex CLI and Claude Code, plus GLM, Kimi and DeepSeek — organised by project,<br>
  with conversations that survive closing the app.
</p>

<p align="center">
  <a href="https://github.com/scr0-0ge/synchronized-intellect-network/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/scr0-0ge/synchronized-intellect-network/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/built%20with-Electron%20·%20Solid-2f6f9f?style=flat-square" alt="Electron and Solid">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fa34d?style=flat-square" alt="MIT"></a>
</p>

<p align="center">
  <a href="#see-it">See it</a> ·
  <a href="#run-it">Run it</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#the-eight-endpoints">Endpoints</a> ·
  <a href="#under-the-hood">Under the hood</a> ·
  <a href="#develop">Develop</a>
</p>

<p align="center">
  <sub>Not affiliated with OpenAI, Anthropic, Zhipu, Moonshot or DeepSeek.<br>
  It drives their command-line tools. It does not resell their models.</sub>
</p>

---

## See it

<p align="center">
  <img src="docs/media/completed-turn.png" alt="A finished turn: the transcript and its file-change summary on the left, the turn profile on the right" width="900">
</p>

A finished turn. On the left, the transcript and what the agent actually did to your files.
On the right, the profile that turn ran under — endpoint, model, work intensity, execution and
access mode — and the session sitting there resumable.

While it runs you get the real tool calls, not a spinner:

```
Bash npm test
Read src/agent-runtime/codex-adapter.ts
Edit src/session-metadata.ts
```

And when it stops, the diff it left behind:

```
Changed 3 files: a.ts +12/-4; b.ts; c.ts +1/-0
```

Put this on the first line and the agent repeats your instruction for up to ten turns, waiting
for each one to land before starting the next:

```
/auto-continue 3
Run the failing test and fix whatever it reports.
```

## Run it

Download this repository and double-click **`start.bat`**. That is the whole install.

Nothing has to be set up first — if Node is missing or too old, the launcher fetches its own copy
into `%LOCALAPPDATA%`, installs from the lockfile, builds, and starts the app. Nothing lands
globally, and if a step fails the window stays open and tells you what it was looking for.

You need Windows and at least one of [Codex CLI](https://github.com/openai/codex) or
[Claude Code](https://claude.com/claude-code). Those are the tools the app drives. It finds an
existing install, and if there is none, one button in Settings installs a private copy into
`%LOCALAPPDATA%` — no sign-in needed for the GLM, Kimi or DeepSeek endpoints, which run on
your own API key.

Arguments go straight through to Electron, so a throwaway profile is one flag away:

```
.\start.bat --user-data-dir=C:\sin-throwaway
```

## What it does

- **Real conversations, both runtimes.** Start a session, send a turn, send another, get the reply
  attributed to the model that produced it.
- **They survive a restart.** Close the app, reopen it, continue the same session.
- **Projects, not folders.** A project is a directory plus every agent session and work history
  attached to it.
- **Watch the agent work.** The tool call it is actually making, live, with credentials in the
  command line redacted before they reach the screen.
- **Which files a turn changed,** computed from the real diff.
- **Failures have names.** Sixteen of them, each with what to check next.
- **Model, effort and usage per session,** read from the vendor's own tool at run time, in that
  vendor's own words — including token counts and reset times where the vendor reports them.
- **Durable local history.** Sessions, turns and outcomes in a SQLite ledger, one per project.
- **A Windows-native shell.** Custom title bar, tray, light and dark acrylic themes, and a CRT skin.
- **English and Simplified Chinese,** switchable at run time.

## The eight endpoints

| Endpoint | Sign-in |
| --- | --- |
| Codex · Subscription | the Codex CLI's own |
| Claude · Subscription | Claude Code's own |
| GLM Coding Plan · Kimi Code · Kimi Platform · DeepSeek · Claude API · Codex API | an API key you paste in Settings |

Subscription sessions never ask you for anything — authentication stays inside the vendor's tool,
where you already set it up. Keys are encrypted through Windows DPAPI, and each one only ever
reaches the endpoint it belongs to. No server behind the app, no telemetry: your turns reach the
vendor through the vendor's own CLI, exactly as they would in a terminal.

The GLM · DeepSeek · Kimi Code · Codex · API cards also each have an optional Base URL field, for
pointing that endpoint at a compatible gateway instead of its official API.

## Status

Early, Windows-only, one person's project.

- No signed release yet; `pnpm workbench:package:windows` builds an unsigned local one.
- The first run needs the network — that is where Node and the dependencies come from.
- A session pinned to a model the vendor has retired can't be continued. The app points you at a
  new one.

## Under the hood

Electron main owns the project registry, the per-project SQLite ledger, and everything that touches
the filesystem or spawns a process. A Solid renderer owns the UI and talks to main across a narrow
preload bridge. Adapters wrap each vendor's CLI over its own protocol — an adapter owns transport
and session identity, never credentials.

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. Every noun in this codebase (Project, Agent Session,
  Session Profile, Work Intensity, Access Mode…) is defined there.
- [`docs/adr/`](docs/adr) — 22 architecture decision records, in the order they were taken.

## Develop

```
pnpm install --frozen-lockfile
pnpm workbench:start     # build the bundles and launch
pnpm typecheck
pnpm test
```

`pnpm test` is the supported gate. `pnpm test:rendered-surfaces` is a second one that drives a real
Chromium and measures rendered pixels, so it is sensitive to display resolution. CI runs both on
`windows-latest`.

Leave `.gitattributes` alone: `* -text` is what stops a fresh Windows clone from rewriting every
line ending, which a great many tests would report as wholesale corruption.

## Feedback

Open an issue. The most useful report says what you did, what you expected, what happened, and
which vendor CLI and version you were driving.

## License

[MIT](LICENSE).
