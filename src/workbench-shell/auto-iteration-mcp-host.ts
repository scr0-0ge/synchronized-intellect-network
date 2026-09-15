import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  AutoIterationMcpServer,
  JsonRpcRequest,
} from "./auto-iteration-mcp-server.ts";

/**
 * Host side of the Workbench MCP bootstrap bridge (issue #8, ADR-0023).
 *
 * A CLI session process cannot reach the coordinator port directly: the port
 * lives in the main process and its Session identity must stay host-owned.
 * This module gives each bound Agent Session one private Windows named pipe.
 * The CLI spawns the standalone bootstrap entry with the pipe name and a
 * one-shot token; the bootstrap connects, presents the token, and forwards
 * MCP stdio frames verbatim. The pipe hands each JSON-RPC frame to the SAME
 * in-process server the product already uses (`AutoIterationMcpServer`), so
 * there is no second MCP implementation and no port, credential, or absolute
 * host path ever crosses the wire.
 *
 * Deliberate limits (owner ruling: single connection, no reconnect): a
 * binding accepts exactly ONE connection. A second connection is refused and
 * diagnosed. When that connection ends, the binding is spent and the pipe
 * closes; a Session that is started again gets a fresh binding through the
 * adapter's start/resume seam.
 *
 * Deferred association (supervisor ruling): the binding for a START is
 * created before the Session id exists, so the pipe may accept its connection
 * before anyone knows which Session it serves. Frames received in that window
 * are buffered (bounded) and replayed once `associate` names the Session; if
 * association never comes within the bound, the connection is dropped and
 * diagnosed. Nothing is cached without limit.
 */

/** The stdio server spec a CLI receives in its per-Session MCP configuration. */
export interface AutoIterationMcpBootstrapSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface AutoIterationMcpPipeBinding {
  /** Undefined until the host learns which Session this binding serves. */
  readonly sessionId: string | undefined;
  readonly pipeName: string;
  /** Host-generated one-shot token; the model never supplies or sees it. */
  readonly token: string;
  /** What the adapter puts into the CLI's MCP configuration for this Session. */
  readonly bootstrap: AutoIterationMcpBootstrapSpec;
}

export type AutoIterationMcpPipeDiagnostic =
  | { readonly kind: "second-connection-refused"; readonly pipeName: string }
  | { readonly kind: "binding-token-mismatch"; readonly pipeName: string }
  | {
      readonly kind: "binding-frame-invalid";
      readonly pipeName: string;
      readonly reason: string;
    }
  | { readonly kind: "connection-closed"; readonly pipeName: string }
  | { readonly kind: "binding-closed"; readonly pipeName: string }
  | {
      readonly kind: "association-timeout";
      readonly pipeName: string;
    }
  | {
      readonly kind: "association-buffer-overflow";
      readonly pipeName: string;
    }
  | { readonly kind: "reservation-expired"; readonly pipeName: string }
  | { readonly kind: "reservation-released"; readonly pipeName: string }
  | { readonly kind: "registry-unavailable" }
  | {
      readonly kind: "request-failed";
      readonly pipeName: string;
      readonly message: string;
    };

export interface AutoIterationMcpPipeHostOptions {
  /**
   * Absolute path of the standalone bootstrap entry the CLI's runtime executes
   * (`dist/main/auto-iteration-mcp-bootstrap.js`; the packaged location is a
   * host decision, not a bootstrap one).
   */
  readonly bootstrapEntry: string;
  /**
   * Executable that runs the bootstrap entry. Defaults to `process.execPath`:
   * in development and tests that is a real Node; in the packaged app it is
   * the Electron binary, which becomes plain Node under
   * `ELECTRON_RUN_AS_NODE=1` (always sent in the spec env).
   */
  readonly bootstrapCommand?: string;
  /** The per-Session in-process server the pipe forwards frames to. */
  serverForSession(sessionId: string): AutoIterationMcpServer;
  onDiagnostic?(diagnostic: AutoIterationMcpPipeDiagnostic): void;
  /** Bounded buffering while a binding waits for its Session (default 30s). */
  readonly associationTimeoutMilliseconds?: number;
  /** Frame-count bound of the pre-association buffer (default 512). */
  readonly associationMaxBufferedFrames?: number;
  /** Byte bound of the pre-association buffer (default 262144). */
  readonly associationMaxBufferedBytes?: number;
}

interface OpenBinding {
  readonly binding: AutoIterationMcpPipeBinding;
  readonly server: Server;
  connection: Socket | undefined;
  sessionId: string | undefined;
  bufferedFrames: string[];
  bufferedBytes: number;
  associationTimer: NodeJS.Timeout | undefined;
  spent: boolean;
}

const pipeNamePrefix = "\\\\.\\pipe\\synchronized-intellect-network-mcp";
const tokenBytes = 24;
const packagedBootstrapRelativePath = [
  "workbench-bootstrap",
  "auto-iteration-mcp-bootstrap.js",
] as const;

function packagedBootstrapEntry(): string | undefined {
  // Under Node-based guards `require("electron")` is the executable path,
  // while in Electron's main process it is the API object. Keep the production
  // branch on Electron's own `app.isPackaged` fact without making those guards
  // load an Electron main-process API.
  const electron = createRequire(import.meta.url)("electron") as unknown;
  const app =
    typeof electron === "object" && electron !== null && "app" in electron
      ? (electron as { readonly app?: { readonly isPackaged?: unknown } }).app
      : undefined;
  return app?.isPackaged === true
    ? join(process.resourcesPath, ...packagedBootstrapRelativePath)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcInternalError(id: unknown, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32603, message },
  });
}

function rpcInvalidRequest(id: unknown, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32600, message },
  });
}

export interface AutoIterationMcpPipeHost {
  /**
   * Creates a pipe and binding. With a Session id the binding serves
   * immediately; without one it buffers (bounded) until `associate`.
   */
  openBinding(sessionId?: string): AutoIterationMcpPipeBinding;
  /** Names the Session a deferred binding serves; false when it cannot. */
  associate(binding: AutoIterationMcpPipeBinding, sessionId: string): boolean;
  /** Closes one binding (by binding object); safe to call repeatedly. */
  closeBinding(binding: AutoIterationMcpPipeBinding): void;
  /** Closes every binding; the host cannot be reused afterwards. */
  close(): void;
}

export function createAutoIterationMcpPipeHost(
  options: AutoIterationMcpPipeHostOptions,
): AutoIterationMcpPipeHost {
  const bootstrapEntry = packagedBootstrapEntry() ?? options.bootstrapEntry;
  const bootstrapCommand = options.bootstrapCommand ?? process.execPath;
  const associationTimeoutMilliseconds =
    options.associationTimeoutMilliseconds ?? 30_000;
  const maxBufferedFrames = options.associationMaxBufferedFrames ?? 512;
  const maxBufferedBytes = options.associationMaxBufferedBytes ?? 256 * 1024;
  const bindingsByPipe = new Map<string, OpenBinding>();
  let closed = false;

  function report(diagnostic: AutoIterationMcpPipeDiagnostic): void {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics never control the bridge.
    }
  }

  function clearAssociationTimer(open: OpenBinding): void {
    if (open.associationTimer !== undefined) {
      clearTimeout(open.associationTimer);
      open.associationTimer = undefined;
    }
  }

  function closeOpenBinding(
    open: OpenBinding,
    reason: "binding-closed" | "connection-closed",
  ): void {
    if (open.spent) return;
    open.spent = true;
    clearAssociationTimer(open);
    open.bufferedFrames = [];
    open.connection?.destroy();
    open.connection = undefined;
    open.server.close(() => undefined);
    bindingsByPipe.delete(open.binding.pipeName);
    report({ kind: reason, pipeName: open.binding.pipeName });
  }

  function dispatch(
    open: OpenBinding,
    server: AutoIterationMcpServer,
    line: string,
    socket: Socket,
  ): void {
    let request: JsonRpcRequest;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.write(rpcInvalidRequest(undefined, "parse error") + "\n");
      return;
    }
    if (
      !isRecord(parsed) ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      socket.write(rpcInvalidRequest(undefined, "invalid request") + "\n");
      return;
    }
    request = parsed as unknown as JsonRpcRequest;
    void server
      .handle(request)
      .then((response) => {
        if (response === null) return;
        socket.write(JSON.stringify(response) + "\n");
      })
      .catch((error: unknown) => {
        report({
          kind: "request-failed",
          pipeName: open.binding.pipeName,
          message: error instanceof Error ? error.message : String(error),
        });
        socket.write(
          rpcInternalError(request.id ?? null, "internal error") + "\n",
        );
      });
  }

  function startAssociationTimer(open: OpenBinding): void {
    if (open.sessionId !== undefined || open.associationTimer !== undefined) {
      return;
    }
    open.associationTimer = setTimeout(() => {
      open.associationTimer = undefined;
      report({ kind: "association-timeout", pipeName: open.binding.pipeName });
      closeOpenBinding(open, "binding-closed");
    }, associationTimeoutMilliseconds);
  }

  function serveConnection(open: OpenBinding, socket: Socket): void {
    open.connection = socket;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let authenticated = false;

    socket.on("error", () => undefined);
    socket.on("close", () => {
      lines.close();
      closeOpenBinding(open, "connection-closed");
    });

    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      if (!authenticated) {
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          socket.destroy();
          report({
            kind: "binding-frame-invalid",
            pipeName: open.binding.pipeName,
            reason: "first frame is not JSON",
          });
          return;
        }
        const token = isRecord(frame) && frame.type === "binding-hello"
          ? frame.token
          : undefined;
        if (token !== open.binding.token) {
          socket.destroy();
          report({
            kind: "binding-token-mismatch",
            pipeName: open.binding.pipeName,
          });
          return;
        }
        authenticated = true;
        // The CLI may reach us before the host knows the Session id; the
        // wait is bounded from the first authenticated traffic.
        startAssociationTimer(open);
        return;
      }
      if (open.sessionId === undefined) {
        if (
          open.bufferedFrames.length >= maxBufferedFrames ||
          open.bufferedBytes + line.length > maxBufferedBytes
        ) {
          report({
            kind: "association-buffer-overflow",
            pipeName: open.binding.pipeName,
          });
          socket.destroy();
          closeOpenBinding(open, "binding-closed");
          return;
        }
        open.bufferedFrames.push(line);
        open.bufferedBytes += line.length;
        return;
      }
      dispatch(open, options.serverForSession(open.sessionId), line, socket);
    });
  }

  function openBinding(sessionId?: string): AutoIterationMcpPipeBinding {
    if (closed) throw new Error("auto-iteration-mcp-host-closed");
    const pipeName = `${pipeNamePrefix}-${randomBytes(12).toString("hex")}`;
    const token = randomBytes(tokenBytes).toString("base64url");
    const binding: AutoIterationMcpPipeBinding = Object.freeze({
      sessionId,
      pipeName,
      token,
      bootstrap: Object.freeze({
        command: bootstrapCommand,
        args: Object.freeze([bootstrapEntry, pipeName, token]),
        env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    });
    let open: OpenBinding | undefined;
    const server = createServer((socket) => {
      const current = open;
      if (current === undefined || current.spent) {
        socket.destroy();
        return;
      }
      if (current.connection !== undefined) {
        // Single connection is the whole design: refuse and diagnose rather
        // than letting a second client interleave into the same Session.
        socket.destroy();
        report({ kind: "second-connection-refused", pipeName });
        return;
      }
      serveConnection(current, socket);
    });
    open = {
      binding,
      server,
      connection: undefined,
      sessionId,
      bufferedFrames: [],
      bufferedBytes: 0,
      associationTimer: undefined,
      spent: false,
    };
    bindingsByPipe.set(pipeName, open);
    server.once("error", () => closeOpenBinding(open!, "binding-closed"));
    server.listen(pipeName);
    return binding;
  }

  function associate(
    binding: AutoIterationMcpPipeBinding,
    sessionId: string,
  ): boolean {
    const open = bindingsByPipe.get(binding.pipeName);
    if (open === undefined || open.spent || open.binding.token !== binding.token) {
      return false;
    }
    if (open.sessionId !== undefined) return open.sessionId === sessionId;
    open.sessionId = sessionId;
    clearAssociationTimer(open);
    const server = options.serverForSession(sessionId);
    const replay = open.bufferedFrames;
    open.bufferedFrames = [];
    open.bufferedBytes = 0;
    for (const line of replay) {
      if (open.connection === undefined) return true;
      dispatch(open, server, line, open.connection);
    }
    return true;
  }

  return Object.freeze({
    openBinding,
    associate,
    closeBinding(binding: AutoIterationMcpPipeBinding): void {
      const open = bindingsByPipe.get(binding.pipeName);
      if (open !== undefined && open.binding.token === binding.token) {
        closeOpenBinding(open, "binding-closed");
      }
    },
    close(): void {
      closed = true;
      for (const open of [...bindingsByPipe.values()]) {
        closeOpenBinding(open, "binding-closed");
      }
    },
  });
}

/**
 * Bindings the auto-iteration service creates for its own command objects.
 * The registry retains the host resource by idempotency key until the service
 * learns the Session id (start) or closes (resume). The bootstrap spec itself
 * travels on that exact in-memory command to the coordinator executor; there
 * is deliberately no adapter-wide FIFO claim that an unrelated command could
 * consume.
 */
export interface AutoIterationBindingRegistry {
  /**
   * Reserve a binding for a start whose Session id is not known yet. Returns
   * undefined (diagnosed once) when the bootstrap entry is unavailable — the
   * session then starts without the Workbench server, visibly degraded.
   */
  reserve(key: string): AutoIterationMcpPipeBinding | undefined;
  /** Reserve for a resume whose Session id is already known (serves live). */
  reserveForSession(key: string, sessionId: string): AutoIterationMcpPipeBinding | undefined;
  /** Name the Session a deferred reservation serves. */
  associate(key: string, sessionId: string): boolean;
  /** Drop a reservation that will never be used; diagnoses the release. */
  release(key: string): void;
  /** Live reservation state for diagnostics and guards. */
  readonly size: number;
  close(): void;
}

export interface AutoIterationBindingRegistryOptions
  extends AutoIterationMcpPipeHostOptions {
  /** Unclaimed reservations are released and diagnosed after this (60s). */
  readonly reservationTimeoutMilliseconds?: number;
}

export function createAutoIterationBindingRegistry(
  options: AutoIterationBindingRegistryOptions,
): AutoIterationBindingRegistry {
  const host = createAutoIterationMcpPipeHost(options);
  const reservationTimeoutMilliseconds =
    options.reservationTimeoutMilliseconds ?? 60_000;
  interface Reserved {
    readonly key: string;
    readonly binding: AutoIterationMcpPipeBinding;
    timer: NodeJS.Timeout | undefined;
  }
  const reserved = new Map<string, Reserved>();
  let degradedReported = false;

  function releaseReserved(
    entry: Reserved,
    reason: "reservation-released" | "reservation-expired",
  ): void {
    clearTimeout(entry.timer);
    reserved.delete(entry.key);
    host.closeBinding(entry.binding);
    options.onDiagnostic?.({ kind: reason, pipeName: entry.binding.pipeName });
  }

  function reserve(key: string, sessionId?: string): AutoIterationMcpPipeBinding | undefined {
    const existing = reserved.get(key);
    if (existing !== undefined) return existing.binding;
    let binding: AutoIterationMcpPipeBinding;
    try {
      binding = host.openBinding(sessionId);
    } catch {
      if (!degradedReported) {
        degradedReported = true;
        options.onDiagnostic?.({ kind: "registry-unavailable" });
      }
      return undefined;
    }
    const timer = sessionId === undefined
      ? setTimeout(() => {
          const entry = reserved.get(key);
          if (entry !== undefined) {
            releaseReserved(entry, "reservation-expired");
          }
        }, reservationTimeoutMilliseconds)
      : undefined;
    reserved.set(key, {
      key,
      binding,
      timer,
    });
    return binding;
  }

  return Object.freeze({
    reserve: (key: string) => reserve(key),
    reserveForSession: (key: string, sessionId: string) =>
      reserve(key, sessionId),
    associate(key: string, sessionId: string): boolean {
      const entry = reserved.get(key);
      if (entry === undefined) return false;
      const associated = host.associate(entry.binding, sessionId);
      if (associated) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      return associated;
    },
    release(key: string): void {
      const entry = reserved.get(key);
      if (entry !== undefined) releaseReserved(entry, "reservation-released");
    },
    get size(): number {
      return reserved.size;
    },
    close(): void {
      for (const entry of [...reserved.values()]) {
        releaseReserved(entry, "reservation-released");
      }
      host.close();
    },
  });
}
