/**
 * The public suite declares its own scope.
 *
 * This repository's visual and copy work is specified against a design corpus
 * that is not published. Ten test files read that corpus at test time, so they
 * cannot run here, and a suite that simply omitted them would report green
 * over a silence — a reader would have no way to tell a passing assertion from
 * an absent one.
 *
 * So the omission is an assertion. This file names every excluded suite with
 * its reason, PROVES each is genuinely absent rather than merely unlisted, and
 * proves the tree carries no design-corpus content at all. If someone restores
 * one of these files without restoring the corpus, this test goes red before
 * the missing corpus does; if someone restores the corpus, this test goes red
 * and tells them to re-enable the suites it names.
 *
 * The private repository runs all of these. This file exists only here.
 */

import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

interface ExcludedSuite {
  readonly path: string;
  readonly reason: string;
}

/** Reads the private design corpus at test time; the corpus is not published. */
const CORPUS_READING_SUITES: readonly ExcludedSuite[] = Object.freeze([
  {
    path: "tests/harness/settings-appearance-persistence-driver.test.ts",
    reason: "reads 06-provider-settings.html and owner-decisions.md",
  },
  {
    path: "tests/workbench-shell/appearance-fidelity.test.ts",
    reason: "reads theme-acrylic.css, workbench.css and owner-decisions.md",
  },
  {
    path: "tests/workbench-shell/continuation-profile-design-fidelity.test.ts",
    reason: "reads 01-empty-project.html, 02-active-session.html and owner-decisions.md",
  },
  {
    path: "tests/workbench-shell/history-recovery-corpus.test.ts",
    reason: "reads owner-decisions.md, 08-history-recovery.html and index.html",
  },
  {
    path: "tests/workbench-shell/owner-decision-provenance.test.ts",
    reason: "reads owner-decisions.md and 04-runtime-not-found.html",
  },
  {
    path: "tests/workbench-shell/project-histories-design-fidelity.test.ts",
    reason: "reads 09-project-histories.html and index.html",
  },
  {
    path: "tests/workbench-shell/removal-design-fidelity.test.ts",
    reason: "reads 07-skins.html, owner-decisions.md and workbench.css",
  },
  {
    path: "tests/workbench-shell/session-metadata-design-fidelity.test.ts",
    reason:
      "reads 02-active-session.html, 03-terminal-session.html, 07-skins.html, owner-decisions.md and workbench.css",
  },
  {
    path: "tests/workbench-shell/theme-legibility.test.ts",
    reason:
      "reads theme-acrylic.css, theme-legibility.css, theme-crt.css, theme-schemes.css and owner-decisions.md",
  },
  {
    path: "tests/workbench-shell/titlebar-caret-design-fidelity.test.ts",
    reason: "reads the whole corpus directory",
  },
]);

/** Excluded for reasons other than the corpus. */
const OTHER_EXCLUDED_SUITES: readonly ExcludedSuite[] = Object.freeze([
  {
    path: "tests/harness/text-integrity.test.ts",
    reason:
      "covers scripts/check-text-integrity.ts, whose guard-pinned historical-BOM map names files that are not published",
  },
  {
    path: "tests/launcher/run-app.test.mjs",
    reason:
      "covers run-app.bat, a launcher for the author machine that never looks at PATH; start.bat is the launcher here, and tests/launcher/start.test.mjs — which DOES run in this tree — covers it",
  },
]);

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(join(repositoryRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

test("the public suite states, in its own output, which suites it does not run", async () => {
  const excluded = [...CORPUS_READING_SUITES, ...OTHER_EXCLUDED_SUITES];

  console.log(
    [
      "",
      `  This suite does NOT run ${String(excluded.length)} test files that the private repository runs.`,
      "  A green result below covers everything else, and nothing about these:",
      "",
      ...CORPUS_READING_SUITES.map((suite) => `    - ${suite.path}\n        ${suite.reason}`),
      "",
      ...OTHER_EXCLUDED_SUITES.map((suite) => `    - ${suite.path}\n        ${suite.reason}`),
      "",
      "  Consequence: a green run does not check that the shipped CSS and copy still",
      "  match their design specification. It checks everything else.",
      "",
    ].join("\n"),
  );

  // The list is only meaningful if each entry is genuinely gone. An excluded
  // path that is actually present would mean the suite ran it and this notice
  // lied about the run.
  const present: string[] = [];
  for (const suite of excluded) {
    if (await exists(suite.path)) present.push(suite.path);
  }
  assert.deepEqual(
    present,
    [],
    "a suite listed as not-run is present in the tree; either run it or stop listing it",
  );

  // The notice above claims that start.bat's own suite DOES run here. A claim
  // about what is covered deserves the same proof as a claim about what is not.
  assert.equal(
    await exists("tests/launcher/start.test.mjs"),
    true,
    "the notice says start.bat is covered in this tree; its suite is missing",
  );
  assert.equal(
    await exists("start.bat"),
    true,
    "the notice points a reader at start.bat, which is not in this tree",
  );
});

test("no design-corpus or ledger content reached this tree", async () => {
  for (const forbidden of [
    ".scratch",
    ".agents",
    "docs/agents",
    "prototypes",
    "run-app.log",
  ]) {
    assert.equal(
      await exists(forbidden),
      false,
      `${forbidden} must not exist in the public tree`,
    );
  }
});

test("every remaining test file is free of design-corpus reads", async () => {
  // Assembled at run time on purpose. Spelled as one literal, this file would
  // contain the very string it searches for and would report itself — which is
  // what the first run of this test actually did. Building it from parts keeps
  // this file inside the scanned set rather than exempting it from its own rule.
  const corpusNeedle = ["unified-ai-workbench", "design"].join("/");
  const suiteDirectories = [
    "tests/agent-runtime",
    "tests/coordinator",
    "tests/harness",
    "tests/quarantine",
    "tests/session-profile",
    "tests/workbench-shell",
  ];
  const offenders: string[] = [];
  for (const directory of suiteDirectories) {
    const absolute = join(repositoryRoot, directory);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
      const source = await readFile(join(absolute, entry.name), "utf8");
      if (source.includes(corpusNeedle)) {
        offenders.push(`${directory}/${entry.name}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a test in this tree reads the design corpus, which is not published",
  );
});
