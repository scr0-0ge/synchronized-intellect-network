# Rendered-surface tests

The directory name is historical. These suites are active and run in CI through
`pnpm test:rendered-surfaces`. They launch a hidden Electron window against an
isolated, seeded profile; the measurement driver disables hardware acceleration
and never takes the owner's screen.

Both suites were quarantined after CI run #32902949555 on 2026-08-26. A later
local revalidation passed every assertion, while the claimed display/GPU cause
was not backed by a retained failure log and conflicts with the driver's actual
headless setup. The suites were therefore restored as a separate gate instead
of deleting their Chromium geometry and contrast coverage.
