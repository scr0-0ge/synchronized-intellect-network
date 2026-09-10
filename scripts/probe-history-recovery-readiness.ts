/**
 * Read-only desktop probe for the current and historical Workbench stores.
 *
 * It never copies or preserves a store, changes an ACL, or opens a ledger in
 * ordinary SQLite locking mode. Ledger counts use SQLite's immutable URI mode
 * only when no live transaction sidecar is present. Output is deliberately
 * limited to fixed store paths, counts, ACL results, path budget, and discovery
 * results; native errors and private filenames are never printed.
 */
import { spawnSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const hostDirectoryName = "workbench-project-host";
const currentIdentityName = "synchronized-intellect-network";
const verifiedRecoveryPathLength = 1_024;
const standardLedgerName =
  "project-ledger-v1-00000000-0000-4000-8000-000000000000.sqlite";
const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumFilesPerSource = 4_096;
const maximumTraversalDepth = 8;
const maximumFileBytes = 4 * 1_024 * 1_024 * 1_024;
const maximumSourceBytes = 8 * 1_024 * 1_024 * 1_024;

interface Candidate {
  readonly label: string;
  readonly role: "current" | "historical";
  readonly identityPath: string;
  readonly hostPath: string;
}

interface EntryMetadata {
  readonly relativePath: string;
  readonly kind: "directory" | "file";
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNanoseconds: bigint;
  readonly ctimeNanoseconds: bigint;
  readonly birthtimeNanoseconds: bigint;
}

interface TreeInspection {
  readonly entries: readonly EntryMetadata[];
  readonly maximumPathLength: number;
}

interface Counts {
  readonly projects: number | null;
  readonly sessions: number | null;
  readonly commands: number | null;
}

interface CandidateResult {
  readonly candidate: Candidate;
  readonly identityExists: boolean | null;
  readonly hostExists: boolean | null;
  readonly identityOwnerOnly: boolean | null;
  readonly hostOwnerOnly: boolean | null;
  readonly counts: Counts;
  readonly maximumPathLength: number;
  readonly readerPathLength: number;
  readonly pathMargin: number;
  readonly physicalKey: string | null;
  readonly preflightPassed: boolean;
  duplicate: boolean;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("发现结果: 本探测只支持 Windows");
    console.log("结论: 探测未完成");
    process.exitCode = 1;
    return;
  }
  const appDataValue = process.env.APPDATA;
  if (appDataValue === undefined || appDataValue.trim().length === 0) {
    console.log("发现结果: APPDATA 路径不可用");
    console.log("结论: 探测未完成");
    process.exitCode = 1;
    return;
  }

  const appData = resolve(appDataValue);
  const candidates = candidatePaths(appData);
  const results: CandidateResult[] = [];
  for (const candidate of candidates) {
    results.push(await inspectCandidate(candidate, appData));
  }
  markPhysicalDuplicates(results);

  console.log("历史库只读发现结果");
  for (const result of results) printCandidate(result);
  await printRecoveryTarget(appData);

  const discovered = results.filter(
    (result) =>
      result.candidate.role === "historical" &&
      result.hostExists === true &&
      result.physicalKey !== null &&
      !result.duplicate,
  ).length;
  console.log(
    discovered === 0
      ? "\n结论: 一个历史库都发现不到"
      : `\n结论: 能发现 ${discovered} 个历史库`,
  );
}

function candidatePaths(appData: string): readonly Candidate[] {
  const candidate = (
    label: string,
    role: "current" | "historical",
    identityName: string,
  ): Candidate => {
    const identityPath = join(appData, identityName);
    return Object.freeze({
      label,
      role,
      identityPath,
      hostPath: join(identityPath, hostDirectoryName),
    });
  };
  return Object.freeze([
    candidate("当前身份 synchronized-intellect-network", "current", currentIdentityName),
    candidate("历史身份 Electron", "historical", "Electron"),
    candidate(
      "历史身份 unified-agent-workbench",
      "historical",
      "unified-agent-workbench",
    ),
    candidate(
      "历史身份 Unified Agent Workbench",
      "historical",
      "Unified Agent Workbench",
    ),
  ]);
}

async function inspectCandidate(
  candidate: Candidate,
  appData: string,
): Promise<CandidateResult> {
  const identityExists = await directoryExists(candidate.identityPath, false);
  const hostExists = await directoryExists(candidate.hostPath, true);
  const identityOwnerOnly = identityExists === true
    ? await readOwnerOnlyAcl(candidate.identityPath)
    : null;
  const hostOwnerOnly = hostExists === true
    ? await readOwnerOnlyAcl(candidate.hostPath)
    : null;
  let counts: Counts = { projects: 0, sessions: 0, commands: 0 };
  let maximumPathLength = candidate.hostPath.length;
  let physicalKey: string | null = null;
  let preflightPassed = false;
  let longestLedgerNameLength = standardLedgerName.length;

  if (hostExists === true) {
    try {
      const hostInformation = await lstat(candidate.hostPath, { bigint: true });
      const resolvedHost = await realpath(candidate.hostPath);
      const resolvedInformation = await lstat(resolvedHost, { bigint: true });
      if (
        !hostInformation.isDirectory() ||
        hostInformation.isSymbolicLink() ||
        !resolvedInformation.isDirectory() ||
        resolvedInformation.isSymbolicLink() ||
        !sameIdentity(hostInformation, resolvedInformation)
      ) {
        throw new Error("not-a-stable-directory");
      }
      physicalKey = resolvedInformation.ino === 0n
        ? resolvedHost.toLocaleLowerCase("en-US")
        : `${resolvedInformation.dev}:${resolvedInformation.ino}`;
      const before = await inspectTree(candidate.hostPath);
      maximumPathLength = before.maximumPathLength;
      const counted = await readCounts(candidate.hostPath);
      counts = counted.counts;
      longestLedgerNameLength = counted.longestLedgerNameLength;
      const after = await inspectTree(candidate.hostPath);
      preflightPassed = sameTree(before.entries, after.entries);
      if (!preflightPassed) {
        counts = { projects: null, sessions: null, commands: null };
      }
      maximumPathLength = Math.max(
        before.maximumPathLength,
        after.maximumPathLength,
      );
    } catch {
      counts = { projects: null, sessions: null, commands: null };
      preflightPassed = false;
    }
  }

  const readerPathLength = estimatedReaderPathLength(
    appData,
    longestLedgerNameLength,
  );
  const pathMargin = verifiedRecoveryPathLength - readerPathLength;
  if (pathMargin < 0) preflightPassed = false;
  return {
    candidate,
    identityExists,
    hostExists,
    identityOwnerOnly,
    hostOwnerOnly,
    counts,
    maximumPathLength,
    readerPathLength,
    pathMargin,
    physicalKey,
    preflightPassed,
    duplicate: false,
  };
}

async function directoryExists(
  path: string,
  rejectLink: boolean,
): Promise<boolean | null> {
  try {
    const information = await lstat(path);
    return information.isDirectory() && (!rejectLink || !information.isSymbolicLink());
  } catch (error) {
    return isMissing(error) ? false : null;
  }
}

async function inspectTree(root: string): Promise<TreeInspection> {
  const entries: EntryMetadata[] = [];
  let maximumPathLength = root.length;
  let totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maximumTraversalDepth) throw new Error("tree-too-deep");
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const child of children) {
      if (entries.length >= maximumFilesPerSource) {
        throw new Error("too-many-entries");
      }
      const path = join(directory, child.name);
      maximumPathLength = Math.max(maximumPathLength, path.length);
      const information = await lstat(path, { bigint: true });
      if (information.isSymbolicLink()) throw new Error("linked-entry");
      const relativePath = relative(root, path).split(sep).join("/");
      if (information.isDirectory()) {
        entries.push(metadata(relativePath, "directory", information));
        await visit(path, depth + 1);
        continue;
      }
      if (!information.isFile()) throw new Error("unsupported-entry");
      if (information.size > BigInt(maximumFileBytes)) {
        throw new Error("file-too-large");
      }
      totalBytes += Number(information.size);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumSourceBytes) {
        throw new Error("store-too-large");
      }
      const handle = await open(path, "r");
      try {
        const openedInformation = await handle.stat({ bigint: true });
        if (!openedInformation.isFile() || !sameIdentity(information, openedInformation)) {
          throw new Error("file-changed");
        }
      } finally {
        await handle.close();
      }
      entries.push(metadata(relativePath, "file", information));
    }
  };
  await visit(root, 0);
  return Object.freeze({
    entries: Object.freeze(entries),
    maximumPathLength,
  });
}

function metadata(
  relativePath: string,
  kind: "directory" | "file",
  information: BigIntStats,
): EntryMetadata {
  return Object.freeze({
    relativePath,
    kind,
    device: information.dev,
    inode: information.ino,
    size: information.size,
    mtimeNanoseconds: information.mtimeNs,
    ctimeNanoseconds: information.ctimeNs,
    birthtimeNanoseconds: information.birthtimeNs,
  });
}

function sameTree(
  before: readonly EntryMetadata[],
  after: readonly EntryMetadata[],
): boolean {
  return before.length === after.length && before.every((entry, index) => {
    const other = after[index];
    return other !== undefined &&
      entry.relativePath === other.relativePath &&
      entry.kind === other.kind &&
      entry.device === other.device &&
      entry.inode === other.inode &&
      entry.size === other.size &&
      entry.mtimeNanoseconds === other.mtimeNanoseconds &&
      entry.ctimeNanoseconds === other.ctimeNanoseconds &&
      entry.birthtimeNanoseconds === other.birthtimeNanoseconds;
  });
}

async function readCounts(root: string): Promise<{
  readonly counts: Counts;
  readonly longestLedgerNameLength: number;
}> {
  const registryPath = join(root, "project-registry-v1.json");
  let records: readonly { readonly ledgerSlot: string }[];
  try {
    const information = await lstat(registryPath);
    if (!information.isFile() || information.isSymbolicLink() || information.size > 256 * 1_024) {
      throw new Error("invalid-registry");
    }
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as {
      readonly records?: unknown;
    };
    if (!Array.isArray(parsed.records) || parsed.records.length > 1_000) {
      throw new Error("invalid-registry");
    }
    const seen = new Set<string>();
    records = parsed.records.map((value) => {
      if (typeof value !== "object" || value === null) {
        throw new Error("invalid-registry");
      }
      const ledgerSlot = (value as { readonly ledgerSlot?: unknown }).ledgerSlot;
      if (
        typeof ledgerSlot !== "string" ||
        !ledgerSlotPattern.test(ledgerSlot) ||
        seen.has(ledgerSlot)
      ) {
        throw new Error("invalid-registry");
      }
      seen.add(ledgerSlot);
      return Object.freeze({ ledgerSlot });
    });
  } catch {
    return {
      counts: { projects: null, sessions: null, commands: null },
      longestLedgerNameLength: standardLedgerName.length,
    };
  }

  let sessions = 0;
  let commands = 0;
  let longestLedgerNameLength = standardLedgerName.length;
  for (const record of records) {
    const ledgerName = `${record.ledgerSlot}.sqlite`;
    longestLedgerNameLength = Math.max(longestLedgerNameLength, ledgerName.length);
    const ledgerPath = join(root, "project-ledgers", ledgerName);
    if (
      (await entryExists(`${ledgerPath}-wal`)) ||
      (await entryExists(`${ledgerPath}-shm`)) ||
      (await entryExists(`${ledgerPath}-journal`)) ||
      ledgerPath.length >= 260
    ) {
      return {
        counts: { projects: records.length, sessions: null, commands: null },
        longestLedgerNameLength,
      };
    }
    let database: DatabaseSync | undefined;
    try {
      const uri = `${pathToFileURL(ledgerPath).href}?mode=ro&immutable=1`;
      database = new DatabaseSync(uri, {
        readOnly: true,
        enableForeignKeyConstraints: false,
      });
      const projectRows = readCount(database, "projects");
      if (projectRows !== 1) throw new Error("invalid-project-count");
      sessions += readCount(database, "sessions");
      commands += readCount(database, "commands");
    } catch {
      return {
        counts: { projects: records.length, sessions: null, commands: null },
        longestLedgerNameLength,
      };
    } finally {
      database?.close();
    }
  }
  return {
    counts: { projects: records.length, sessions, commands },
    longestLedgerNameLength,
  };
}

function readCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
    | { readonly count?: unknown }
    | undefined;
  if (
    row === undefined ||
    typeof row.count !== "number" ||
    !Number.isSafeInteger(row.count) ||
    row.count < 0
  ) {
    throw new Error("invalid-count");
  }
  return row.count;
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function estimatedReaderPathLength(
  appData: string,
  ledgerNameLength: number,
): number {
  const placeholder = "x".repeat(ledgerNameLength);
  return join(
    appData,
    currentIdentityName,
    "history-recovery-v1",
    "recovery-intake-v1",
    "reader-XXXXXX",
    "copy",
    "project-ledgers",
    placeholder,
  ).length;
}

function markPhysicalDuplicates(results: CandidateResult[]): void {
  const currentKeys = new Set(
    results
      .filter((result) => result.candidate.role === "current")
      .flatMap((result) => result.physicalKey === null ? [] : [result.physicalKey]),
  );
  const historicalKeys = new Set<string>();
  for (const result of results) {
    if (result.candidate.role !== "historical" || result.physicalKey === null) continue;
    if (currentKeys.has(result.physicalKey) || historicalKeys.has(result.physicalKey)) {
      result.duplicate = true;
    } else {
      historicalKeys.add(result.physicalKey);
    }
  }
}

function printCandidate(result: CandidateResult): void {
  console.log(`\n[${result.candidate.label}]`);
  console.log(`身份路径: ${result.candidate.identityPath}`);
  console.log(`身份根存在: ${yesNoUnknown(result.identityExists)}`);
  console.log(`库路径: ${result.candidate.hostPath}`);
  console.log(`workbench-project-host 存在: ${yesNoUnknown(result.hostExists)}`);
  console.log(
    `Project: ${countText(result.counts.projects)} | ` +
      `Session: ${countText(result.counts.sessions)} | ` +
      `Command: ${countText(result.counts.commands)}`,
  );
  console.log(`身份根 ACL owner-only: ${aclText(result.identityOwnerOnly)}`);
  console.log(`库 ACL owner-only: ${aclText(result.hostOwnerOnly)}`);
  console.log(`实际最长路径长度: ${result.maximumPathLength}`);
  console.log(`保全读取路径预计长度: ${result.readerPathLength}`);
  console.log(`Lane 75 新路径余量: 至少 ${Math.max(0, result.pathMargin)}`);
  if (result.hostExists !== true || result.physicalKey === null) {
    console.log("发现结果: 未发现");
  } else if (result.duplicate) {
    console.log("发现结果: 同一物理库已由前一个身份发现");
  } else if (result.candidate.role === "current") {
    console.log("发现结果: 当前库可发现 | 保全动作: 不适用");
  } else {
    console.log(
      result.preflightPassed
        ? "发现结果: 可发现 | 保全预检: 通过"
        : "发现结果: 可发现 | 保全预检: 未通过",
    );
  }
}

async function printRecoveryTarget(appData: string): Promise<void> {
  const path = join(
    appData,
    currentIdentityName,
    "history-recovery-v1",
  );
  const exists = await directoryExists(path, true);
  const ownerOnly = exists === true ? await readOwnerOnlyAcl(path) : null;
  console.log("\n[保全目标]");
  console.log(`路径: ${path}`);
  console.log(`存在: ${yesNoUnknown(exists)}`);
  console.log(`ACL owner-only: ${aclText(ownerOnly)}`);
  console.log(
    exists === true && ownerOnly === true
      ? "发现结果: 保全目标 owner-only 已就绪"
      : exists === false
        ? "发现结果: 保全目标尚未建立；产品执行前会建立并验证 owner-only"
        : "发现结果: 保全目标当前未通过 owner-only 读回；产品不会在验证通过前保全",
  );
}

function yesNoUnknown(value: boolean | null): string {
  return value === null ? "无法确认" : value ? "是" : "否";
}

function aclText(value: boolean | null): string {
  return value === null ? "不适用" : value ? "是" : "否";
}

function countText(value: number | null): string {
  return value === null ? "纯只读边界内无法确认" : String(value);
}

function sameIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

const readOwnerOnlyAclScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$entry = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $entry.path -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) { 'not-owner-only'; exit }
$acl = [IO.Directory]::GetAccessControl($entry.path)
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$valid = $acl.AreAccessRulesProtected -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid) -and $rules.Count -eq 1
if ($valid) {
  $rule = $rules[0]
  $valid = $rule.IdentityReference.Equals($sid) -and
    $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    -not $rule.IsInherited -and $rule.InheritanceFlags -eq $inheritance -and
    $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
}
if ($valid) { 'owner-only' } else { 'not-owner-only' }
`;

async function readOwnerOnlyAcl(path: string): Promise<boolean> {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(readOwnerOnlyAclScript, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      input: JSON.stringify({ path }),
      maxBuffer: 64 * 1_024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return result.status === 0 && result.stdout.trim() === "owner-only";
}

main().catch(() => {
  console.log("发现结果: 只读探测未完成");
  console.log("结论: 探测未完成");
  process.exitCode = 1;
});
