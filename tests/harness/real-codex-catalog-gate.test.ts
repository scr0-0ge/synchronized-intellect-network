import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { probeRealCodexCatalog } from "../../scripts/validate-codex-catalog.ts";

/**
 * The one observation that can see an `F108`/`F110` recurrence.
 *
 * Every other Codex catalog test runs against a fixture we wrote ourselves, so
 * none of them can go red when the Runtime adds a field — fixtures do not grow
 * new fields on their own. That is exactly how `F108` reached the built product
 * with a green suite, and on 2026-08-15 it happened again: the real CLI shipped
 * `modelSpecialty` and `multiAgentVersion`, the exact-shape gate rejected all
 * seven models, and Codex went unavailable in the product with nothing red.
 *
 * A catalog read is not an inference turn and costs no allowance, so this gate
 * is free to run in the ordinary suite.
 *
 * It is deliberately three-valued rather than pass/fail. `catalog-invalid` is
 * the parser refusing a response the real CLI actually produced — our defect,
 * and the only outcome that fails. A missing CLI or an expired login proves
 * nothing about the parser, so it is reported as an absent observation instead
 * of being silently counted as coverage. A guard that cannot fire must at least
 * say so out loud (`F81`, `F111`).
 */
test(
  "the production Codex parser accepts the real catalog this machine serves",
  { timeout: 120_000 },
  async (t) => {
    const projectDirectory = resolve(
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    const probe = await probeRealCodexCatalog(projectDirectory);

    if (probe.outcome === "not-observed") {
      t.diagnostic(
        `REAL CATALOG NOT OBSERVED (category=${probe.category}): the Codex CLI ` +
          "could not be reached or is not logged in, so nothing was proven " +
          "about the production parser on this run.",
      );
      t.skip("no real Codex runtime available to observe");
      return;
    }

    assert.equal(
      probe.outcome,
      "catalog-ok",
      "the production parser rejected the real Codex model/list response. " +
        "Run `node --no-warnings scripts/validate-codex-catalog.ts` and admit " +
        "the new exact shape under rule 1 with a matching adversarial row.",
    );
    assert.ok(
      probe.outcome === "catalog-ok" && probe.modelIds.length > 0,
      "a real catalog read returned no models",
    );
  },
);
