import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const driverPath = fileURLToPath(
  new URL(
    "../e2e/settings-subscription-authentication-production.ts",
    import.meta.url,
  ),
);
const driverSource = readFileSync(driverPath, "utf8");
const settingsObservationSource = readFileSync(
  new URL(
    "../e2e/settings-subscription-authentication-production/settings-observation.ts",
    import.meta.url,
  ),
  "utf8",
);

test("production Settings auth proof reads the two subscription cards from the fixed five-card layout", () => {
  // Issue 161: the same three arguments, now one per line and carrying the
  // offscreen placement switch, which the product honours only because the
  // isolated --user-data-dir is on the same line-up.
  assert.match(
    driverSource,
    /args: \[\s+repositoryRoot,\s+`--user-data-dir=\$\{userData\}`,\s+OFFSCREEN_PLACEMENT_ARGUMENT,\s+`--project-directory=\$\{projectDirectory\}`,\s+\]/u,
  );
  assert.match(
    settingsObservationSource,
    /getByRole\("button", \{ name: "Settings", exact: true \}\)[\s\S]*?\.click\(\)/u,
  );
  assert.match(settingsObservationSource, /assert\.equal\(await providerCards\.count\(\), 5\)/u);
  assert.match(driverSource, /Object\.freeze\(\["Codex", "Claude"\] as const\)/u);
  assert.match(settingsObservationSource, /assert\.equal\(renderedName, provider\);/u);
  assert.match(settingsObservationSource, /name: provider,/u);
  assert.doesNotMatch(
    settingsObservationSource,
    /renderedName\s*===\s*provider\s*\?\s*provider\s*:\s*provider/u,
  );
  assert.match(
    settingsObservationSource,
    /availability: "Ready"[\s\S]*?status: "Catalog ready"[\s\S]*?catalog: "Available"[\s\S]*?subscription: "Bound"/u,
  );
  assert.match(
    settingsObservationSource,
    /getByRole\("status", \{[\s\S]*?name: `\$\{provider\} subscription authentication: Bound`,[\s\S]*?exact: true,[\s\S]*?\}\)/u,
  );
  assert.match(settingsObservationSource, /assert\.equal\(await bindButtons\.count\(\), 0\)/u);
  assert.match(settingsObservationSource, /assert\.equal\(await cancelButtons\.count\(\), 0\)/u);
  assert.doesNotMatch(settingsObservationSource, /getByRole\("button", \{ name: \/\^Bind/u);
  assert.doesNotMatch(settingsObservationSource, /getByRole\("button", \{ name: \/\^Cancel/u);
  assert.doesNotMatch(settingsObservationSource, /(?:bindButtons|cancelButtons)\.click\(/u);
});

test("Settings keeps the exact public structure and no credential fields on subscription cards", () => {
  assert.match(
    settingsObservationSource,
    /getByRole\("heading", \{ name: "Settings", exact: true, level: 1 \}\)/u,
  );
  assert.match(settingsObservationSource, /assert\.deepEqual\(sections, \[[\s\S]*?"Appearance",[\s\S]*?"Providers",[\s\S]*?"Tools",[\s\S]*?"Usage & resets",[\s\S]*?"Claude permissions",?[\s\S]*?\]\)/u);
  assert.match(settingsObservationSource, /subscriptionProviderCards\.locator\("input, textarea"\)\.count\(\)/u);
  assert.match(settingsObservationSource, /subscriptionProviderCards\.locator\('input\[type="password"\]'\)\.count\(\)/u);
  assert.match(settingsObservationSource, /Object\.freeze\(\["Add provider", "OpenCode"\] as const\)/u);
  assert.match(settingsObservationSource, /assert\.equal\(await titlebarSettings\.count\(\), 0\)/u);
  assert.match(settingsObservationSource, /assert\.equal\(await settingsHeadings\.count\(\), 1\)/u);
});

test("normal subscription discovery context is preserved while credential env is scrubbed", () => {
  assert.match(driverSource, /const preservedEnvironmentKeys = Object\.freeze\(\[[\s\S]*?"PATH",[\s\S]*?"HOME",[\s\S]*?"USERPROFILE",[\s\S]*?"APPDATA",[\s\S]*?"LOCALAPPDATA",[\s\S]*?\] as const\)/u);
  assert.match(
    driverSource,
    /const requiredEnvironmentKeys = Object\.freeze\(\["PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA"\] as const\)/u,
  );
  assert.match(
    driverSource,
    /for \(const requiredKey of requiredEnvironmentKeys\)[\s\S]*?environment\[requiredKey\] = requiredEnvironmentValue\(requiredKey\)/u,
  );
  assert.match(driverSource, /const currentHome = environmentValue\("HOME"\)/u);
  assert.match(
    driverSource,
    /environment\.HOME =\s*currentHome === undefined \|\| currentHome\.length === 0\s*\? currentUserProfile\s*:\s*currentHome/u,
  );
  assert.match(
    driverSource,
    /function requiredEnvironmentValue\([\s\S]*?throw new Error\("required-user-environment-unavailable"\)[\s\S]*?return value/u,
  );
  assert.doesNotMatch(
    driverSource,
    /environment\.HOME\s*=\s*(?:isolatedTemp|routineRoot|tmpdir\(\))/u,
  );
  assert.match(driverSource, /credentialEnvironmentKeyPattern/u);
  assert.match(driverSource, /if \(isSensitiveEnvironmentKey\(key\)\) continue;/u);
  assert.match(driverSource, /environment\.TEMP = isolatedTemp/u);
  assert.match(driverSource, /environment\.TMP = isolatedTemp/u);
  assert.match(driverSource, /environment\.TMPDIR = isolatedTemp/u);
  assert.doesNotMatch(driverSource, /--bare/u);
  assert.doesNotMatch(driverSource, /OPENAI_API_KEY\s*=/u);
  assert.doesNotMatch(driverSource, /ANTHROPIC_API_KEY\s*=/u);
});

test("cleanup is bounded and destructive authority stays on the exact captured child", () => {
  assert.match(driverSource, /const ownedMainProcess = application\.process\(\)/u);
  assert.match(driverSource, /const ownedMainPid = ownedMainProcess\.pid/u);
  assert.match(driverSource, /currentMainProcess !== ownedMainProcess/u);
  assert.match(driverSource, /currentMainProcess\.pid !== ownedMainPid/u);
  assert.match(driverSource, /await withTimeout\(application\.close\(\), 10_000\)/u);
  assert.match(driverSource, /forcedExactChildTerminationRequested = true;\s*ownedMainProcess\.kill\(\)/u);
  assert.match(driverSource, /await waitForExactOwnedChildExit\(ownedMainProcess, ownedMainPid, 5_000\)/u);
  assert.doesNotMatch(driverSource, /taskkill|Stop-Process|Get-Process|pkill|killall|wmic/iu);
  assert.match(
    driverSource,
    /if \(runtimeFailure === undefined && cleanupFailures\.length === 0 && cleanup\.exactChildDeathProved\)[\s\S]*?await removeOwnedRoutineRoot/u,
  );
});

test("success evidence is exact, atomic, reopened, and contains no private fields", () => {
  assert.match(driverSource, /const productionEvidencePath = join\([\s\S]*?"worker-227-f68-settings-auth-production\.json"/u);
  assert.match(driverSource, /const pendingPath = join\([\s\S]*?randomUUID\(\)[\s\S]*?\.pending/u);
  assert.match(driverSource, /await writeFile\(pendingPath, expectedBytes, \{ flag: "wx" \}\)/u);
  assert.match(driverSource, /await link\(pendingPath, productionEvidencePath\)/u);
  assert.doesNotMatch(driverSource, /await rename\(pendingPath, productionEvidencePath\)/u);
  assert.match(
    driverSource,
    /const pendingIdentity = await captureRegularFileIdentity\(pendingPath\)[\s\S]*?const finalIdentity = await captureRegularFileIdentity\(productionEvidencePath\)[\s\S]*?assert\.equal\(sameFileIdentity\(pendingIdentity, finalIdentity\), true\)/u,
  );
  assert.match(driverSource, /const reopened = await readFile\(productionEvidencePath\)/u);
  assert.match(driverSource, /assert\.equal\(reopened\.byteLength, expectedBytes\.byteLength\)/u);
  assert.match(driverSource, /assert\.equal\(sha256\(reopened\), sha256\(expectedBytes\)\)/u);
  assert.match(driverSource, /assertExactProductionEvidence\(JSON\.parse\(reopened\.toString\("utf8"\)\)\)/u);
  assert.match(
    driverSource,
    /assertExactProductionEvidence\(JSON\.parse\(reopened\.toString\("utf8"\)\)\)[\s\S]*?await unlink\(pendingPath\)[\s\S]*?assert\.equal\(await isMissing\(pendingPath\), true\)/u,
  );

  const schemaStart = driverSource.indexOf("function assertExactProductionEvidence(");
  const schemaEnd = driverSource.indexOf("async function writeProductionEvidence(", schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  const schema = driverSource.slice(schemaStart, schemaEnd);
  assert.match(schema, /hasExactKeys\(value, \["schema", "dist", "settings", "providers", "cleanup"\]\)/u);
  assert.doesNotMatch(schema, /\b(?:pid|path|stderr|error|credential|token|secret|password|nativeId)\b/iu);
});

test("publication keeps pending through validation and only exact identity can remove final", () => {
  const mainStart = driverSource.indexOf("async function main()");
  const mainEnd = driverSource.indexOf("async function inspectSettings(", mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart);
  const main = driverSource.slice(mainStart, mainEnd);
  const pendingWrite = main.indexOf("await writeProductionEvidence(");
  const finalSeal = main.indexOf("await sealProductionEvidence(", pendingWrite);
  const rootRemoval = main.indexOf("await removeOwnedRoutineRoot(", finalSeal);
  assert.ok(pendingWrite >= 0);
  assert.ok(finalSeal > pendingWrite);
  assert.ok(rootRemoval > finalSeal);
  assert.match(
    driverSource,
    /async function sealProductionEvidence\([\s\S]*?await link\(pendingPath, productionEvidencePath\)[\s\S]*?sameFileIdentity\(pendingIdentity, finalIdentity\)[\s\S]*?await validateEvidenceFile\(productionEvidencePath, expectedBytes\)[\s\S]*?await unlink\(pendingPath\)[\s\S]*?assert\.equal\(await isMissing\(pendingPath\), true\)/u,
  );
  assert.match(
    driverSource,
    /async function recoverPendingAndRemoveFinal\([\s\S]*?sameFileIdentity\(pendingIdentity, finalIdentity\)[\s\S]*?await validateEvidenceFile\(pendingPath, expectedBytes\)[\s\S]*?await unlink\(productionEvidencePath\)[\s\S]*?assert\.equal\(await isMissing\(productionEvidencePath\), true\)/u,
  );
  assert.match(driverSource, /finalPresence: "PRESENT" \| "MISSING" \| "UNKNOWN"/u);
  assert.match(driverSource, /pendingRetained: boolean/u);
  assert.match(driverSource, /exactIdentityProved: boolean/u);
});

test("failure facts use inspected root identity and keep publication cleanup separate", () => {
  assert.match(
    driverSource,
    /type RoutineRootPresence = "PRESENT" \| "MISSING" \| "UNKNOWN"/u,
  );
  assert.match(
    driverSource,
    /async function inspectRoutineRootState\([\s\S]*?await lstat\(root, \{ bigint: true \}\)[\s\S]*?sameFileIdentity\(expectedIdentity, actualIdentity\)[\s\S]*?presence: "PRESENT"/u,
  );
  assert.match(
    driverSource,
    /routineRootPresence: routineRootState\.presence[\s\S]*?routineRootRetained:\s*routineRootState\.presence === "PRESENT" &&\s*routineRootState\.exactIdentityProved/u,
  );
  assert.doesNotMatch(driverSource, /routineRoot\.length > 0 && !cleanupRemoved/u);
  assert.match(driverSource, /const publicationCleanupFacts: PublicationCleanupFact\[\] = \[\]/u);
  assert.match(driverSource, /const publicationCleanupFailures: FailureFact\[\] = \[\]/u);
  assert.match(
    driverSource,
    /runtimeFailure \?\?= failureFact\([\s\S]*?"routine-root-cleanup-failed"[\s\S]*?publicationCleanupFacts\.push\([\s\S]*?publicationCleanupFailures\.push/u,
  );
  assert.match(
    driverSource,
    /publicationCleanup: \{\s*facts: publicationCleanupFacts,\s*failures: publicationCleanupFailures,\s*\}/u,
  );
});

test("filesystem identity remains lossless for Windows bigint inode values", () => {
  assert.match(
    driverSource,
    /type FileIdentity = Readonly<\{\s*dev: bigint;\s*ino: bigint;\s*\}>/u,
  );
  assert.match(
    driverSource,
    /async function captureRegularFileIdentity\([\s\S]*?const status = await lstat\(target, \{ bigint: true \}\)/u,
  );
  assert.match(
    driverSource,
    /async function inspectRegularFile\([\s\S]*?const status = await lstat\(target, \{ bigint: true \}\)/u,
  );
  assert.match(
    driverSource,
    /async function captureOwnedRoutineRootIdentity\([\s\S]*?const rootStatus = await lstat\(root, \{ bigint: true \}\)/u,
  );
  assert.match(
    driverSource,
    /async function inspectRoutineRootState\([\s\S]*?const rootStatus = await lstat\(root, \{ bigint: true \}\)/u,
  );
  assert.match(
    driverSource,
    /function fileIdentity\(dev: bigint, ino: bigint\)[\s\S]*?assert\.ok\(dev >= 0n\)[\s\S]*?assert\.ok\(ino >= 0n\)[\s\S]*?return Object\.freeze\(\{ dev, ino \}\)/u,
  );
  const identityStart = driverSource.indexOf("type FileIdentity = Readonly<{");
  const identityEnd = driverSource.indexOf("async function listFiles(", identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart);
  const identityContract = driverSource.slice(identityStart, identityEnd);
  assert.doesNotMatch(identityContract, /Number\.isSafeInteger/u);
  assert.doesNotMatch(identityContract, /ino\s*>\s*0(?!n)/u);
});

test("dist freshness excludes unrelated root artifacts and uses the authoritative five files", () => {
  assert.match(
    driverSource,
    /\.\.\.\(await listFiles\(join\(repositoryRoot, "src", "workbench-shell"\)\)\)/u,
  );
  assert.match(
    driverSource,
    /\.\.\.\(await listFiles\(join\(repositoryRoot, "src", "agent-runtime"\)\)\)/u,
  );
  assert.match(
    driverSource,
    /const rendererArtifacts = await listFiles\(join\(repositoryRoot, "dist", "renderer"\)\)/u,
  );
  assert.match(
    driverSource,
    /const artifacts = \[\s*join\(repositoryRoot, "dist", "main", "main\.js"\),\s*join\(repositoryRoot, "dist", "preload", "preload\.cjs"\),\s*\.\.\.rendererArtifacts,\s*\]/u,
  );
  assert.match(driverSource, /assert\.equal\(artifacts\.length, 5\)/u);
  assert.match(driverSource, /rendererArtifacts\.some\(\(entry\) => entry\.endsWith\("index\.html"\)\)/u);
  assert.match(driverSource, /rendererArtifacts\.some\(\(entry\) => entry\.endsWith\("\.js"\)\)/u);
  assert.match(driverSource, /rendererArtifacts\.some\(\(entry\) => entry\.endsWith\("\.css"\)\)/u);
  assert.doesNotMatch(
    driverSource,
    /listFiles\(join\(repositoryRoot, "dist"\)\)/u,
  );
  assert.doesNotMatch(driverSource, /sourceFileCount\s*:\s*\d+/u);
});

test("failure output is fixed and sanitized but retains public provider enums", () => {
  const start = driverSource.indexOf("SETTINGS_SUBSCRIPTION_AUTH_PRODUCTION_FAILURE");
  const end = driverSource.indexOf("process.exitCode = 1", start);
  assert.ok(start >= 0 && end > start);
  const failure = driverSource.slice(start, end);
  assert.match(failure, /step: primaryFailure\.step/u);
  assert.match(failure, /category: primaryFailure\.category/u);
  assert.match(failure, /providers: publicProviderObservations/u);
  assert.match(failure, /cleanup:/u);
  assert.match(failure, /publicationCleanup:/u);
  assert.doesNotMatch(failure, /\b(?:pid|path|stderr|error|credential|token|secret|password|nativeId)\b/iu);
});
