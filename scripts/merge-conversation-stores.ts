import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyConversationStoreMerge,
  assertConversationStoreReportPathSafe,
  planConversationStoreMerge,
  renderConversationStoreMergeReport,
} from "../src/workbench-shell/conversation-store-merge.ts";

interface MergeCliOptions {
  readonly baseCopyDirectory: string;
  readonly copyDirectories: readonly string[];
  readonly dryRun: boolean;
  readonly outputDirectory?: string;
  readonly reportPath?: string;
  readonly authorizationPath?: string;
}

export async function runConversationStoreMergeCli(
  args: readonly string[],
  output: { readonly write: (text: string) => void } = process.stdout,
): Promise<void> {
  const options = parseArguments(args);
  const orderedCopyDirectories = [
    options.baseCopyDirectory,
    ...options.copyDirectories,
  ];
  if (
    options.reportPath !== undefined &&
    options.outputDirectory !== undefined &&
    pathsOverlap(options.reportPath, options.outputDirectory)
  ) {
    throw new Error("conversation-store-report-overlaps-output");
  }
  if (
    options.reportPath !== undefined &&
    orderedCopyDirectories.some((directory) =>
      pathsOverlap(options.reportPath!, directory),
    )
  ) {
    throw new Error("conversation-store-report-overlaps-source");
  }
  const plan = await planConversationStoreMerge({
    copyDirectories: orderedCopyDirectories,
  });
  if (options.reportPath !== undefined) {
    await assertConversationStoreReportPathSafe({
      reportPath: options.reportPath,
      sourceDirectories: plan.sourceDirectories,
    });
    try {
      await lstat(options.reportPath);
      throw new Error("conversation-store-report-exists");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  if (!options.dryRun) {
    const authorization = await readAuthorization(options.authorizationPath!);
    await applyConversationStoreMerge({
      plan,
      outputDirectory: options.outputDirectory!,
      authorization,
    });
  }
  const report = renderConversationStoreMergeReport(plan, {
    dryRun: options.dryRun,
  });
  if (options.reportPath !== undefined) {
    const reportPath = absolutePath(
      options.reportPath,
      "conversation-store-report-path-invalid",
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await assertConversationStoreReportPathSafe({
      reportPath,
      sourceDirectories: plan.sourceDirectories,
    });
    await writeFile(reportPath, report, { encoding: "utf8", flag: "wx" });
  }
  output.write(report);
}

function parseArguments(args: readonly string[]): MergeCliOptions {
  let baseCopyDirectory: string | undefined;
  const copyDirectories: string[] = [];
  let outputDirectory: string | undefined;
  let reportPath: string | undefined;
  let authorizationPath: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("conversation-store-cli-arguments-invalid");
      dryRun = true;
      continue;
    }
    if (argument === "--base-copy") {
      const value = args[index + 1];
      if (value === undefined || baseCopyDirectory !== undefined) {
        throw new Error("conversation-store-cli-arguments-invalid");
      }
      baseCopyDirectory = absolutePath(
        value,
        "conversation-store-copy-root-invalid",
      );
      index += 1;
      continue;
    }
    if (argument === "--copy") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("conversation-store-cli-arguments-invalid");
      }
      copyDirectories.push(
        absolutePath(value, "conversation-store-copy-root-invalid"),
      );
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (value === undefined || outputDirectory !== undefined) {
        throw new Error("conversation-store-cli-arguments-invalid");
      }
      outputDirectory = absolutePath(
        value,
        "conversation-store-output-invalid",
      );
      index += 1;
      continue;
    }
    if (argument === "--report") {
      const value = args[index + 1];
      if (value === undefined || reportPath !== undefined) {
        throw new Error("conversation-store-cli-arguments-invalid");
      }
      reportPath = absolutePath(
        value,
        "conversation-store-report-path-invalid",
      );
      index += 1;
      continue;
    }
    if (argument === "--authorization") {
      const value = args[index + 1];
      if (value === undefined || authorizationPath !== undefined) {
        throw new Error("conversation-store-cli-arguments-invalid");
      }
      authorizationPath = absolutePath(
        value,
        "conversation-store-owner-authorization-invalid",
      );
      index += 1;
      continue;
    }
    throw new Error("conversation-store-cli-arguments-invalid");
  }
  if (
    baseCopyDirectory === undefined ||
    copyDirectories.length < 1 ||
    copyDirectories.length > 7 ||
    (!dryRun && outputDirectory === undefined) ||
    (dryRun && authorizationPath !== undefined)
  ) {
    throw new Error("conversation-store-cli-arguments-invalid");
  }
  if (!dryRun && authorizationPath === undefined) {
    throw new Error("conversation-store-owner-authorization-required");
  }
  return Object.freeze({
    baseCopyDirectory,
    copyDirectories: Object.freeze(copyDirectories),
    dryRun,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(authorizationPath === undefined ? {} : { authorizationPath }),
  });
}

async function readAuthorization(path: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error("conversation-store-owner-authorization-invalid");
  }
  if (bytes.length > 16_384) {
    throw new Error("conversation-store-owner-authorization-invalid");
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("conversation-store-owner-authorization-invalid");
  }
}

function absolutePath(value: string, error: string): string {
  if (!isAbsolute(value)) throw new Error(error);
  return resolve(value);
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function main(): Promise<void> {
  try {
    await runConversationStoreMergeCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown-error";
    process.stderr.write(`Conversation store merge refused: ${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
