# Running tests

Supported full-suite command: `pnpm test`.

Bare `node --test` from the repository root is unsupported. Node's default
file-level concurrency lets independent renderer harnesses contend for shared
`.scratch/workbench-renderer-harness-*` profile paths; on Windows that has
produced `EBUSY` cleanup failures and a stall in the f56-f57 driver. The package
script is the supported gate because it pins `--test-concurrency=1` and lists
the intended test globs explicitly.

The ordinary suite's `tests/e2e/*.test.ts` glob runs a non-launching source
guard over every E2E TypeScript driver. Use `pnpm test:e2e` only for the live
Electron gate; that entrypoint launches the product and runtime discovery with
an isolated, seeded `--user-data-dir`.

`pnpm test:rendered-surfaces` is a separate gate. It drives a real Chromium in a
hidden window at a pinned viewport and measures the rendered pixels, so it is
sensitive to display resolution; CI enlarges the runner's virtual display first.

## What this suite does not cover

This repository's visual work is specified against a design corpus that is not
published. Ten test files read that corpus directly and are therefore not
part of this tree. `tests/harness/public-suite-scope.test.ts` names every one of
them, with the reason, and proves each is genuinely absent — so the suite's own
output states what it does not run rather than reporting green over a silence.

A consequence worth stating plainly: a green run here does not check that the
shipped CSS and copy still match their specification. It checks everything else.
