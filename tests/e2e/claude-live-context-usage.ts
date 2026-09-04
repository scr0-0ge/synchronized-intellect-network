import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import {
  createOfficialClaudeCatalogTransport,
  createOfficialClaudeSessionTransport,
} from "../../src/agent-runtime/claude/process-transport.ts";
import type {
  ClaudeCatalogTransport,
  ClaudeSessionTransportRequest,
} from "../../src/agent-runtime/claude/transport.ts";

const prompt = "Reply with exactly UAW_CONTEXT_USAGE_V1";
const isolatedRoot = await mkdtemp(join(tmpdir(), "uaw-context-usage-"));
let exitCode = 0;
let phase = "catalog";
let usageObservation: UsageObservation | undefined;
const catalogFrames: CatalogFrameObservation[] = [];

delete process.env.UAW_E2E_CLAUDE_LIVE;

try {
  const adapter = new ClaudeAdapter(
    async (directory) =>
      observeCatalog(await createOfficialClaudeCatalogTransport(directory)),
    async (request: ClaudeSessionTransportRequest) =>
      observeUsage(await createOfficialClaudeSessionTransport(request)),
  );
  const catalog = await adapter.inspect(isolatedRoot);
  if (process.env.UAW_CONTEXT_CATALOG_ONLY === "1") {
    console.log(
      `CLAUDE_CONTEXT_CATALOG_OBSERVATION ${JSON.stringify({
        frames: catalogFrames,
        catalogReads: 1,
        liveRequests: 0,
      })}`,
    );
  } else {
    const model =
      catalog.models.find(
        (candidate) =>
          /haiku/iu.test(candidate.displayName ?? candidate.id) &&
          candidate.effortLevels.includes("low"),
      ) ?? catalog.models.find((candidate) => candidate.effortLevels.includes("low"));
    if (model === undefined) throw new RuntimeAdapterError("unsupported-selection");

    phase = "turn";
    const binding = await adapter.start({
      projectDirectory: isolatedRoot,
      profile: {
        model: model.id,
        effortLevel: "low",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    await binding.send({ text: prompt });
    const events = await collect(binding.events());
    const terminal = events.at(-1);
    if (usageObservation === undefined || terminal === undefined) {
      throw new RuntimeAdapterError("protocol-invalid");
    }

    console.log(
      `CLAUDE_CONTEXT_USAGE_OBSERVATION ${JSON.stringify({
        usage: usageObservation,
        eventKinds: events.map((event) => event.kind),
        terminal:
          terminal.kind === "turn-completed"
            ? {
                kind: terminal.kind,
                context: terminal.context ?? null,
              }
            : terminal.kind === "failed"
              ? { kind: terminal.kind, category: terminal.category }
              : { kind: terminal.kind },
        liveRequests: 1,
        catalogReads: 1,
      })}`,
    );
  }
} catch (error) {
  exitCode = 1;
  console.log(
    `CLAUDE_CONTEXT_USAGE_OBSERVATION_FAILED ${JSON.stringify({
      phase,
      category:
        error instanceof RuntimeAdapterError ? error.category : "fixed-internal",
      catalogFrames,
    })}`,
  );
} finally {
  try {
    await rm(isolatedRoot, { recursive: true, force: false, maxRetries: 2 });
  } catch {
    exitCode = 1;
    console.log("CLAUDE_CONTEXT_USAGE_OBSERVATION_CLEANUP_FAILED");
  }
}

process.exitCode = exitCode;

interface UsageObservation {
  readonly keyPaths: readonly string[];
  readonly tokenCounts: readonly {
    readonly path: string;
    readonly value: number;
  }[];
  readonly declinedValuePaths: readonly string[];
}

interface CatalogFrameObservation {
  readonly keyPaths: readonly string[];
  readonly leafTypes: readonly { readonly path: string; readonly type: string }[];
}

function observeCatalog(transport: ClaudeCatalogTransport): ClaudeCatalogTransport {
  return {
    send: (line) => transport.send(line),
    async receive() {
      const line = await transport.receive();
      if (line !== null) {
        try {
          catalogFrames.push(describeStructure(JSON.parse(line) as unknown));
        } catch {
          catalogFrames.push(
            Object.freeze({
              keyPaths: Object.freeze([]),
              leafTypes: Object.freeze([{ path: "frame", type: "invalid-json" }]),
            }),
          );
        }
      }
      return line;
    },
    stop: () => transport.stop(),
  };
}

function describeStructure(value: unknown): CatalogFrameObservation {
  const keyPaths = new Set<string>();
  const leafTypes = new Map<string, string>();
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      keyPaths.add(path);
      for (const child of candidate) visit(child, `${path}[*]`);
      return;
    }
    if (isRecord(candidate)) {
      for (const key of Object.keys(candidate).sort(compareOrdinal)) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        keyPaths.add(childPath);
        visit(candidate[key], childPath);
      }
      return;
    }
    leafTypes.set(path, candidate === null ? "null" : typeof candidate);
  };
  visit(value, "");
  return Object.freeze({
    keyPaths: Object.freeze([...keyPaths].sort(compareOrdinal)),
    leafTypes: Object.freeze(
      [...leafTypes]
        .sort(([left], [right]) => compareOrdinal(left, right))
        .map(([path, type]) => Object.freeze({ path, type })),
    ),
  });
}

function observeUsage(transport: ClaudeCatalogTransport): ClaudeCatalogTransport {
  return {
    send: (line) => transport.send(line),
    async receive() {
      const line = await transport.receive();
      if (line !== null) {
        try {
          const frame = JSON.parse(line) as unknown;
          if (isRecord(frame) && frame.type === "result" && isRecord(frame.usage)) {
            usageObservation = describeUsage(frame.usage);
          }
        } catch {
          // The production parser remains authoritative for malformed JSON.
        }
      }
      return line;
    },
    stop: () => transport.stop(),
  };
}

function describeUsage(usage: Record<string, unknown>): UsageObservation {
  const keyPaths: string[] = [];
  const tokenCounts: Array<{ readonly path: string; readonly value: number }> = [];
  const declinedValuePaths: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (isRecord(value)) {
      for (const key of Object.keys(value).sort(compareOrdinal)) {
        const childPath = `${path}.${key}`;
        keyPaths.push(childPath);
        visit(value[key], childPath);
      }
      return;
    }
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      /token/iu.test(path)
    ) {
      tokenCounts.push({ path, value });
      return;
    }
    declinedValuePaths.push(path);
  };
  visit(usage, "usage");
  return Object.freeze({
    keyPaths: Object.freeze(keyPaths),
    tokenCounts: Object.freeze(tokenCounts),
    declinedValuePaths: Object.freeze(declinedValuePaths),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collect(
  events: AsyncIterable<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const values: NormalizedRuntimeEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}
