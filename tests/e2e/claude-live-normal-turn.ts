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

const language = process.env.UAW_CLAUDE_NORMAL_TURN_LANGUAGE ?? "english";
if (language !== "english" && language !== "chinese") {
  throw new Error("UAW_CLAUDE_NORMAL_TURN_LANGUAGE must be english or chinese");
}

const prompt =
  language === "english"
    ? "explain this project"
    : "只回复：UAW_CLAUDE_CHINESE_OK";
const expectedChineseMarker = "UAW_CLAUDE_CHINESE_OK";
const nativeFrameShapes: FrameShape[] = [];
const normalizedEvents: NormalizedRuntimeEvent[] = [];
let phase = "catalog";
let exitCode = 0;

try {
  const adapter = new ClaudeAdapter(
    (directory) => createOfficialClaudeCatalogTransport(directory),
    async (request: ClaudeSessionTransportRequest) =>
      observeFrames(await createOfficialClaudeSessionTransport(request)),
  );
  const catalog = await adapter.inspect(process.cwd());
  const model = catalog.models.find(
    (candidate) =>
      candidate.id === "sonnet" && candidate.effortLevels.includes("low"),
  );
  if (model === undefined) {
    throw new RuntimeAdapterError("unsupported-selection");
  }

  phase = "start";
  const binding = await adapter.start({
    projectDirectory: process.cwd(),
    profile: {
      model: model.id,
      effortLevel: "low",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });

  phase = "send";
  await binding.send({ text: prompt });
  phase = "events";
  for await (const event of binding.events()) {
    normalizedEvents.push(event);
    console.log(
      `CLAUDE_NORMAL_TURN_EVENT ${JSON.stringify(describeEvent(event))}`,
    );
  }

  const messages = normalizedEvents.filter(
    (event): event is Extract<
      NormalizedRuntimeEvent,
      { readonly kind: "agent-message" }
    > => event.kind === "agent-message",
  );
  const terminal = normalizedEvents.at(-1);
  const messageObserved = messages.some((event) => event.text.trim().length > 0);
  const chineseMarkerObserved =
    language !== "chinese" ||
    messages.some((event) => event.text.trim() === expectedChineseMarker);
  const completed = terminal?.kind === "turn-completed";

  console.log(
    `CLAUDE_NORMAL_TURN_MESSAGE_OBSERVATION ${JSON.stringify({
      language,
      observed: messageObserved,
      chineseMarkerObserved,
      count: messages.length,
    })}`,
  );
  console.log(
    `CLAUDE_NORMAL_TURN_TERMINAL_OBSERVATION ${JSON.stringify({
      language,
      completed,
      kind: terminal?.kind ?? "missing",
      failureCategory:
        terminal?.kind === "failed" ? terminal.category : "not-applicable",
      iteratorEnded: true,
    })}`,
  );

  if (!messageObserved || !chineseMarkerObserved || !completed) {
    throw new RuntimeAdapterError("turn-failed");
  }

  console.log(
    `CLAUDE_NORMAL_TURN ${JSON.stringify({
      status: "passed",
      language,
      runtime: "claude",
      model: model.displayName ?? model.id,
      effort: "low",
      eventKinds: normalizedEvents.map((event) => event.kind),
      nativeFrameCount: nativeFrameShapes.length,
      liveTurns: 1,
    })}`,
  );
} catch (error) {
  exitCode = 1;
  console.log(
    `CLAUDE_NORMAL_TURN_FAILED ${JSON.stringify({
      phase,
      language,
      category:
        error instanceof RuntimeAdapterError ? error.category : "fixed-internal",
      eventKinds: normalizedEvents.map((event) => event.kind),
      nativeFrameCount: nativeFrameShapes.length,
    })}`,
  );
}

process.exitCode = exitCode;

function observeFrames(
  transport: ClaudeCatalogTransport,
): ClaudeCatalogTransport {
  return {
    send: (line) => transport.send(line),
    async receive() {
      const line = await transport.receive();
      if (line !== null) {
        const shape = describeLine(line);
        nativeFrameShapes.push(shape);
        console.log(
          `CLAUDE_NORMAL_TURN_NATIVE_FRAME ${JSON.stringify({
            index: nativeFrameShapes.length - 1,
            ...shape,
          })}`,
        );
      }
      return line;
    },
    stop: () => transport.stop(),
  };
}

function describeLine(line: string): FrameShape {
  try {
    return describeStructure(JSON.parse(line) as unknown);
  } catch {
    return Object.freeze({
      keyPaths: Object.freeze([]),
      leafTypes: Object.freeze([{ path: "frame", type: "invalid-json" }]),
    });
  }
}

interface FrameShape {
  readonly keyPaths: readonly string[];
  readonly leafTypes: readonly {
    readonly path: string;
    readonly type: string;
  }[];
}

function describeStructure(value: unknown): FrameShape {
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

function describeEvent(event: NormalizedRuntimeEvent): Readonly<{
  kind: string;
  failureCategory: string;
  messageNonEmpty: boolean;
}> {
  return Object.freeze({
    kind: event.kind,
    failureCategory:
      event.kind === "failed" ? event.category : "not-applicable",
    messageNonEmpty:
      event.kind === "agent-message" && event.text.trim().length > 0,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
