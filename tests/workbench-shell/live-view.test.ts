import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { SessionProfile } from "../../src/agent-runtime/index.ts";
import type {
  CommandReceipt,
  DirectProjectCommand,
  ProjectChannel,
  ProjectInterruptCapability,
  ProjectInterruptRequest,
  ProjectInterruptResult,
  ProjectSteerCapability,
  ProjectSteerRequest,
  ProjectSteerResult,
  ProjectSnapshot,
  ProjectUpdate,
} from "../../src/coordinator/index.ts";
import {
  createWorkbenchLiveView,
  deriveProjectLabel,
} from "../../src/workbench-shell/live-view.ts";

const profile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const defaultSessionMetadata = Object.freeze({
  displayName: "Agent Session 01",
  archived: false,
});

const requestedProfileProjection = Object.freeze({
  kind: "recorded" as const,
  runtimeFamilyLabel: "Quartz",
  endpointLabel: "Quartz desktop",
  modelLabel: "Quartz Prime",
  workIntensityControlLabel: Object.freeze({
    label: "Deliberation",
    provenance: "runtime-catalog" as const,
  }),
  workIntensityLabel: "Deep review",
  executionModeLabel: "Coordinated workflow",
  accessModeLabel: "Full access",
});

const effectiveProfileProjection = Object.freeze({
  kind: "observed" as const,
  provenance: "post-turn-observation" as const,
  model: Object.freeze({
    label: "Quartz Prime",
    comparison: "matches-requested" as const,
  }),
  workIntensity: Object.freeze({
    label: "Observed different value",
    comparison: "differs-from-requested" as const,
  }),
  accessMode: Object.freeze({
    label: "Full access",
    comparison: "matches-requested" as const,
  }),
});

class ControlledProjectChannel implements ProjectChannel {
  readonly snapshotValues: readonly ProjectSnapshot[];
  readonly updateValues: readonly ProjectUpdate[];
  readonly deferReturn: boolean;
  snapshotCalls = 0;
  observeCalls: Array<number | undefined> = [];
  observeReturnCalls = 0;
  actCalls = 0;
  closeCalls = 0;
  interruptCapability: ProjectInterruptCapability = Object.freeze({
    status: "idle",
  });
  interruptCalls: ProjectInterruptRequest[] = [];
  steerCapability: ProjectSteerCapability = Object.freeze({ status: "idle" });
  steerCalls: ProjectSteerRequest[] = [];
  private updateIndex = 0;
  private pendingNext:
    | ((result: IteratorResult<ProjectUpdate>) => void)
    | undefined;
  private resolveCaughtUp!: () => void;
  private readonly caughtUp = new Promise<void>((resolve) => {
    this.resolveCaughtUp = resolve;
  });
  private resolveReturn!: () => void;
  private readonly returnReleased = new Promise<void>((resolve) => {
    this.resolveReturn = resolve;
  });

  constructor(
    snapshotValue: ProjectSnapshot | readonly ProjectSnapshot[],
    updates: readonly ProjectUpdate[] = [],
    deferReturn = false,
  ) {
    this.snapshotValues = Array.isArray(snapshotValue)
      ? snapshotValue
      : [snapshotValue];
    this.updateValues = updates;
    this.deferReturn = deferReturn;
  }

  async act(_command: DirectProjectCommand): Promise<CommandReceipt> {
    this.actCalls += 1;
    throw new Error("ACT_MUST_NOT_RUN");
  }

  async removeSession() {
    return { status: "not-found" as const };
  }

  async mutateSessionMetadata() {
    return { status: "not-found" as const };
  }

  async validateContinuationProfile(request: {
    readonly sessionId: string;
    readonly profile: SessionProfile;
  }) {
    const source = this.snapshotValues
      .at(-1)
      ?.commands.find(
        (command) => command.session?.sessionId === request.sessionId,
      )?.session?.profile;
    return {
      status:
        source !== undefined &&
        request.profile.executionMode === source.executionMode &&
        request.profile.accessMode === source.accessMode &&
        request.profile.model !== "other-provider-model"
          ? ("compatible" as const)
          : ("incompatible" as const),
    };
  }

  readTurnActivity() {
    return "idle" as const;
  }

  readInterruptCapability(): ProjectInterruptCapability {
    return this.interruptCapability;
  }

  async interruptActiveTurn(
    request: ProjectInterruptRequest,
  ): Promise<ProjectInterruptResult> {
    this.interruptCalls.push(request);
    return { status: "requested" };
  }

  readSteerCapability(): ProjectSteerCapability {
    return this.steerCapability;
  }

  async steerActiveTurn(
    request: ProjectSteerRequest,
  ): Promise<ProjectSteerResult> {
    this.steerCalls.push(request);
    return { status: "accepted" };
  }

  async snapshot(): Promise<ProjectSnapshot> {
    this.snapshotCalls += 1;
    return this.snapshotValues[
      Math.min(this.snapshotCalls - 1, this.snapshotValues.length - 1)
    ]!;
  }

  observe(options?: { readonly after?: number }): AsyncIterable<ProjectUpdate> {
    this.observeCalls.push(options?.after);
    const iterator: AsyncIterableIterator<ProjectUpdate> = {
      next: () => {
        const update = this.updateValues[this.updateIndex];
        if (update !== undefined) {
          this.updateIndex += 1;
          return Promise.resolve({ done: false as const, value: update });
        }
        this.resolveCaughtUp();
        return new Promise<IteratorResult<ProjectUpdate>>((resolve) => {
          this.pendingNext = resolve;
        });
      },
      return: async () => {
        this.observeReturnCalls += 1;
        this.pendingNext?.({ done: true, value: undefined });
        this.pendingNext = undefined;
        if (this.deferReturn) await this.returnReleased;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.pendingNext?.({ done: true, value: undefined });
    this.pendingNext = undefined;
  }

  observationCaughtUp(): Promise<void> {
    return this.caughtUp;
  }

  releaseReturn(): void {
    this.resolveReturn();
  }
}

class DeferredSnapshotChannel implements ProjectChannel {
  observeCalls = 0;
  actCalls = 0;
  closeCalls = 0;
  private resolveSnapshot!: (snapshot: ProjectSnapshot) => void;
  private resolveStarted!: () => void;
  private readonly snapshotPromise = new Promise<ProjectSnapshot>((resolve) => {
    this.resolveSnapshot = resolve;
  });
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async act(_command: DirectProjectCommand): Promise<CommandReceipt> {
    this.actCalls += 1;
    throw new Error("ACT_MUST_NOT_RUN");
  }

  async removeSession() {
    return { status: "not-found" as const };
  }

  async mutateSessionMetadata() {
    return { status: "not-found" as const };
  }

  async validateContinuationProfile() {
    return { status: "incompatible" as const };
  }

  readTurnActivity() {
    return "idle" as const;
  }

  snapshot(): Promise<ProjectSnapshot> {
    this.resolveStarted();
    return this.snapshotPromise;
  }

  observe(): AsyncIterable<ProjectUpdate> {
    this.observeCalls += 1;
    throw new Error("OBSERVE_MUST_NOT_RUN");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  snapshotStarted(): Promise<void> {
    return this.started;
  }

  releaseSnapshot(): void {
    this.resolveSnapshot({
      projectId: "hidden-project-id",
      cursor: 0,
      commands: [],
    });
  }
}

test("live view emits one current sanitized full Project view first", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "workbench-live-view-"));
  const projectDirectory = join(temporaryDirectory, "Live Project");
  await mkdir(projectDirectory);
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const sourceSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 7,
    commands: [
      {
        commandId: "hidden-command-id",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "hidden-session-id",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [
            {
              kind: "agent-message",
              text: `Durable output for ${projectDirectory}`,
              providerNative: "PRIVATE_NATIVE_SENTINEL",
            } as never,
          ],
          nativeSessionId: "PRIVATE_NATIVE_SENTINEL",
        } as never,
      },
    ],
  };
  const sourceBefore = structuredClone(sourceSnapshot);
  const channel = new ControlledProjectChannel(sourceSnapshot);
  const liveView = createWorkbenchLiveView({ channel, projectDirectory });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });

  const dispose = liveView.observe(resolveFirst);
  const result = await firstResult;
  const removalKey = (
    result as {
      readonly view: {
        readonly commands: readonly [{
          readonly session: { readonly removalKey: string };
        }];
      };
    }
  ).view.commands[0].session.removalKey;
  const metadataKey = (
    result as {
      readonly view: {
        readonly commands: readonly [{
          readonly session: { readonly metadataKey: string };
        }];
      };
    }
  ).view.commands[0].session.metadataKey;
  assert.match(removalKey, /^session-removal:[0-9a-f-]{36}$/u);
  assert.match(metadataKey, /^session-metadata:[0-9a-f-]{36}$/u);

  assert.deepEqual(result, {
    ok: true,
    view: {
      project: { label: basename(projectDirectory) },
      observation: { cursor: 7, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Codex",
          status: "completed",
          session: {
            profile: {
              requested: { kind: "not-recorded" },
              effective: { kind: "not-recorded" },
            },
            timeline: [
              { kind: "agent-message", text: "Durable output for [Project]" },
            ],
            turns: [
              {
                profile: {
                  requested: { kind: "not-recorded" },
                  effective: { kind: "not-recorded" },
                },
                timeline: [
                  { kind: "agent-message", text: "Durable output for [Project]" },
                ],
              },
            ],
            removalKey,
            metadataKey,
            archived: false,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    Object.isFrozen(
      (result as { view: { commands: Array<{ session: { timeline: unknown } }> } })
        .view.commands[0]?.session.timeline,
    ),
    true,
  );
  assert.deepEqual(channel.observeCalls, [7]);
  assert.equal(channel.actCalls, 0);
  assert.deepEqual(sourceSnapshot, sourceBefore);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(projectDirectory), false);
  assert.equal(serialized.includes("hidden-project-id"), false);
  assert.equal(serialized.includes("hidden-command-id"), false);
  assert.equal(serialized.includes("hidden-session-id"), false);
  assert.equal(serialized.includes("PRIVATE_NATIVE_SENTINEL"), false);

  dispose();
  dispose();
  await liveView.close();
  assert.equal(channel.observeReturnCalls, 1);
});

test("live view exposes one exact running-turn interrupt capability and resumes an interrupted Session", async () => {
  const commandId = "hidden-running-command";
  const sessionId = "hidden-running-session";
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 12,
    commands: [
      {
        commandId,
        runtime: "codex",
        status: "in-flight",
        input: "Long running instruction",
        session: {
          sessionId,
          ...defaultSessionMetadata,
          profile,
          resumable: false,
          events: [{ kind: "turn-started" }],
        },
      },
    ],
  });
  channel.interruptCapability = Object.freeze({
    status: "available",
    commandId,
  });
  channel.steerCapability = Object.freeze({
    status: "available",
    commandId,
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Interrupt Capability Project"),
  });
  let dispose: () => void = () => undefined;
  const running = await new Promise<any>((resolve) => {
    dispose = liveView.observe(resolve);
  });
  const interrupt = running.view.commands[0].interrupt;
  assert.deepEqual(Object.keys(interrupt).sort(), ["interruptKey", "status"]);
  assert.equal(interrupt.status, "available");
  assert.match(interrupt.interruptKey, /^turn-interrupt:[0-9a-f-]{36}$/u);
  assert.deepEqual(liveView.resolveInterrupt(interrupt.interruptKey), {
    commandId,
  });
  assert.equal(liveView.resolveInterrupt("turn-interrupt:forged"), undefined);
  const steer = running.view.commands[0].steer;
  assert.deepEqual(Object.keys(steer).sort(), ["status", "steerKey"]);
  assert.equal(steer.status, "available");
  assert.match(steer.steerKey, /^turn-steer:[0-9a-f-]{36}$/u);
  assert.deepEqual(liveView.resolveSteer(steer.steerKey), { commandId });
  assert.equal(liveView.resolveSteer("turn-steer:forged"), undefined);
  assert.equal(JSON.stringify(running).includes(commandId), false);
  dispose();
  await liveView.close();

  const unsupported = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 13,
    commands: [
      {
        commandId,
        runtime: "codex",
        status: "in-flight",
        session: {
          sessionId,
          ...defaultSessionMetadata,
          profile,
          resumable: false,
          events: [{ kind: "turn-started" }],
        },
      },
    ],
  });
  unsupported.interruptCapability = Object.freeze({
    status: "unsupported",
    commandId,
  });
  unsupported.steerCapability = Object.freeze({
    status: "unsupported",
    commandId,
  });
  const unsupportedView = createWorkbenchLiveView({
    channel: unsupported,
    projectDirectory: join(tmpdir(), "Unsupported Interrupt Project"),
  });
  let disposeUnsupported: () => void = () => undefined;
  const unavailable = await new Promise<any>((resolve) => {
    disposeUnsupported = unsupportedView.observe(resolve);
  });
  assert.deepEqual(unavailable.view.commands[0].interrupt, {
    status: "unsupported",
    reason: "This Runtime does not support interruption.",
  });
  assert.deepEqual(unavailable.view.commands[0].steer, {
    status: "unsupported",
    reason:
      "This Runtime does not support same-turn guidance. Your draft stays local.",
  });
  disposeUnsupported();
  await unsupportedView.close();

  const interrupted = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 14,
    commands: [
      {
        commandId,
        runtime: "codex",
        status: "failed",
        failureCategory: "interrupted",
        session: {
          sessionId,
          ...defaultSessionMetadata,
          profile,
          resumable: true,
          events: [{ kind: "turn-interrupted", status: "interrupted" }],
        },
      },
    ],
  });
  const interruptedView = createWorkbenchLiveView({
    channel: interrupted,
    projectDirectory: join(tmpdir(), "Interrupted Session Project"),
  });
  let disposeInterrupted: () => void = () => undefined;
  const stopped = await new Promise<any>((resolve) => {
    disposeInterrupted = interruptedView.observe(resolve);
  });
  assert.equal(stopped.view.commands[0].failureCategory, "interrupted");
  assert.deepEqual(stopped.view.commands[0].session.timeline, [
    { kind: "turn-interrupted", status: "interrupted" },
  ]);
  assert.equal(stopped.view.commands[0].session.resumable, true);
  assert.match(
    stopped.view.commands[0].session.selectionKey,
    /^session-selection:[0-9a-f-]{36}$/u,
  );
  disposeInterrupted();
  await interruptedView.close();
});

test("live view gives every Session a snapshot-scoped removal capability distinct from continuation", async () => {
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 8,
    commands: [
      {
        commandId: "hidden-command-id",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "hidden-session-id",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: true,
          events: [],
        },
      },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Removal Capability Project"),
  });
  let dispose: () => void = () => undefined;
  const result = await new Promise<unknown>((resolve) => {
    dispose = liveView.observe(resolve);
  });
  assert.equal(
    typeof result === "object" && result !== null && "ok" in result
      ? result.ok
      : false,
    true,
  );
  const session = (
    result as {
      readonly view: {
        readonly commands: readonly [{
          readonly session: {
            readonly selectionKey: string;
            readonly removalKey: string;
          };
        }];
      };
    }
  ).view.commands[0].session;

  assert.match(
    session.removalKey,
    /^session-removal:[0-9a-f-]{36}$/u,
  );
  assert.notEqual(session.removalKey, session.selectionKey);
  assert.deepEqual(liveView.resolveSessionRemoval(session.removalKey), {
    sessionId: "hidden-session-id",
  });
  assert.equal(liveView.resolveSessionRemoval(session.selectionKey), undefined);
  assert.equal(JSON.stringify(result).includes("hidden-session-id"), false);

  dispose();
  await liveView.close();
});

test("live view rotates opaque metadata capabilities and prefers active selection after archive", async () => {
  const session = (
    sessionId: string,
    displayName: string,
    archived: boolean,
  ) => ({
    sessionId,
    displayName,
    archived,
    profile,
    events: [{ kind: "turn-completed" as const, status: "completed" as const }],
    resumable: !archived,
  });
  const before: ProjectSnapshot = {
    projectId: "private-project",
    cursor: 11,
    commands: [
      {
        commandId: "private-command-one",
        runtime: "codex",
        status: "completed",
        session: session("private-session-one", "Agent Session 01", false),
      },
      {
        commandId: "private-command-two",
        runtime: "codex",
        status: "completed",
        session: session("private-session-two", "Agent Session 02", false),
      },
    ],
  };
  const after: ProjectSnapshot = {
    ...before,
    commands: [
      {
        ...before.commands[0]!,
        session: session("private-session-one", "Renamed archived", true),
      },
      before.commands[1]!,
    ],
  };
  const channel = new ControlledProjectChannel([before, after]);
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: "C:\\synthetic\\Metadata Project",
  });
  const observed: unknown[] = [];
  let resolveFirst!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const dispose = liveView.observe((result) => {
    observed.push(result);
    if (observed.length === 1) resolveFirst();
  });
  await firstSeen;
  const first = observed[0] as {
    readonly ok: true;
    readonly view: {
      readonly commands: readonly [{
        readonly label: string;
        readonly session: {
          readonly archived: boolean;
          readonly metadataKey: string;
          readonly resumable: boolean;
          readonly selectionKey: string | null;
        };
      }, {
        readonly label: string;
        readonly session: {
          readonly archived: boolean;
          readonly metadataKey: string;
          readonly resumable: boolean;
          readonly selectionKey: string | null;
        };
      }];
      readonly initialSelectionKey: string;
    };
  };
  const oldKey = first.view.commands[0].session.metadataKey;
  assert.deepEqual(liveView.resolveSessionMetadata(oldKey), {
    sessionId: "private-session-one",
  });
  assert.notEqual(
    first.view.commands[0].session.metadataKey,
    first.view.commands[1].session.metadataKey,
  );

  await liveView.refreshAfterSessionMutation();
  assert.equal(observed.length, 2);
  const refreshed = observed[1] as typeof first;
  assert.equal(refreshed.view.commands[0].session.metadataKey === oldKey, false);
  assert.equal(liveView.resolveSessionMetadata(oldKey), undefined);
  assert.deepEqual(
    liveView.resolveSessionMetadata(
      refreshed.view.commands[0].session.metadataKey,
    ),
    { sessionId: "private-session-one" },
  );
  assert.equal(refreshed.view.commands[0].label, "Renamed archived");
  assert.equal(refreshed.view.commands[0].session.archived, true);
  assert.equal(refreshed.view.commands[0].session.resumable, false);
  assert.equal(refreshed.view.commands[0].session.selectionKey, null);
  assert.equal(refreshed.view.initialSelectionKey, "command-2");
  assert.equal(JSON.stringify(refreshed).includes("private-session"), false);
  assert.equal(JSON.stringify(refreshed).includes("private-command"), false);

  dispose();
  await liveView.close();
});

test("live view privately resolves replacement source only for the exact command key and observation cursor", async () => {
  const sourceSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 9,
    commands: [
      {
        commandId: "hidden-source-command",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "hidden-source-session",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [],
        },
      },
    ],
  };
  const channel = new ControlledProjectChannel(sourceSnapshot);
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Replacement Source Project"),
  });
  let dispose: () => void = () => undefined;
  await new Promise<void>((resolve) => {
    dispose = liveView.observe((result) => {
      if (result.ok) resolve();
    });
  });

  const resolved = await liveView.resolveReplacementProfileSource({
    sourceSelectionKey: "command-1",
    sourceSnapshotCursor: 9,
  });

  assert.deepEqual(resolved, profile);
  assert.notEqual(resolved, sourceSnapshot.commands[0]?.session?.profile);
  assert.equal(
    await liveView.resolveReplacementProfileSource({
      sourceSelectionKey: "command-1",
      sourceSnapshotCursor: 8,
    }),
    undefined,
  );
  assert.equal(
    await liveView.resolveReplacementProfileSource({
      sourceSelectionKey: "command-2",
      sourceSnapshotCursor: 9,
    }),
    undefined,
  );

  dispose();
  await liveView.close();
});

test("live view rejects a same-cursor replacement source mutation instead of reusing its cached private tuple", async () => {
  const sourceSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 10,
    commands: [
      {
        commandId: "hidden-source-command",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "hidden-source-session",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [],
        },
      },
    ],
  };
  const mutatedSnapshot: ProjectSnapshot = {
    ...sourceSnapshot,
    commands: [
      {
        ...sourceSnapshot.commands[0]!,
        session: {
          ...sourceSnapshot.commands[0]!.session!,
          profile: {
            ...profile,
            model: "C:\\PRIVATE_SOURCE_MUTATION",
          },
        },
      },
    ],
  };
  const channel = new ControlledProjectChannel([
    sourceSnapshot,
    mutatedSnapshot,
  ]);
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Mutated Replacement Source Project"),
  });
  let dispose: () => void = () => undefined;
  const publicResults: unknown[] = [];
  await new Promise<void>((resolve) => {
    dispose = liveView.observe((result) => {
      publicResults.push(result);
      if (result.ok) resolve();
    });
  });

  assert.equal(
    await liveView.resolveReplacementProfileSource({
      sourceSelectionKey: "command-1",
      sourceSnapshotCursor: 10,
    }),
    undefined,
  );
  assert.equal(JSON.stringify(publicResults).includes("PRIVATE_SOURCE_MUTATION"), false);

  dispose();
  await liveView.close();
});

test("live view omits context before the first completed turn and projects the latest pair", async () => {
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 6,
    commands: [
      {
        commandId: "before-first-turn-command",
        runtime: "codex",
        status: "in-flight",
        session: {
          sessionId: "before-first-turn-session",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [{ kind: "session-started" }, { kind: "turn-started" }],
        },
      },
      {
        commandId: "context-command",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "context-session",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [
            { kind: "session-started" },
            { kind: "turn-started" },
            {
              kind: "turn-completed",
              status: "completed",
              context: {
                basis: "active-context",
                usedTokens: 144,
                windowTokens: 258_400,
              },
            },
          ],
        },
      },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Context Project"),
  });
  let dispose: () => void = () => undefined;
  const first = new Promise<unknown>((resolve) => {
    dispose = liveView.observe(resolve);
  });
  const result = (await first) as {
    readonly ok: true;
    readonly view: {
      readonly commands: readonly {
        readonly session?: {
          readonly context?: { readonly usedTokens: number; readonly windowTokens: number | null };
          readonly timeline: readonly unknown[];
        };
      }[];
    };
  };

  assert.equal(result.ok, true);
  const beforeFirstTurn = result.view.commands[0]?.session;
  const completed = result.view.commands[1]?.session;
  assert.equal(
    Object.prototype.hasOwnProperty.call(beforeFirstTurn ?? {}, "context"),
    false,
    "before-first-turn context is absent",
  );
  assert.deepEqual(completed?.context, {
    usedTokens: 144,
    windowTokens: 258_400,
  });
  assert.deepEqual(completed?.timeline.at(-1), {
    kind: "turn-completed",
    status: "completed",
  });
  assert.equal(Object.isFrozen(completed?.context), true);
  dispose();
  await liveView.close();
});

test("live view rejects cross-combined context basis and window semantics", async () => {
  for (const context of [
    { basis: "active-context", usedTokens: 144, windowTokens: null },
    { basis: "turn-usage", usedTokens: 144, windowTokens: 258_400 },
  ] as const) {
    const channel = new ControlledProjectChannel({
      projectId: "hidden-project-id",
      cursor: 1,
      commands: [
        {
          commandId: "cross-context-command",
          runtime: "codex",
          status: "completed",
          session: {
            sessionId: "cross-context-session",
            ...defaultSessionMetadata,
            profile,
            resumable: false,
            events: [
              {
                kind: "turn-completed",
                status: "completed",
                context,
              } as never,
            ],
          },
        },
      ],
    });
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: join(tmpdir(), "Cross Context Project"),
    });
    const result = await new Promise<{ readonly ok: boolean }>((resolve) => {
      liveView.observe(resolve);
    });
    assert.equal(result.ok, false);
    await liveView.close();
  }
});

test("live view fails closed on every adversarial completed-turn context row", async () => {
  const activeContext = () => ({
    basis: "active-context" as const,
    usedTokens: 144,
    windowTokens: 258_400,
  });
  const adversarial = [
    { name: "negative count", value: { usedTokens: -1, windowTokens: 258_400 } },
    {
      name: "non-integer count",
      value: { usedTokens: 1.5, windowTokens: 258_400 },
    },
    {
      name: "window smaller than used",
      value: { usedTokens: 144, windowTokens: 143 },
    },
    {
      name: "window present but not a number",
      value: { usedTokens: 144, windowTokens: "258400" },
    },
    {
      name: "unrecognized extra key",
      value: { usedTokens: 144, windowTokens: 258_400, nativeExtra: true },
    },
    {
      name: "non-enumerable extra key",
      value: (() => {
        const context = activeContext();
        Object.defineProperty(context, "nativeExtra", { value: true });
        return context;
      })(),
    },
    {
      name: "symbol extra key",
      value: { ...activeContext(), [Symbol("native-extra")]: true },
    },
    {
      name: "inherited extra key",
      value: Object.assign(
        Object.create({ nativeExtra: true }) as Record<string, unknown>,
        activeContext(),
      ),
    },
    {
      name: "accessor field",
      value: (() => {
        const context = {
          basis: "active-context" as const,
          usedTokens: 144,
        } as Record<string, unknown>;
        Object.defineProperty(context, "windowTokens", {
          enumerable: true,
          get: () => 258_400,
        });
        return context;
      })(),
    },
    {
      name: "proxied context",
      value: new Proxy(activeContext(), {}),
    },
  ];

  for (const [index, row] of adversarial.entries()) {
    const channel = new ControlledProjectChannel({
      projectId: "hidden-project-id",
      cursor: index + 1,
      commands: [
        {
          commandId: `invalid-context-${index}`,
          runtime: "codex",
          status: "completed",
          session: {
            sessionId: `invalid-context-session-${index}`,
            ...defaultSessionMetadata,
            profile: { ...profile },
            resumable: false,
            events: [
              {
                kind: "turn-completed",
                status: "completed",
                context: row.value,
              } as never,
            ],
          },
        },
      ],
    });
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: join(tmpdir(), `Invalid Context ${index}`),
    });
    let dispose: () => void = () => undefined;
    const first = new Promise<unknown>((resolve) => {
      dispose = liveView.observe(resolve);
    });
    assert.deepEqual(
      await first,
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      row.name,
    );
    dispose();
    await liveView.close();
  }
});

test("live view renders durable display projections and degrades historical profiles honestly", async () => {
  const opaqueModelKey = "Dm_jNv_EMAy_Y0OVELFexo_UKhItXc68dWq5HaRT2EVTas";
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 4,
    commands: [
      {
        commandId: "projected-command",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "projected-session",
          ...defaultSessionMetadata,
          profile: {
            ...profile,
            model: opaqueModelKey,
          },
          requestedProfileProjection,
          effectiveProfileProjection,
          resumable: false,
          events: [],
        } as never,
      },
      {
        commandId: "historical-command",
        runtime: "codex",
        status: "completed",
        session: {
          sessionId: "historical-session",
          ...defaultSessionMetadata,
          profile: {
            ...profile,
            model: "legacy-opaque-model-key",
          },
          resumable: false,
          events: [],
        },
      },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Projection Project"),
  });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });

  const dispose = liveView.observe(resolveFirst);
  const result = await firstResult;
  const commands = (result as {
    readonly ok: true;
    readonly view: {
      readonly commands: readonly {
        readonly session?: { readonly profile: unknown };
      }[];
    };
  }).view.commands;

  assert.deepEqual(commands[0]?.session?.profile, {
    requested: requestedProfileProjection,
    effective: effectiveProfileProjection,
  });
  assert.deepEqual(commands[1]?.session?.profile, {
    requested: { kind: "not-recorded" },
    effective: { kind: "not-recorded" },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(opaqueModelKey), false);
  assert.equal(serialized.includes("legacy-opaque-model-key"), false);
  assert.equal(serialized.includes("Quartz Prime"), true);
  assert.equal(serialized.includes("Observed different value"), true);

  dispose();
  await liveView.close();
});

test("live view coalesces a durable burst while preserving ordinal command keys", async () => {
  const initialSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 1,
    commands: [
      {
        commandId: "command-a",
        runtime: "codex",
        status: "accepted",
        input: "Queued exact input A",
        session: {
          sessionId: "hidden-session-a",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [],
        },
      },
    ],
  };
  const latestSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 4,
    commands: [
      {
        commandId: "command-b",
        runtime: "codex",
        status: "completed",
        input: "Queued exact input B",
        session: {
          sessionId: "hidden-session-b",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [],
        },
      },
      {
        commandId: "command-a",
        runtime: "codex",
        status: "completed",
        input: "Queued exact input A",
        session: {
          sessionId: "hidden-session-a",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [],
        },
      },
    ],
  };
  const updates: readonly ProjectUpdate[] = [
    {
      cursor: 2,
      commandId: "command-a",
      kind: "in-flight",
      status: "in-flight",
    },
    {
      cursor: 3,
      commandId: "command-b",
      kind: "accepted",
      status: "accepted",
    },
    {
      cursor: 4,
      commandId: "command-b",
      kind: "completed",
      status: "completed",
    },
  ];
  const snapshotsBefore = structuredClone([initialSnapshot, latestSnapshot]);
  const updatesBefore = structuredClone(updates);
  const channel = new ControlledProjectChannel(
    [initialSnapshot, latestSnapshot],
    updates,
  );
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Ordinal Project"),
  });
  const results: Array<{
    ok: boolean;
    view?: {
      observation: { cursor: number };
      commands: readonly {
        key: string;
        session?: { timeline: readonly unknown[] };
      }[];
    };
  }> = [];

  const dispose = liveView.observe((result) => results.push(result));
  await channel.observationCaughtUp();

  assert.deepEqual(
    results.map((result) => result.view?.observation.cursor),
    [1, 4],
  );
  assert.deepEqual(
    results[1]?.view?.commands.map((command) => ({
      key: command.key,
      timeline: command.session?.timeline,
    })),
    [
      {
        key: "command-2",
        timeline: [{ kind: "user-message", text: "Queued exact input B" }],
      },
      {
        key: "command-1",
        timeline: [{ kind: "user-message", text: "Queued exact input A" }],
      },
    ],
  );
  assert.deepEqual(channel.observeCalls, [1]);
  assert.deepEqual([initialSnapshot, latestSnapshot], snapshotsBefore);
  assert.deepEqual(updates, updatesBefore);
  dispose();
  await liveView.close();
});

test("live view groups follow-ups into one stable Session and rotates its sanitized selection capability", async () => {
  const sessionId = "hidden-shared-session";
  const changedProfile: SessionProfile = Object.freeze({
    ...profile,
    model: "gpt-5.6-terra",
    effortLevel: "high",
  });
  const changedRequestedProjection = Object.freeze({
    ...requestedProfileProjection,
    modelLabel: "Quartz Terra",
    workIntensityLabel: "Focused review",
  });
  const changedEffectiveProjection = Object.freeze({
    kind: "observed" as const,
    provenance: "post-turn-observation" as const,
    model: Object.freeze({
      label: "Quartz Terra",
      comparison: "matches-requested" as const,
    }),
    workIntensity: Object.freeze({
      label: "Focused review",
      comparison: "matches-requested" as const,
    }),
    accessMode: Object.freeze({
      label: "Full access",
      comparison: "matches-requested" as const,
    }),
  });
  const initialSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 3,
    commands: [
      {
        commandId: "hidden-root-command",
        runtime: "codex",
        status: "completed",
        input: "First exact user input",
        session: {
          sessionId,
          ...defaultSessionMetadata,
          profile,
          requestedProfileProjection,
          effectiveProfileProjection,
          resumable: true,
          events: [
            { kind: "agent-message", text: "First visible result" },
            { kind: "failed", category: "authentication-required" },
          ],
        },
      },
    ],
  };
  const latestSnapshot: ProjectSnapshot = {
    projectId: "hidden-project-id",
    cursor: 5,
    commands: [
      initialSnapshot.commands[0]!,
      {
        commandId: "hidden-follow-up-command",
        runtime: "codex",
        status: "completed",
        input: "Second exact user input",
        session: {
          sessionId,
          ...defaultSessionMetadata,
          profile: changedProfile,
          requestedProfileProjection: changedRequestedProjection,
          effectiveProfileProjection: changedEffectiveProjection,
          resumable: true,
          events: [{ kind: "agent-message", text: "Second visible result" }],
        },
      },
    ],
  };
  const channel = new ControlledProjectChannel(
    [initialSnapshot, latestSnapshot],
    [
      {
        cursor: 4,
        commandId: "hidden-follow-up-command",
        kind: "in-flight",
        status: "in-flight",
      },
      {
        cursor: 5,
        commandId: "hidden-follow-up-command",
        kind: "completed",
        status: "completed",
      },
    ],
  );
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Visible Project"),
  });
  const results: unknown[] = [];
  let resolveTwo!: () => void;
  const twoResults = new Promise<void>((resolve) => {
    resolveTwo = resolve;
  });
  const dispose = liveView.observe((result) => {
    results.push(result);
    if (results.length === 2) resolveTwo();
  });
  await twoResults;
  const first = results[0] as {
    ok: true;
    view: { commands: Array<{ key: string; session?: { selectionKey: string | null } }> };
  };
  const second = results[1] as typeof first;
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.view.commands.length, 1);
  assert.equal(second.view.commands.length, 1);
  assert.equal(first.view.commands[0]?.key, second.view.commands[0]?.key);
  const firstSelection = first.view.commands[0]?.session?.selectionKey;
  const secondSelection = second.view.commands[0]?.session?.selectionKey;
  assert.match(firstSelection ?? "", /^session-selection:/u);
  assert.match(secondSelection ?? "", /^session-selection:/u);
  assert.notEqual(firstSelection, secondSelection);
  assert.equal(liveView.resolveContinuationSelection(firstSelection ?? ""), undefined);
  assert.deepEqual(liveView.resolveContinuationSelection(secondSelection ?? ""), {
    targetSessionId: sessionId,
    profile: changedProfile,
  });
  assert.equal(
    await liveView.resolveContinuationProfile(
      firstSelection ?? "",
      changedProfile,
    ),
    undefined,
  );
  assert.equal(
    await liveView.resolveContinuationProfile(
      secondSelection ?? "",
      { ...changedProfile, nativeEndpointKey: "forged-private-key" } as never,
    ),
    undefined,
  );
  assert.equal(
    await liveView.resolveContinuationProfile(secondSelection ?? "", {
      ...changedProfile,
      accessMode: "restricted",
    } as never),
    undefined,
  );
  assert.deepEqual(
    await liveView.resolveContinuationProfile(
      secondSelection ?? "",
      changedProfile,
    ),
    {
      targetSessionId: sessionId,
      profile: changedProfile,
    },
  );
  assert.equal(
    await liveView.resolveContinuationProfile(secondSelection ?? "", {
      ...changedProfile,
      model: "other-provider-model",
    }),
    undefined,
  );
  const firstTimeline = (
    results[0] as { view: { commands: Array<{ session: { timeline: unknown[] } }> } }
  ).view.commands[0]!.session.timeline;
  const secondTimeline = (
    results[1] as { view: { commands: Array<{ session: { timeline: unknown[] } }> } }
  ).view.commands[0]!.session.timeline;
  assert.deepEqual(firstTimeline, [
    { kind: "user-message", text: "First exact user input" },
    { kind: "agent-message", text: "First visible result" },
    { kind: "failed" },
  ]);
  assert.deepEqual(secondTimeline, [
    ...firstTimeline,
    { kind: "user-message", text: "Second exact user input" },
    { kind: "agent-message", text: "Second visible result" },
  ]);
  const secondTurns = (
    results[1] as {
      view: {
        commands: Array<{
          session: {
            turns: Array<{ profile: unknown; timeline: unknown[] }>;
          };
        }>;
      };
    }
  ).view.commands[0]!.session.turns;
  assert.deepEqual(secondTurns, [
    {
      profile: {
        requested: requestedProfileProjection,
        effective: effectiveProfileProjection,
      },
      timeline: firstTimeline,
    },
    {
      profile: {
        requested: changedRequestedProjection,
        effective: changedEffectiveProjection,
      },
      timeline: [
        { kind: "user-message", text: "Second exact user input" },
        { kind: "agent-message", text: "Second visible result" },
      ],
    },
  ]);
  assert.partialDeepStrictEqual(
    (
      results[1] as {
        view: {
          commands: Array<{
            runtime: string;
            session: { profile: unknown };
          }>;
        };
      }
    ).view.commands[0],
    {
      runtime: "Quartz",
      session: {
        profile: {
          requested: changedRequestedProjection,
          effective: changedEffectiveProjection,
        },
      },
    },
  );
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes(sessionId), false);
  assert.equal(serialized.includes("authentication-required"), false);
  assert.match(serialized, /"kind":"failed"/u);
  assert.equal(
    secondTimeline.length,
    5,
  );
  dispose();
  await liveView.close();
});

test("live view keeps one accepted-cursor user slice visible across lifecycle states and omits v1 input", async () => {
  const states = ["accepted", "in-flight", "failed", "recovery-required"] as const;
  const commands: ProjectSnapshot["commands"] = [
    ...states.map((status, index) => ({
      commandId: `state-command-${index}`,
      runtime: "codex" as const,
      status,
      input: `state input ${index}`,
      ...(status === "failed"
        ? { failureCategory: "runtime-failed" as const }
        : {}),
      session: {
        sessionId: `state-session-${index}`,
        ...defaultSessionMetadata,
        profile: { ...profile },
        resumable: false,
        events:
          status === "failed"
            ? ([{ kind: "failed", category: "turn-failed" }] as const)
            : ([{ kind: "turn-started" }] as const),
      },
    })),
    {
      commandId: "legacy-v1-command",
      runtime: "codex",
      status: "completed",
      session: {
        sessionId: "legacy-v1-session",
        ...defaultSessionMetadata,
        profile: { ...profile },
        resumable: false,
        events: [{ kind: "agent-message", text: "Legacy result only" }],
      },
    },
  ];
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 10,
    commands,
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Lifecycle Message Project"),
  });
  let dispose: () => void = () => undefined;
  const first = new Promise<unknown>((resolve) => {
    dispose = liveView.observe(resolve);
  });
  const result = await first;
  assert.equal((result as { readonly ok: boolean }).ok, true);
  const projected = (
    result as {
      readonly ok: true;
      readonly view: {
        readonly commands: readonly {
          readonly status: string;
          readonly session?: { readonly timeline: readonly unknown[] };
        }[];
      };
    }
  ).view.commands;
  assert.deepEqual(
    projected.slice(0, states.length).map((command) => ({
      status: command.status,
      first: command.session?.timeline[0],
      userMessageCount:
        command.session?.timeline.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "kind" in event &&
            event.kind === "user-message",
        ).length ?? 0,
    })),
    states.map((status, index) => ({
      status,
      first: { kind: "user-message", text: `state input ${index}` },
      userMessageCount: 1,
    })),
  );
  assert.deepEqual(projected.at(-1)?.session?.timeline, [
    { kind: "agent-message", text: "Legacy result only" },
  ]);
  dispose();
  await liveView.close();
});

test("live view preserves exact user text while redacting agent-produced paths", async () => {
  const userInput =
    "Use C:\\literal-user\\token.txt\nwith token sk-user-literal\t🙂";
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 2,
    commands: [
      {
        commandId: "hidden-command-id",
        runtime: "codex",
        status: "completed",
        input: userInput,
        session: {
          sessionId: "hidden-session-id",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [
            {
              kind: "agent-message",
              text: "Native C:\\private\\ledger.sqlite and /private/ledger.sqlite",
            },
          ],
        },
      },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Visible Project"),
  });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });

  const dispose = liveView.observe(resolveFirst);
  const result = await firstResult;
  const timeline = (
    result as {
      readonly ok: true;
      readonly view: {
        readonly commands: readonly {
          readonly session?: { readonly timeline: readonly unknown[] };
        }[];
      };
    }
  ).view.commands[0]?.session?.timeline;

  assert.deepEqual(timeline, [
    { kind: "user-message", text: userInput },
    { kind: "agent-message", text: "Native [path] and [path]" },
  ]);
  assert.deepEqual(Object.keys(timeline?.[0] ?? {}).sort(), ["kind", "text"]);
  assert.equal(Object.isFrozen(timeline?.[0]), true);

  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("C:\\\\private"), false);
  assert.equal(serialized.includes("/private/ledger.sqlite"), false);
  assert.equal(serialized.includes("[path]"), true);
  dispose();
  await liveView.close();
});

test("live view keeps code comments readable while still redacting real paths", async () => {
  const agentText = [
    "```js",
    "// 主进程 main.js",
    "const { app } = require('electron') /* entry */",
    "app.whenReady() // 输出: ready",
    "```",
    "Docs at https://example.com/docs/start.",
    "Never expose /home/user/.ssh/id_rsa, C:\\Users\\someone\\secret.txt,",
    "\\\\fileserver\\share\\payroll.xlsx, //fileserver/share/payroll.xlsx,",
    "or file:///C:/Users/someone/token.key.",
  ].join("\n");
  const expectedText = [
    "```js",
    "// 主进程 main.js",
    "const { app } = require('electron') /* entry */",
    "app.whenReady() // 输出: ready",
    "```",
    "Docs at https://example.com/docs/start.",
    "Never expose [path] [path]",
    "[path] [path]",
    "or [path]",
  ].join("\n");
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 2,
    commands: [
      {
        commandId: "hidden-command-id",
        runtime: "codex",
        status: "completed",
        input: "show the preload wiring",
        session: {
          sessionId: "hidden-session-id",
          ...defaultSessionMetadata,
          profile: { ...profile },
          resumable: false,
          events: [{ kind: "agent-message", text: agentText }],
        },
      },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Visible Project"),
  });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });

  const dispose = liveView.observe(resolveFirst);
  const result = await firstResult;
  const timeline = (
    result as {
      readonly ok: true;
      readonly view: {
        readonly commands: readonly {
          readonly session?: { readonly timeline: readonly unknown[] };
        }[];
      };
    }
  ).view.commands[0]?.session?.timeline;

  assert.deepEqual(timeline?.[1], {
    kind: "agent-message",
    text: expectedText,
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("id_rsa"), false, "POSIX path must redact");
  assert.equal(serialized.includes("secret.txt"), false, "drive path must redact");
  assert.equal(serialized.includes("payroll.xlsx"), false, "UNC paths must redact");
  assert.equal(serialized.includes("token.key"), false, "file URL must redact");
  dispose();
  await liveView.close();
});

test("live view enforces the exact public user-input policy", async () => {
  const exactBoundary = `${"x".repeat(7_998)}🙂`;
  assert.equal(exactBoundary.length, 8_000);
  const valid = [
    { name: "exactly 8,000 UTF-16 code units", value: exactBoundary },
    { name: "allowed whitespace and a paired surrogate", value: "  line one\t\r\n🙂  " },
  ];
  for (const [index, row] of valid.entries()) {
    const channel = new ControlledProjectChannel({
      projectId: "hidden-project-id",
      cursor: index + 1,
      commands: [
        {
          commandId: `valid-user-input-${index}`,
          runtime: "codex",
          status: "completed",
          input: row.value,
          session: {
            sessionId: `valid-user-session-${index}`,
            ...defaultSessionMetadata,
            profile: { ...profile },
            resumable: false,
            events: [],
          },
        },
      ],
    });
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: join(tmpdir(), `Valid User Input ${index}`),
    });
    let dispose: () => void = () => undefined;
    const first = new Promise<unknown>((resolve) => {
      dispose = liveView.observe(resolve);
    });
    const result = await first;
    assert.equal((result as { readonly ok: boolean }).ok, true, row.name);
    assert.equal(
      (
        result as {
          readonly ok: true;
          readonly view: {
            readonly commands: readonly {
              readonly session?: {
                readonly timeline: readonly { readonly text?: string }[];
              };
            }[];
          };
        }
      ).view.commands[0]?.session?.timeline[0]?.text,
      row.value,
      row.name,
    );
    dispose();
    await liveView.close();
  }

  const invalid = [
    { name: "8,001 code units", value: "x".repeat(8_001) },
    { name: "whitespace only", value: " \t\r\n " },
    { name: "forbidden C0 control", value: "before\u000bafter" },
    { name: "DEL", value: "before\u007fafter" },
    { name: "C1 control", value: "before\u0085after" },
    { name: "unpaired high surrogate", value: "before\ud800after" },
    { name: "unpaired low surrogate", value: "before\udc00after" },
  ];
  for (const [index, row] of invalid.entries()) {
    const channel = new ControlledProjectChannel({
      projectId: "hidden-project-id",
      cursor: index + 20,
      commands: [
        {
          commandId: `invalid-user-input-${index}`,
          runtime: "codex",
          status: "completed",
          input: row.value,
          session: {
            sessionId: `invalid-user-session-${index}`,
            ...defaultSessionMetadata,
            profile: { ...profile },
            resumable: false,
            events: [],
          },
        },
      ],
    });
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: join(tmpdir(), `Invalid User Input ${index}`),
    });
    let dispose: () => void = () => undefined;
    const first = new Promise<unknown>((resolve) => {
      dispose = liveView.observe(resolve);
    });
    assert.deepEqual(
      await first,
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      row.name,
    );
    dispose();
    await liveView.close();
  }
});

test("live view close awaits asynchronous iterator cancellation after disposal", async () => {
  const channel = new ControlledProjectChannel(
    {
      projectId: "hidden-project-id",
      cursor: 0,
      commands: [],
    },
    [],
    true,
  );
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Cancellation Project"),
  });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });
  const dispose = liveView.observe(resolveFirst);
  await firstResult;
  await channel.observationCaughtUp();

  dispose();
  dispose();
  let closeResolved = false;
  const close = liveView.close().then(() => {
    closeResolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(channel.observeReturnCalls, 1);
  assert.equal(closeResolved, false);
  channel.releaseReturn();
  await close;
  assert.equal(closeResolved, true);
});

test("live view maps observation after close to the one fixed public failure", async () => {
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 0,
    commands: [],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Closed Project"),
  });
  await liveView.close();
  const results: unknown[] = [];

  const dispose = liveView.observe((result) => results.push(result));

  assert.deepEqual(results, [
    {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  ]);
  assert.deepEqual(channel.observeCalls, []);
  dispose();
  dispose();
});

test("live view rejects duplicate durable command identity with fixed public copy", async () => {
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 0,
    commands: [
      { commandId: "duplicate-id", runtime: "codex", status: "accepted" },
      { commandId: "duplicate-id", runtime: "codex", status: "completed" },
    ],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Malformed Project"),
  });
  let resolveFirst!: (value: unknown) => void;
  const firstResult = new Promise<unknown>((resolve) => {
    resolveFirst = resolve;
  });

  liveView.observe(resolveFirst);
  const result = await firstResult;

  assert.deepEqual(result, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(JSON.stringify(result).includes("duplicate-id"), false);
  assert.deepEqual(channel.observeCalls, []);
  await liveView.close();
});

test("live view ends malformed cursor observation with one fixed failure", async () => {
  const channel = new ControlledProjectChannel(
    {
      projectId: "hidden-project-id",
      cursor: 1,
      commands: [],
    },
    [
      {
        cursor: 3,
        commandId: "hidden-command-id",
        kind: "accepted",
        status: "accepted",
        nativePayload: "PRIVATE_NATIVE_BODY",
      } as never,
    ],
  );
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Cursor Project"),
  });
  const results: unknown[] = [];
  let resolveFailure!: () => void;
  const failed = new Promise<void>((resolve) => {
    resolveFailure = resolve;
  });
  liveView.observe((result) => {
    results.push(result);
    if (!result.ok) resolveFailure();
  });
  await failed;

  assert.deepEqual(results, [
    {
      ok: true,
      view: {
        project: { label: "Cursor Project" },
        observation: { cursor: 1, live: true },
        commands: [],
        initialSelectionKey: null,
      },
    },
    {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  ]);
  assert.equal(JSON.stringify(results).includes("PRIVATE_NATIVE_BODY"), false);
  assert.equal(channel.observeReturnCalls, 1);
  await liveView.close();
});

test("basename identity strips controls and directional overrides", () => {
  assert.equal(
    deriveProjectLabel(join(tmpdir(), "Safe\u202e\u0007 Project")),
    "Safe Project",
  );
});

test("unexpected channel completion revokes the live view with fixed failure", async () => {
  const channel = new ControlledProjectChannel({
    projectId: "hidden-project-id",
    cursor: 0,
    commands: [],
  });
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Closing Channel Project"),
  });
  const results: unknown[] = [];
  liveView.observe((result) => results.push(result));
  await channel.observationCaughtUp();

  await channel.close();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(results, [
    {
      ok: true,
      view: {
        project: { label: "Closing Channel Project" },
        observation: { cursor: 0, live: true },
        commands: [],
        initialSelectionKey: null,
      },
    },
    {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  ]);
  await liveView.close();
});

test("pre-snapshot disposal releases promptly without retaining the listener", async () => {
  const channel = new DeferredSnapshotChannel();
  const liveView = createWorkbenchLiveView({
    channel,
    projectDirectory: join(tmpdir(), "Pending Snapshot Project"),
  });
  const results: unknown[] = [];
  const dispose = liveView.observe((result) => results.push(result));
  await channel.snapshotStarted();

  dispose();
  dispose();
  let closeResolved = false;
  const close = liveView.close().then(() => {
    closeResolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(closeResolved, true);
  assert.deepEqual(results, []);
  assert.equal(channel.observeCalls, 0);
  channel.releaseSnapshot();
  await close;
  await Promise.resolve();
  assert.deepEqual(results, []);
});
