import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const e2eDirectory = fileURLToPath(new URL("./", import.meta.url));

function ciJobSource(source: string, jobName: string): string {
  const lines = source.split(/\r?\n/u);
  const header = `  ${jobName}:`;
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `CI job ${jobName} must exist`);
  const nextJobOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}[a-z0-9-]+:\s*$/u.test(line));
  const end = nextJobOffset === -1 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end).join("\n");
}

test("the supported ordinary suite is serialized, documented, and includes the E2E guard glob", async () => {
  const [packageSource, testingGuide, ciSource] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts?: Readonly<Record<string, unknown>>;
  };
  const testScript = packageJson.scripts?.test;
  if (typeof testScript !== "string") {
    assert.fail("package.json scripts.test must be a string");
  }
  assert.match(testScript, /^node --test --test-concurrency=1 /u);
  for (const glob of [
    "tests/agent-runtime/*.test.ts",
    "tests/session-profile/*.test.ts",
    "tests/coordinator/*.test.ts",
    "tests/workbench-shell/*.test.ts",
    "tests/harness/*.test.ts",
    "tests/e2e/*.test.ts",
    "tests/launcher/*.test.mjs",
  ]) {
    assert.equal(testScript.includes(glob), true, `missing ordinary-suite glob ${glob}`);
  }
  assert.match(testingGuide, /Supported full-suite command: `pnpm test`\./u);
  assert.match(testingGuide, /Bare `node --test` from the repository root is unsupported\./u);
  assert.match(testingGuide, /--test-concurrency=1/u);
  assert.doesNotMatch(
    testingGuide,
    /Bare `node --test` from the repository root is supported\./u,
  );

  const packageGlobs = testScript.match(/tests\/[^\s]+/gu) ?? [];
  const unitTestsJob = ciJobSource(ciSource, "unit-tests");
  const typecheckJob = ciJobSource(ciSource, "typecheck");
  const ciGlobs = [...unitTestsJob.matchAll(/^\s+globs:\s*'([^']+)'/gmu)].flatMap(
    (match) => match[1].split(/\s+/u),
  );
  assert.deepEqual(
    ciGlobs,
    packageGlobs,
    "CI unit-test matrix globs must exactly mirror package.json scripts.test",
  );
  assert.match(
    unitTestsJob,
    /^\s+run:\s+node --test --test-concurrency=1 \$\{\{ matrix\.globs \}\}\s*$/mu,
    "CI must execute the matrix globs instead of merely declaring them",
  );
  assert.match(
    typecheckJob,
    /^\s+- name:\s+Run test-infrastructure guard independently\s*\n\s+run:\s+node --test --test-concurrency=1 tests\/e2e\/test-infrastructure\.test\.ts\s*$/mu,
    "the mirror guard needs a fixed CI entry independent of the E2E glob it guards",
  );
});

test("the ordinary E2E guard parses every TypeScript driver without launching it", async () => {
  const entries = await readdir(e2eDirectory, { withFileTypes: true });
  const driverNames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name)
    .sort();
  assert.ok(driverNames.length > 0, `no E2E drivers found under ${repositoryRoot}`);
  assert.equal(driverNames.includes("electron-e2e.ts"), true);

  for (const driverName of driverNames) {
    const driverUrl = new URL(driverName, import.meta.url);
    const source = await readFile(driverUrl, "utf8");
    const transpilation = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: driverName,
      reportDiagnostics: true,
    });
    const errors = (transpilation.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    assert.deepEqual(
      errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      [],
      `${driverName} has TypeScript parse errors`,
    );
  }
});
