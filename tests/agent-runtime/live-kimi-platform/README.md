# Kimi Platform issue #6 probe (manual)

Real Codex CLI → loopback Responses receiver, real Workbench backend/coordinator,
and the production Composer in headless Chromium. No Electron window or owner
conversation store. The Composer shell is adapted from w64 (`-97`); the wire
receiver follows w71's real-CLI/loopback approach, but uses the Codex/Responses
face, not Claude/Anthropic.

All modes use `kimi-platform / kimi-k2.7-code / default` (wire effort `high`).
Other endpoint adapters refuse start/resume. Each invocation gets a new project,
ledger and CODEX_HOME under `%LOCALAPPDATA%/uaw-w80/`, while continuations inside
that invocation must keep the original native thread and Workbench command.

## Zero inference first

```powershell
.\pnpm.bat exec node tests/agent-runtime/live-kimi-platform/run.ts prepare
.\pnpm.bat exec node tests/agent-runtime/live-kimi-platform/run.ts offline
.\pnpm.bat exec node tests/agent-runtime/live-kimi-platform/run.ts offline --continuation-only
.\pnpm.bat exec node tests/agent-runtime/live-kimi-platform/run.ts offline --cancel-only
```

- Default: hold the first local answer for 14 seconds, sample the real guide
  button 12 times over >11 seconds, steer, then attempt continuation/cancellation.
  Stub text is **not** evidence of real model instruction-following.
- `--continuation-only`: first answer, immediate second message, then cancellation
  if continuation succeeds. Exposes the real CLI's resume-time usage notification.
- `--cancel-only`: emit a local `exec_command` call for a harmless PowerShell
  sleep, wait for the real CLI commandExecution item, then Stop and continue the
  same session. The completed model response has saved usage, matching the live
  tool-running cancellation scenario without provider inference.
- `prepare`: catalog plus actual Composer mounting, no thread or turn start.

Assertions expect working product behavior. Before the w80 fix, default and
continuation-only exited **1** for confirmed product defects. The earlier probe's
pre-response cancellation control exited **0**. After the fix the default
scenario completes guidance, the second message, cancellation and same-session
continuation with exit **0**; the current tool-running `--cancel-only` also exits
**0**. A failed prerequisite stops that scenario without replacing its session.

## Explicitly authorized live verification only

Do not run these as part of a normal suite. One invocation permits at most five
input frames (`turn/start` plus `turn/steer`) and eight HTTP inference requests;
the observation log counts both separately. Never retry a failed invocation
without checking its accounting first.

```powershell
$env:KIMI_PLATFORM_API_KEY = [Environment]::GetEnvironmentVariable('KIMI_PLATFORM_API_KEY','User')
$env:UAW_W80_LIVE = 'kimi-platform'
try {
  .\pnpm.bat exec node tests/agent-runtime/live-kimi-platform/run.ts live
  # Choose independent scenarios only as needed:
  # ... run.ts live --continuation-only
  # ... run.ts live --cancel-only
  # ... run.ts live --text-guidance
} finally {
  Remove-Item Env:KIMI_PLATFORM_API_KEY
  Remove-Item Env:UAW_W80_LIVE
}
```

The proxy forwards unchanged request bodies only to
`https://api.moonshot.cn/v1/responses`. It adds the real Authorization header in
memory; the CLI receives only a dummy loopback credential. Headers are never
logged. Failed upstream calls are not retried. Do not use GLM, Kimi Code, or a
different endpoint URL.

Live default waits in PowerShell and tests late guidance plus the >11-second
button lifetime. `--text-guidance` steers an already-sent text-only request
immediately; it is a separate two-answer race, **not** the timed button check.
Live `--cancel-only` waits for a real commandExecution item before pressing Stop.

`observations.jsonl` records sanitized native frames, non-system HTTP input,
receipts, terminal views, sample times and request accounting. A client closing
HTTP after `response.completed` may prevent the optional `provider-result` log;
use native completion/usage frames, not HTTP connection closure, to decide the
turn result. No monetary cost is inferred from request counts.

This does not cover full Electron/preload IPC, concurrent submit, app restart,
or historical-store recovery. The committed w80 evidence records pre-fix live
failures and post-fix zero-inference verification separately. The focused
`codex-kimi-turn-boundaries.test.ts` tests also retain fatal correlation and
ambiguous-final cases. No additional paid verification was performed after the
six HTTP inference requests that established the two defects.
