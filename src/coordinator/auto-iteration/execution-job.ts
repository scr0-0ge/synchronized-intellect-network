import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FixedExecutionRecipe =
  | "capture-artifact"
  | "build-candidate"
  | "run-gate"
  | "read-git-state";

export type ApprovedGate =
  | "build"
  | "typecheck"
  | "test"
  | "test:rendered-surfaces"
  | "check:text-integrity";

interface JobRequestBase {
  readonly jobId: string;
  readonly inputVersion: number;
  readonly workingDirectory: string;
}

export type ExecutionJobRequest =
  | (JobRequestBase & {
      readonly recipe: "capture-artifact";
      readonly commitMessage: string;
    })
  | (JobRequestBase & {
      readonly recipe: "build-candidate";
      readonly orderedCommitShas: readonly string[];
    })
  | (JobRequestBase & {
      readonly recipe: "run-gate";
      readonly gate: ApprovedGate;
    })
  | (JobRequestBase & {
      readonly recipe: "read-git-state";
    });

export interface ExecutionJobProcess {
  readonly pid: number;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ExecutionJobLogReference {
  readonly path: string;
  readonly head: string;
  readonly tail: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export type ExecutionJobOutput =
  | {
      readonly kind: "captured-artifact";
      readonly commitSha: string;
    }
  | {
      readonly kind: "candidate-built";
      readonly commitSha: string;
      readonly mergeTreeSha: string;
    }
  | {
      readonly kind: "candidate-conflict";
      readonly conflictFiles: readonly string[];
    }
  | {
      readonly kind: "gate-result";
      readonly gate: ApprovedGate;
    }
  | {
      readonly kind: "git-state";
      readonly commitSha: string;
      readonly branch: string | null;
      readonly topLevel: string;
      readonly status: string;
    };

export interface ExecutionJobRecord {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly recipe: FixedExecutionRecipe;
  readonly inputVersion: number;
  readonly workingDirectory: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly processes: readonly ExecutionJobProcess[];
  readonly exit: { readonly code: number; readonly signal: string | null } | null;
  readonly log: ExecutionJobLogReference;
  readonly output: ExecutionJobOutput | null;
  readonly lastError: string | null;
}

export interface ExecutionJobRunner {
  run(request: ExecutionJobRequest): Promise<ExecutionJobRecord>;
  interrupt(jobId: string): Promise<boolean>;
  read(jobId: string): Promise<ExecutionJobRecord | null>;
}

interface MutableProcessRecord {
  pid: number;
  executable: string;
  arguments: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
}

interface MutableJobRecord {
  schemaVersion: 1;
  jobId: string;
  recipe: FixedExecutionRecipe;
  inputVersion: number;
  workingDirectory: string;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string | null;
  endedAt: string | null;
  processes: MutableProcessRecord[];
  exit: { code: number; signal: string | null } | null;
  log: ExecutionJobLogReference;
  output: ExecutionJobOutput | null;
  lastError: string | null;
}

interface ProcessResult {
  readonly code: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

const approvedGates: ReadonlySet<string> = new Set([
  "build",
  "typecheck",
  "test",
  "test:rendered-surfaces",
  "check:text-integrity",
]);
const fixedRecipes: ReadonlySet<string> = new Set([
  "capture-artifact",
  "build-candidate",
  "run-gate",
  "read-git-state",
]);
const processOutputLimitBytes = 1024 * 1024;

function appendCaptured(current: Buffer, chunk: Buffer): Buffer {
  if (current.byteLength >= processOutputLimitBytes) return current;
  return Buffer.concat([
    current,
    chunk.subarray(0, processOutputLimitBytes - current.byteLength),
  ]);
}

function requireIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("jobId must use letters, digits, dot, underscore, or dash");
  }
}

class BoundedLog {
  readonly edgeBytes: number;
  totalBytes = 0;
  head = Buffer.alloc(0);
  tail = Buffer.alloc(0);

  constructor(edgeBytes: number) {
    this.edgeBytes = edgeBytes;
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (this.head.byteLength < this.edgeBytes) {
      const remaining = this.edgeBytes - this.head.byteLength;
      this.head = Buffer.concat([this.head, chunk.subarray(0, remaining)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.byteLength > this.edgeBytes) {
      this.tail = this.tail.subarray(this.tail.byteLength - this.edgeBytes);
    }
  }

  reference(path: string): ExecutionJobLogReference {
    return {
      path,
      head: this.head.toString("utf8"),
      tail: this.tail.toString("utf8"),
      truncated: this.totalBytes > this.edgeBytes * 2,
      totalBytes: this.totalBytes,
    };
  }

  fileContents(): Buffer {
    if (this.totalBytes <= this.edgeBytes) return this.head;
    if (this.totalBytes <= this.edgeBytes * 2) {
      const overlap = this.edgeBytes * 2 - this.totalBytes;
      return Buffer.concat([this.head, this.tail.subarray(overlap)]);
    }
    return Buffer.concat([this.head, Buffer.from("\n--- bounded log tail ---\n"), this.tail]);
  }
}

function processError(result: ProcessResult): string {
  if (result.stdoutTruncated || result.stderrTruncated) {
    return "process output exceeded the fixed capture bound";
  }
  return (result.stderr.trim() || result.stdout.trim() || `process exited ${result.code}`).slice(
    0,
    4096,
  );
}

function assertCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`build-candidate requires a full git commit SHA: ${value}`);
  }
}

export function createExecutionJobRunner(options: {
  readonly recordsRoot: string;
  readonly logEdgeBytes?: number;
}): ExecutionJobRunner {
  const edgeBytes = options.logEdgeBytes ?? 16 * 1024;
  if (!Number.isInteger(edgeBytes) || edgeBytes <= 0) {
    throw new Error("logEdgeBytes must be a positive integer");
  }
  let initialized: Promise<{ recordsRoot: string; logsRoot: string }> | undefined;
  const active = new Map<string, ChildProcessWithoutNullStreams>();
  const interrupted = new Set<string>();

  const initialize = () => {
    initialized ??= (async () => {
      await mkdir(options.recordsRoot, { recursive: true });
      const recordsRoot = await realpath(options.recordsRoot);
      const logsRoot = join(recordsRoot, "logs");
      await mkdir(logsRoot, { recursive: true });
      return { recordsRoot, logsRoot };
    })();
    return initialized;
  };

  async function paths(jobId: string): Promise<{ record: string; log: string }> {
    requireIdentifier(jobId);
    const roots = await initialize();
    return {
      record: join(roots.recordsRoot, `${jobId}.json`),
      log: join(roots.logsRoot, `${jobId}.log`),
    };
  }

  async function persist(record: MutableJobRecord, log: BoundedLog): Promise<void> {
    const jobPaths = await paths(record.jobId);
    record.log = log.reference(jobPaths.log);
    await writeFile(jobPaths.log, log.fileContents());
    const pendingRecordPath = `${jobPaths.record}.writing`;
    await writeFile(pendingRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    // Windows can briefly deny a rename over an existing destination while a
    // scanner holds it (observed as transient EPERM/EBUSY). The replace stays
    // atomic; only the retry window is bounded.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(pendingRecordPath, jobPaths.record);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= 10 ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  async function read(jobId: string): Promise<MutableJobRecord | null> {
    try {
      return JSON.parse(await readFile((await paths(jobId)).record, "utf8")) as MutableJobRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function runProcess(
    record: MutableJobRecord,
    log: BoundedLog,
    executable: string,
    args: readonly string[],
  ): Promise<ProcessResult> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd: record.workingDirectory,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return {
        code: -1,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }

    const processRecord: MutableProcessRecord = {
      pid: child.pid ?? -1,
      executable,
      arguments: [...args],
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      signal: null,
    };
    record.processes.push(processRecord);
    active.set(record.jobId, child);
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      stdout = appendCaptured(stdout, bytes);
      log.append(bytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      stderr = appendCaptured(stderr, bytes);
      log.append(bytes);
    });
    child.stdin.end();

    const completion = new Promise<ProcessResult>((resolveResult) => {
      let settled = false;
      const finish = (code: number, signal: string | null, extraError = "") => {
        if (settled) return;
        settled = true;
        active.delete(record.jobId);
        processRecord.endedAt = new Date().toISOString();
        processRecord.exitCode = code;
        processRecord.signal = signal;
        if (extraError) {
          const bytes = Buffer.from(extraError, "utf8");
          stderrBytes += bytes.byteLength;
          stderr = appendCaptured(stderr, bytes);
          log.append(bytes);
        }
        resolveResult({
          code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          stdoutTruncated: stdoutBytes > processOutputLimitBytes,
          stderrTruncated: stderrBytes > processOutputLimitBytes,
        });
      };
      child.once("error", (error) => finish(-1, null, error.message));
      child.once("close", (code, signal) => finish(code ?? -1, signal));
    });
    await persist(record, log);
    const result = await completion;
    await persist(record, log);
    return result;
  }

  async function git(
    record: MutableJobRecord,
    log: BoundedLog,
    args: readonly string[],
  ): Promise<ProcessResult> {
    return runProcess(record, log, "git", args);
  }

  async function execute(
    request: ExecutionJobRequest,
    record: MutableJobRecord,
    log: BoundedLog,
  ): Promise<{ succeeded: boolean; output: ExecutionJobOutput | null; exit: ProcessResult }> {
    if (request.recipe === "capture-artifact") {
      const staged = await git(record, log, ["add", "--all"]);
      if (staged.code !== 0) return { succeeded: false, output: null, exit: staged };
      const changed = await git(record, log, ["diff", "--cached", "--quiet"]);
      if (changed.code !== 0 && changed.code !== 1) {
        return { succeeded: false, output: null, exit: changed };
      }
      if (changed.code === 1) {
        const committed = await git(record, log, [
          "commit",
          "--message",
          request.commitMessage,
        ]);
        if (committed.code !== 0) return { succeeded: false, output: null, exit: committed };
      }
      const resolved = await git(record, log, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (resolved.code !== 0) return { succeeded: false, output: null, exit: resolved };
      const clean = await git(record, log, ["status", "--porcelain"]);
      if (clean.code !== 0 || clean.stdout.trim().length > 0) {
        return {
          succeeded: false,
          output: null,
          exit:
            clean.code === 0
              ? { ...clean, code: 1, stderr: "workspace remained dirty after capture" }
              : clean,
        };
      }
      return {
        succeeded: true,
        output: { kind: "captured-artifact", commitSha: resolved.stdout.trim() },
        exit: clean,
      };
    }

    if (request.recipe === "build-candidate") {
      for (const commitSha of request.orderedCommitShas) assertCommitSha(commitSha);
      let last: ProcessResult = {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
      for (const commitSha of request.orderedCommitShas) {
        last = await git(record, log, ["merge", "--no-ff", "--no-edit", commitSha]);
        if (last.code !== 0) {
          const conflicts = await git(record, log, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          const conflictFiles = conflicts.stdout
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .filter(Boolean)
            .sort();
          return conflictFiles.length > 0 && !conflicts.stdoutTruncated
            ? {
                succeeded: false,
                output: { kind: "candidate-conflict", conflictFiles },
                exit: last,
              }
            : { succeeded: false, output: null, exit: last };
        }
      }
      const head = await git(record, log, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head.code !== 0) return { succeeded: false, output: null, exit: head };
      const tree = await git(record, log, ["rev-parse", "--verify", "HEAD^{tree}"]);
      if (tree.code !== 0) return { succeeded: false, output: null, exit: tree };
      return {
        succeeded: true,
        output: {
          kind: "candidate-built",
          commitSha: head.stdout.trim(),
          mergeTreeSha: tree.stdout.trim(),
        },
        exit: tree,
      };
    }

    if (request.recipe === "run-gate") {
      const command =
        request.gate === "check:text-integrity"
          ? "call .\\pnpm.bat exec node scripts/check-text-integrity.ts"
          : `call .\\pnpm.bat ${request.gate}`;
      const shell = process.env.ComSpec ?? "cmd.exe";
      const result = await runProcess(record, log, shell, ["/d", "/s", "/c", command]);
      return {
        succeeded: result.code === 0,
        output: { kind: "gate-result", gate: request.gate },
        exit: result,
      };
    }

    const status = await git(record, log, ["status", "--short", "--branch"]);
    if (status.code !== 0 || status.stdoutTruncated) {
      return { succeeded: false, output: null, exit: status };
    }
    const head = await git(record, log, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head.code !== 0) return { succeeded: false, output: null, exit: head };
    const topLevel = await git(record, log, ["rev-parse", "--show-toplevel"]);
    if (topLevel.code !== 0) return { succeeded: false, output: null, exit: topLevel };
    const branch = await git(record, log, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (branch.code !== 0 && branch.code !== 1) {
      return { succeeded: false, output: null, exit: branch };
    }
    return {
      succeeded: true,
      output: {
        kind: "git-state",
        commitSha: head.stdout.trim(),
        branch: branch.code === 0 ? branch.stdout.trim() : null,
        topLevel: topLevel.stdout.trim(),
        status: status.stdout,
      },
      exit: branch.code === 1 ? { ...branch, code: 0 } : branch,
    };
  }

  return {
    async run(request) {
      requireIdentifier(request.jobId);
      if (!fixedRecipes.has(request.recipe as string)) {
        throw new Error(`unsupported execution recipe: ${String(request.recipe)}`);
      }
      if (
        request.recipe === "run-gate" &&
        !approvedGates.has(request.gate as string)
      ) {
        throw new Error(`unsupported gate: ${String(request.gate)}`);
      }
      if (await read(request.jobId)) {
        throw new Error(`job already has a durable record: ${request.jobId}`);
      }
      const workingDirectory = await realpath(request.workingDirectory);
      const logPath = (await paths(request.jobId)).log;
      const log = new BoundedLog(edgeBytes);
      const record: MutableJobRecord = {
        schemaVersion: 1,
        jobId: request.jobId,
        recipe: request.recipe,
        inputVersion: request.inputVersion,
        workingDirectory,
        status: "queued",
        startedAt: null,
        endedAt: null,
        processes: [],
        exit: null,
        log: log.reference(logPath),
        output: null,
        lastError: null,
      };
      await persist(record, log);
      record.status = "running";
      record.startedAt = new Date().toISOString();
      await persist(record, log);

      let result: Awaited<ReturnType<typeof execute>>;
      try {
        result = await execute(request, record, log);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.append(Buffer.from(detail, "utf8"));
        result = {
          succeeded: false,
          output: null,
          exit: {
            code: -1,
            signal: null,
            stdout: "",
            stderr: detail,
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        };
      }
      record.output = result.output;
      record.exit = { code: result.exit.code, signal: result.exit.signal };
      record.endedAt = new Date().toISOString();
      if (interrupted.delete(request.jobId)) {
        record.status = "interrupted";
        record.lastError = "job interrupted";
      } else if (result.succeeded) {
        record.status = "succeeded";
      } else {
        record.status = "failed";
        record.lastError = processError(result.exit);
      }
      await persist(record, log);
      return structuredClone(record);
    },

    async interrupt(jobId) {
      requireIdentifier(jobId);
      const child = active.get(jobId);
      if (!child || child.pid === undefined) return false;
      interrupted.add(jobId);
      if (process.platform === "win32") {
        await new Promise<void>((resolveInterrupt) => {
          execFile(
            "taskkill",
            ["/pid", String(child.pid), "/t", "/f"],
            { windowsHide: true },
            () => resolveInterrupt(),
          );
        });
      } else {
        child.kill("SIGTERM");
      }
      return true;
    },

    async read(jobId) {
      const record = await read(jobId);
      return record === null ? null : structuredClone(record);
    },
  };
}
