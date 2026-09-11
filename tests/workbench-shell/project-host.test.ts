import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { type TestContext } from "node:test";

import { hostedProjectView } from "./w26-hosted-project-view.ts";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import type { ProjectTurnActivity } from "../../src/coordinator/index.ts";
import {
  createWorkbenchBackend,
  type WorkbenchBackend,
} from "../../src/workbench-shell/backend.ts";
import type {
  WorkbenchDirectInputRequest,
  WorkbenchDirectSessionProfileDefaultRequest,
  WorkbenchDirectSessionProfileLoadRequest,
  WorkbenchHostedProjectResult,
  WorkbenchProjectListener,
} from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchProjectHost,
  type WorkbenchProjectBackendFactory,
} from "../../src/workbench-shell/project-host.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

async function createRegisteredWorkbenchProjectHost(
  context: TestContext,
  options: Parameters<typeof createWorkbenchProjectHost>[0],
) {
  const host = await createWorkbenchProjectHost(options);
  registerTestClosable(context, host);
  return host;
}

const isolatedProfile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const isolatedCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: isolatedProfile.model,
      displayName: isolatedProfile.model,
      effortLevels: Object.freeze([isolatedProfile.effortLevel]),
      effortLevelLabels: Object.freeze([isolatedProfile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const isolatedTerminalEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({
    kind: "item-started" as const,
    itemType: "agent-message" as const,
  }),
  Object.freeze({
    kind: "item-completed" as const,
    itemType: "agent-message" as const,
  }),
  Object.freeze({
    kind: "agent-message" as const,
    text: "A bounded public completion.",
  }),
  Object.freeze({
    kind: "turn-completed" as const,
    status: "completed" as const,
  }),
]);

class IsolatedLedgerAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  readonly starts: Array<RuntimeStart & { readonly capability: string }> = [];
  readonly resumes: RuntimeResume[] = [];
  readonly inputs: Array<RuntimeInput & { readonly projectDirectory: string }> = [];
  private readonly recoveryProjectDirectory: string;

  constructor(recoveryProjectDirectory: string) {
    this.recoveryProjectDirectory = recoveryProjectDirectory;
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return structuredClone(isolatedCatalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    const capability = `private-isolated-capability-${this.starts.length + 1}`;
    this.starts.push({ ...structuredClone(request), capability });
    return this.binding(
      request.projectDirectory,
      request.profile,
      capability,
      request.projectDirectory === this.recoveryProjectDirectory,
    );
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return this.binding(
      request.projectDirectory,
      request.profile,
      request.opaqueSessionReference,
      false,
    );
  }

  private binding(
    projectDirectory: string,
    profile: SessionProfile,
    capability: string,
    recoveryBarrier: boolean,
  ): ResumableRuntimeBinding {
    const adapter = this;
    return {
      profile: structuredClone(profile),
      opaqueSessionReference: capability,
      async send(input: RuntimeInput): Promise<void> {
        adapter.inputs.push({
          ...structuredClone(input),
          projectDirectory,
        });
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        if (recoveryBarrier) {
          yield { kind: "session-started" };
          return;
        }
        for (const event of isolatedTerminalEvents) {
          yield structuredClone(event);
        }
      },
    };
  }
}

function runtimeCounts(adapter: IsolatedLedgerAdapter): {
  readonly inspect: number;
  readonly start: number;
  readonly resume: number;
  readonly send: number;
} {
  return Object.freeze({
    inspect: adapter.inspectCalls,
    start: adapter.starts.length,
    resume: adapter.resumes.length,
    send: adapter.inputs.length,
  });
}

class RecordingBackendFactory {
  active = 0;
  maximumActive = 0;
  profileLoads = 0;
  readonly profileLoadRequests: WorkbenchDirectSessionProfileLoadRequest[] = [];
  defaultSaves = 0;
  submissions = 0;
  turnActivity: ProjectTurnActivity = "idle";
  readonly events: string[] = [];
  readonly failOpenDirectories = new Set<string>();
  readonly failNextCloseDirectories = new Set<string>();
  holdProfileLoads = false;
  private releaseHeldProfile!: () => void;
  private markProfileStarted!: () => void;
  readonly heldProfile = new Promise<void>((resolve) => {
    this.releaseHeldProfile = resolve;
  });
  readonly profileStarted = new Promise<void>((resolve) => {
    this.markProfileStarted = resolve;
  });

  releaseProfileLoad(): void {
    this.releaseHeldProfile();
  }
  readonly opened: Array<{
    readonly projectDirectory: string;
    readonly databasePath: string;
  }> = [];

  readonly create: WorkbenchProjectBackendFactory = async (options) => {
    const owner = this;
    if (this.failOpenDirectories.has(options.projectDirectory)) {
      this.events.push(
        `open-failed:${options.projectDirectory.split(/[\\/]/u).at(-1) ?? "Project"}`,
      );
      throw new Error("PRIVATE_BACKEND_OPEN_FAILURE");
    }
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.opened.push({
      projectDirectory: options.projectDirectory,
      databasePath: options.databasePath,
    });
    const label = options.projectDirectory.split(/[\\/]/u).at(-1) ?? "Project";
    this.events.push(`open:${label}`);
    let closed = false;
    return Object.freeze({
      observeProject(listener: WorkbenchProjectListener) {
        listener({
          ok: true,
          view: {
            project: {
              label,
            },
            observation: { cursor: 0, live: true },
            commands: [],
            initialSelectionKey: null,
          },
        });
        return () => undefined;
      },
      readTurnActivity() {
        return owner.turnActivity;
      },
      async loadDirectSessionProfile(
        request: WorkbenchDirectSessionProfileLoadRequest = Object.freeze({
          kind: "catalog-default",
        }),
      ) {
        owner.profileLoads += 1;
        owner.profileLoadRequests.push(request);
        if (owner.holdProfileLoads) {
          owner.markProfileStarted();
          await owner.heldProfile;
        }
        return {
          ok: false as const,
          endpointDiscovery: {
            statuses: [
              {
                endpointId: "codex-desktop" as const,
                category: "not-inspected" as const,
              },
              {
                endpointId: "claude-code-desktop" as const,
                category: "not-inspected" as const,
              },
            ] as const,
          },
          error: {
            category: "profile-unavailable" as const,
            message:
              "Codex Session Profile options are unavailable. Keep your draft and try again." as const,
          },
        };
      },
      async useDirectSessionProfileAsDefault(
        _request: WorkbenchDirectSessionProfileDefaultRequest,
      ) {
        owner.defaultSaves += 1;
        throw new Error("DEFAULT_MUST_NOT_SAVE");
      },
      async submitDirectInput(_request: WorkbenchDirectInputRequest) {
        owner.submissions += 1;
        throw new Error("INPUT_MUST_NOT_SEND");
      },
      async close() {
        if (closed) return;
        if (owner.failNextCloseDirectories.delete(options.projectDirectory)) {
          owner.events.push(`close-failed:${label}`);
          throw new Error("PRIVATE_BACKEND_CLOSE_FAILURE");
        }
        closed = true;
        // The factory is the only owner of the one-open counter.
        owner.active -= 1;
        owner.events.push(`close:${label}`);
      },
    } satisfies WorkbenchBackend);
  };
}

function observeFirst(
  host: Awaited<ReturnType<typeof createWorkbenchProjectHost>>,
): Promise<WorkbenchHostedProjectResult> {
  return new Promise((resolve) => {
    const dispose = host.observeProject((result) => {
      dispose();
      resolve(result);
    });
  });
}

function observeHost(
  host: Awaited<ReturnType<typeof createWorkbenchProjectHost>>,
): {
  readonly results: WorkbenchHostedProjectResult[];
  readonly dispose: () => void;
  readonly waitFor: (
    predicate: (result: WorkbenchHostedProjectResult) => boolean,
  ) => Promise<WorkbenchHostedProjectResult>;
} {
  const results: WorkbenchHostedProjectResult[] = [];
  const waiters = new Set<{
    readonly predicate: (result: WorkbenchHostedProjectResult) => boolean;
    readonly resolve: (result: WorkbenchHostedProjectResult) => void;
  }>();
  const dispose = host.observeProject((result) => {
    results.push(result);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result)) continue;
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  });
  return {
    results,
    dispose,
    waitFor(predicate) {
      const existing = [...results].reverse().find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

test("Project host projects exact selected-backend activity and fails closed while unsafe", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const projectDirectory = join(root, "Turn Activity Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    backendFactory: factory.create,
  });

  assert.equal(host.readTurnActivity(), "idle");
  factory.turnActivity = "accepted";
  assert.equal(host.readTurnActivity(), "accepted");
  factory.turnActivity = "in-flight";
  assert.equal(host.readTurnActivity(), "in-flight");
  factory.turnActivity = "unknown";
  assert.equal(host.readTurnActivity(), "unknown");

  factory.turnActivity = "idle";
  factory.holdProfileLoads = true;
  const profileLoad = host.loadDirectSessionProfile({ kind: "catalog-default" });
  await factory.profileStarted;
  assert.equal(host.readTurnActivity(), "unknown");
  factory.releaseProfileLoad();
  await profileLoad;
  assert.equal(host.readTurnActivity(), "idle");

  const unavailableFactory = new RecordingBackendFactory();
  unavailableFactory.failOpenDirectories.add(projectDirectory);
  const unavailableHost = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory: join(root, "unavailable-private-data"),
    fallbackProjectDirectory: projectDirectory,
    backendFactory: unavailableFactory.create,
  });
  assert.equal(unavailableHost.readTurnActivity(), "unknown");
  await unavailableHost.close();

  const close = host.close();
  assert.equal(host.readTurnActivity(), "unknown");
  await close;
  assert.equal(host.readTurnActivity(), "unknown");
});

test("an empty registry opens one trusted fallback and same-directory registration is idempotent", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const projectDirectory = join(root, "Visible Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);
  const localFactory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    backendFactory: localFactory.create,
  });

  const observation = observeHost(host);
  const first = await observation.waitFor((result) => result.ok);
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail("Expected an opened fallback Project.");
  assert.deepEqual(hostedProjectView(first).projectSelection.projects.map((project) => ({
    label: project.label,
    availability: project.availability,
    selected: project.selected,
    fields: Object.keys(project).sort(),
  })), [{
    label: "Visible Project",
    availability: "available",
    selected: true,
    fields: ["availability", "label", "selected", "selectionKey"],
  }]);
  assert.match(
    hostedProjectView(first).projectSelection.projects[0]?.selectionKey ?? "",
    /^project-selection:/u,
  );
  assert.equal(localFactory.active, 1);
  assert.equal(localFactory.maximumActive, 1);
  assert.equal(localFactory.opened.length, 1);

  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);
  const observationCountBefore = observation.results.length;
  const idempotent = await host.registerTrustedProject(projectDirectory);
  const committedAfter = await readFile(registryPath);
  assert.deepEqual(idempotent, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.deepEqual(committedAfter, committedBefore);
  assert.equal(localFactory.opened.length, 1);
  assert.equal(localFactory.maximumActive, 1);
  assert.equal(observation.results.length, observationCountBefore + 1);
  assert.equal(observation.results.at(-1)?.ok, true);

  const serialized = JSON.stringify({ first, idempotent });
  assert.equal(serialized.includes(projectDirectory), false);
  assert.equal(serialized.includes(dataDirectory), false);
  assert.equal(/recordKey|ledgerSlot|databasePath|canonicalDirectory/u.test(serialized), false);
  observation.dispose();
  await host.close();
  assert.equal(localFactory.active, 0);
});

test("trusted registration and opaque selection serialize close-before-open and durably reopen one duplicate label", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "first", "Shared Name");
  const secondDirectory = join(root, "second", "Shared Name");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  const first = await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  assert.equal(first.ok, true);

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  const publishedBeforeResolution = observation.results.at(-1);
  assert.equal(publishedBeforeResolution?.ok, true);
  if (!publishedBeforeResolution?.ok || !("view" in publishedBeforeResolution)) {
    assert.fail("Expected the target Project view before registration resolved.");
  }
  assert.equal(
    publishedBeforeResolution.view.projectSelection.projects.length,
    2,
  );
  assert.equal(
    publishedBeforeResolution.view.projectSelection.projects[1]?.selected,
    true,
  );
  const second = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true,
  );
  if (!second.ok) assert.fail("Expected the second selected Project view.");
  assert.deepEqual(
    hostedProjectView(second).projectSelection.projects.map((project) => ({
      label: project.label,
      availability: project.availability,
      selected: project.selected,
    })),
    [
      { label: "Shared Name", availability: "available", selected: false },
      { label: "Shared Name", availability: "available", selected: true },
    ],
  );
  const firstSelectionKey = hostedProjectView(second).projectSelection.projects[0]!.selectionKey;
  const staleSecondSelectionKey = hostedProjectView(second).projectSelection.projects[1]!.selectionKey;
  assert.notEqual(firstSelectionKey, staleSecondSelectionKey);
  assert.equal(factory.maximumActive, 1);
  assert.deepEqual(factory.events, [
    "open:Shared Name",
    "close:Shared Name",
    "open:Shared Name",
  ]);
  assert.notEqual(factory.opened[0]?.databasePath, factory.opened[1]?.databasePath);

  assert.deepEqual(await host.selectProject({ selectionKey: firstSelectionKey }), {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  const selectedFirstAgain = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[0]?.selected === true,
  );
  if (!selectedFirstAgain.ok) assert.fail("Expected the first Project again.");
  assert.notEqual(
    hostedProjectView(selectedFirstAgain).projectSelection.projects[1]?.selectionKey,
    staleSecondSelectionKey,
  );
  const callsBeforeStale = {
    opened: factory.opened.length,
    events: factory.events.length,
  };
  assert.deepEqual(
    await host.selectProject({ selectionKey: staleSecondSelectionKey }),
    {
      ok: false,
      error: {
        category: "invalid-project-selection",
        message: "Reload the Project list and choose an available Project.",
      },
    },
  );
  assert.deepEqual(
    { opened: factory.opened.length, events: factory.events.length },
    callsBeforeStale,
  );
  assert.deepEqual(
    {
      profileLoads: factory.profileLoads,
      defaultSaves: factory.defaultSaves,
      submissions: factory.submissions,
    },
    { profileLoads: 0, defaultSaves: 0, submissions: 0 },
  );
  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);

  const restartedFactory = new RecordingBackendFactory();
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: secondDirectory,
    backendFactory: restartedFactory.create,
  });
  const restartedView = await observeFirst(restarted);
  if (!restartedView.ok) assert.fail("Expected the durable selected Project.");
  assert.deepEqual(
    hostedProjectView(restartedView).projectSelection.projects.map((project) => ({
      label: project.label,
      selected: project.selected,
    })),
    [
      { label: "Shared Name", selected: true },
      { label: "Shared Name", selected: false },
    ],
  );
  assert.equal(restartedFactory.opened.length, 1);
  assert.equal(
    restartedFactory.opened[0]?.databasePath,
    factory.opened[0]?.databasePath,
  );
  assert.equal(restartedFactory.maximumActive, 1);
  await restarted.close();
});

test("a stalled availability probe becomes unreadable without blocking Project operations", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-availability-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const thirdDirectory = join(root, "Third Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await mkdir(thirdDirectory);

  const factory = new RecordingBackendFactory();
  let stallFirstProject = false;
  let releaseStalledProbes!: () => void;
  const stalledProbes = new Promise<void>((resolve) => {
    releaseStalledProbes = resolve;
  });
  registerTestCleanup(t, () => releaseStalledProbes());
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    availabilityProbeTimeoutMilliseconds: 25,
    availabilityProbe: async (directory) => {
      if (stallFirstProject && directory === firstDirectory) {
        await stalledProbes;
      }
      return "available";
    },
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );

  stallFirstProject = true;
  const registration = host.registerTrustedProject(secondDirectory);
  let testDeadline: ReturnType<typeof setTimeout> | undefined;
  const firstOutcome = await Promise.race([
    registration.finally(() => {
      if (testDeadline !== undefined) clearTimeout(testDeadline);
    }),
    new Promise<"test-deadline">((resolve) => {
      testDeadline = setTimeout(() => resolve("test-deadline"), 1_000);
    }),
  ]);
  if (firstOutcome === "test-deadline") {
    const blockedFollowUp = await host.registerTrustedProject(thirdDirectory);
    assert.notEqual(
      firstOutcome,
      "test-deadline",
      `the original open stayed pending and the follow-up returned ${JSON.stringify(blockedFollowUp)}`,
    );
  }
  assert.deepEqual(firstOutcome, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });

  const secondView = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true,
  );
  if (!secondView.ok) assert.fail("Expected the second Project view.");
  assert.deepEqual(
    hostedProjectView(secondView).projectSelection.projects.map((project) => ({
      label: project.label,
      availability: project.availability,
      selected: project.selected,
    })),
    [
      { label: "First Project", availability: "unreadable", selected: false },
      { label: "Second Project", availability: "available", selected: true },
    ],
  );

  const firstSelectionKey = hostedProjectView(secondView).projectSelection.projects[0]!.selectionKey;
  assert.deepEqual(await host.selectProject({ selectionKey: firstSelectionKey }), {
    ok: false,
    error: {
      category: "project-unavailable",
      message:
        "This Project is unavailable. Choose another Project or restore its directory.",
    },
  });

  assert.deepEqual(await host.registerTrustedProject(thirdDirectory), {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  const thirdView = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 3 &&
      result.view.projectSelection.projects[2]?.selected === true,
  );
  if (!thirdView.ok) assert.fail("Expected the third Project view.");
  assert.equal(
    hostedProjectView(thirdView).projectSelection.projects[0]?.availability,
    "unreadable",
  );
  assert.equal(factory.maximumActive, 1);
  observation.dispose();
});

test("changed trusted registration waits for its first sanitized target projection", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);

  const factory = new RecordingBackendFactory();
  let releaseTargetObservation!: () => void;
  let markTargetObservationAttached!: () => void;
  const targetObservationReleased = new Promise<void>((resolve) => {
    releaseTargetObservation = resolve;
  });
  const targetObservationAttached = new Promise<void>((resolve) => {
    markTargetObservationAttached = resolve;
  });
  registerTestCleanup(t, () => releaseTargetObservation());
  const publicationOrder: string[] = [];
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: async (options) => {
      const backend = await factory.create(options);
      if (options.projectDirectory !== secondDirectory) return backend;
      return Object.freeze({
        observeProject(listener: WorkbenchProjectListener) {
          let disposed = false;
          let disposeObservation: () => void = () => undefined;
          markTargetObservationAttached();
          void targetObservationReleased.then(() => {
            if (disposed) return;
            disposeObservation = backend.observeProject(listener);
          });
          return () => {
            disposed = true;
            disposeObservation();
          };
        },
        readTurnActivity: backend.readTurnActivity,
        loadDirectSessionProfile: backend.loadDirectSessionProfile,
        useDirectSessionProfileAsDefault:
          backend.useDirectSessionProfileAsDefault,
        submitDirectInput: backend.submitDirectInput,
        close: backend.close,
      } satisfies WorkbenchBackend);
    },
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );

  let registrationSettled = false;
  const registration = host.registerTrustedProject(secondDirectory).then(
    (result) => {
      registrationSettled = true;
      publicationOrder.push("registration-resolved");
      return result;
    },
  );
  await targetObservationAttached;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.readTurnActivity(), "unknown");
  assert.equal(registrationSettled, false);
  assert.equal(
    observation.results.some(
      (result) =>
        result.ok && "view" in result && result.view.projectSelection.projects.length === 2,
    ),
    false,
  );

  releaseTargetObservation();
  const target = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true,
  );
  publicationOrder.push("target-published");
  assert.equal(target.ok, true);
  assert.deepEqual(await registration, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.deepEqual(publicationOrder, [
    "target-published",
    "registration-resolved",
  ]);
  assert.equal(factory.maximumActive, 1);
  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);
});

test("a terminally failed first target projection cannot report successful registration", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);

  const factory = new RecordingBackendFactory();
  let targetOpenCalls = 0;
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: async (options) => {
      const backend = await factory.create(options);
      if (options.projectDirectory !== secondDirectory) return backend;
      targetOpenCalls += 1;
      if (targetOpenCalls > 1) return backend;
      return Object.freeze({
        observeProject(listener: WorkbenchProjectListener) {
          listener({
            ok: false,
            error: {
              category: "project-view-unavailable",
              message: "Live Project data is unavailable.",
            },
          });
          return () => undefined;
        },
        readTurnActivity: backend.readTurnActivity,
        loadDirectSessionProfile: backend.loadDirectSessionProfile,
        useDirectSessionProfileAsDefault:
          backend.useDirectSessionProfileAsDefault,
        submitDirectInput: backend.submitDirectInput,
        close: backend.close,
      } satisfies WorkbenchBackend);
    },
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  assert.equal(
    observation.results.some((result) => result.ok === false),
    true,
  );
  assert.equal(targetOpenCalls, 1);

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.equal(targetOpenCalls, 2);
  await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true,
  );
  assert.equal(factory.maximumActive, 1);

  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);
});

test("restart keeps an unavailable durable selection visible and never substitutes the fallback", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "Available Project");
  const missingDirectory = join(root, "Missing Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(missingDirectory);

  const initialFactory = new RecordingBackendFactory();
  const initial = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: initialFactory.create,
  });
  const initialObservation = observeHost(initial);
  await initialObservation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  assert.equal((await initial.registerTrustedProject(missingDirectory)).ok, true);
  await initialObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true,
  );
  initialObservation.dispose();
  await initial.close();
  await rm(missingDirectory, { recursive: true, force: true });

  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);
  const restartedFactory = new RecordingBackendFactory();
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: restartedFactory.create,
  });
  const observation = observeHost(restarted);
  const unavailable = await observation.waitFor((result) => {
    if (!result.ok) return false;
    const selected = hostedProjectView(result).projectSelection.projects.find(
      (project) => project.selected,
    );
    return selected?.availability === "missing";
  });
  if (!unavailable.ok) assert.fail("Expected the unavailable Project list.");
  assert.equal(restartedFactory.opened.length, 0);
  assert.equal(hostedProjectView(unavailable).project.label, "Missing Project");
  const availableOption = hostedProjectView(unavailable).projectSelection.projects[0]!;
  const missingOption = hostedProjectView(unavailable).projectSelection.projects[1]!;
  assert.deepEqual(
    hostedProjectView(unavailable).projectSelection.projects.map((project) => ({
      label: project.label,
      availability: project.availability,
      selected: project.selected,
    })),
    [
      {
        label: "Available Project",
        availability: "available",
        selected: false,
      },
      {
        label: "Missing Project",
        availability: "missing",
        selected: true,
      },
    ],
  );
  assert.deepEqual(
    await restarted.selectProject({ selectionKey: missingOption.selectionKey }),
    {
      ok: false,
      error: {
        category: "project-unavailable",
        message:
          "This Project is unavailable. Choose another Project or restore its directory.",
      },
    },
  );
  assert.deepEqual(await readFile(registryPath), committedBefore);
  assert.equal(restartedFactory.opened.length, 0);

  assert.equal(
    (await restarted.selectProject({
      selectionKey: availableOption.selectionKey,
    })).ok,
    true,
  );
  await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[0]?.selected === true,
  );
  assert.equal(restartedFactory.opened.length, 1);
  assert.equal(restartedFactory.maximumActive, 1);
  observation.dispose();
  await restarted.close();
});

test("a failed registry commit closes the candidate and restores the prior Project without rewriting", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  let replacements = 0;
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
    atomicReplace: async (replacementPath, destinationPath) => {
      replacements += 1;
      if (replacements === 2) throw new Error("PRIVATE_REPLACE_FAILURE");
      await rename(replacementPath, destinationPath);
    },
  });
  const observation = observeHost(host);
  const initial = await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  if (!initial.ok) assert.fail("Expected the initial Project.");
  const initialSelectionKey =
    hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  const restored = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 1 &&
      result.view.projectSelection.projects[0]?.selectionKey !==
        initialSelectionKey,
  );
  assert.equal(restored.ok, true);
  assert.deepEqual(await readFile(registryPath), committedBefore);
  assert.equal(factory.maximumActive, 1);
  assert.equal(factory.active, 1);
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close:First Project",
    "open:Second Project",
    "close:Second Project",
    "open:First Project",
  ]);
  assert.equal(factory.opened.length, 3);
  assert.equal(
    factory.opened[0]?.databasePath,
    factory.opened[2]?.databasePath,
  );
  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);
});

test("malformed numeric tokens and ambiguous private rows fail closed without rewriting bounded artifacts", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const projectDirectory = join(root, "Visible Project");
  await mkdir(projectDirectory);
  const record = {
    recordKey:
      "project-record-v1-00000000-0000-4000-8000-000000000001",
    canonicalDirectory: projectDirectory,
    ledgerSlot:
      "project-ledger-v1-00000000-0000-4000-8000-000000000002",
  };
  const valid = {
    schemaVersion: 1,
    revision: 1,
    nextProjectOrdinal: 2,
    selectedRecordKey: record.recordKey,
    records: [record],
  };
  const validJson = JSON.stringify(valid);
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["schema-string", JSON.stringify({ ...valid, schemaVersion: "1" })],
    ["schema-decimal-token", validJson.replace('"schemaVersion":1', '"schemaVersion":1.0')],
    ["schema-exponent-token", validJson.replace('"schemaVersion":1', '"schemaVersion":1e0')],
    ["schema-boolean", JSON.stringify({ ...valid, schemaVersion: true })],
    ["schema-null", JSON.stringify({ ...valid, schemaVersion: null })],
    ["schema-array", JSON.stringify({ ...valid, schemaVersion: [1] })],
    ["schema-object", JSON.stringify({ ...valid, schemaVersion: { value: 1 } })],
    ["schema-unsupported", JSON.stringify({ ...valid, schemaVersion: 2 })],
    ["revision-string", JSON.stringify({ ...valid, revision: "1" })],
    ["revision-decimal-token", validJson.replace('"revision":1', '"revision":1.0')],
    ["revision-exponent-token", validJson.replace('"revision":1', '"revision":1e0')],
    ["revision-fractional", JSON.stringify({ ...valid, revision: 1.5 })],
    ["revision-negative", JSON.stringify({ ...valid, revision: -1 })],
    [
      "revision-overflow",
      validJson.replace('"revision":1', '"revision":9007199254740992'),
    ],
    ["revision-null", JSON.stringify({ ...valid, revision: null })],
    [
      "ordinal-decimal-token",
      validJson.replace('"nextProjectOrdinal":2', '"nextProjectOrdinal":2.0'),
    ],
    [
      "ordinal-exponent-token",
      validJson.replace('"nextProjectOrdinal":2', '"nextProjectOrdinal":2e0'),
    ],
    ["ordinal-string", JSON.stringify({ ...valid, nextProjectOrdinal: "2" })],
    ["ordinal-too-small", JSON.stringify({ ...valid, nextProjectOrdinal: 1 })],
    ["selected-unknown", JSON.stringify({ ...valid, selectedRecordKey: "project-record-v1-00000000-0000-4000-8000-000000000099" })],
    ["record-extra", JSON.stringify({ ...valid, records: [{ ...record, extra: true }] })],
    ["record-key-malformed", JSON.stringify({ ...valid, records: [{ ...record, recordKey: "private-record" }] })],
    ["ledger-slot-malformed", JSON.stringify({ ...valid, records: [{ ...record, ledgerSlot: "private-ledger" }] })],
    ["duplicate-record-key", JSON.stringify({ ...valid, nextProjectOrdinal: 3, records: [record, { ...record, canonicalDirectory: join(root, "Other Project"), ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000003" }] })],
    ["duplicate-ledger-slot", JSON.stringify({ ...valid, nextProjectOrdinal: 3, records: [record, { ...record, recordKey: "project-record-v1-00000000-0000-4000-8000-000000000003", canonicalDirectory: join(root, "Other Project") }] })],
    ["duplicate-directory", JSON.stringify({ ...valid, nextProjectOrdinal: 3, records: [record, { ...record, recordKey: "project-record-v1-00000000-0000-4000-8000-000000000003", ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000003" }] })],
    ["duplicate-root-field", validJson.replace('"revision":1', '"revision":1,"revision":1')],
    ["truncated", `${validJson.slice(0, -2)}`],
    ["oversized", " ".repeat(256 * 1024 + 1)],
  ];

  for (const [name, contents] of cases) {
    const dataDirectory = join(root, `private-${name}`);
    await mkdir(dataDirectory);
    const statePath = join(dataDirectory, "project-registry-v1.json");
    const replacementPath = join(
      dataDirectory,
      "project-registry-v1.replacement",
    );
    const backupPath = join(dataDirectory, "project-registry-v1.backup");
    await writeFile(statePath, contents, "utf8");
    await writeFile(replacementPath, `replacement-${name}`, "utf8");
    await writeFile(backupPath, `backup-${name}`, "utf8");
    const before = await Promise.all(
      [statePath, replacementPath, backupPath].map((path) => readFile(path)),
    );
    const factory = new RecordingBackendFactory();
    const host = await createRegisteredWorkbenchProjectHost(t, {
      dataDirectory,
      fallbackProjectDirectory: projectDirectory,
      backendFactory: factory.create,
    });
    const result = await observeFirst(host);
    assert.deepEqual(result, {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    }, name);
    const after = await Promise.all(
      [statePath, replacementPath, backupPath].map((path) => readFile(path)),
    );
    assert.deepEqual(after, before, name);
    assert.equal(factory.opened.length, 0, name);
    assert.equal(JSON.stringify(result).includes(name), false, name);
    await host.close();
  }
});

test("a pending Project action blocks switching and terminal close waits for the action", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  assert.equal((await host.registerTrustedProject(secondDirectory)).ok, true);
  const selectedSecond = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true,
  );
  if (!selectedSecond.ok) assert.fail("Expected the second Project.");
  assert.equal(
    (await host.selectProject({
      selectionKey:
        hostedProjectView(selectedSecond).projectSelection.projects[0]!.selectionKey,
    })).ok,
    true,
  );
  const selectedFirst = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[0]?.selected === true,
  );
  if (!selectedFirst.ok) assert.fail("Expected the first Project.");
  const secondSelectionKey =
    hostedProjectView(selectedFirst).projectSelection.projects[1]!.selectionKey;
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);
  const callsBefore = {
    opened: factory.opened.length,
    events: factory.events.length,
  };

  factory.holdProfileLoads = true;
  const replacementRequest = Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-4",
    sourceSnapshotCursor: 12,
  });
  const profileLoad = host.loadDirectSessionProfile(replacementRequest);
  await factory.profileStarted;
  assert.deepEqual(await host.selectProject({ selectionKey: secondSelectionKey }), {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  assert.deepEqual(
    { opened: factory.opened.length, events: factory.events.length },
    callsBefore,
  );
  assert.deepEqual(await readFile(registryPath), committedBefore);

  let closeSettled = false;
  const close = host.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  factory.releaseProfileLoad();
  assert.equal((await profileLoad).ok, false);
  await close;
  assert.equal(closeSettled, true);
  assert.equal(factory.active, 0);
  assert.equal(factory.profileLoads, 1);
  assert.deepEqual(factory.profileLoadRequests, [replacementRequest]);
  observation.dispose();
});

test("terminal close joins an in-progress open and rejects concurrent or post-close switches before a registry write", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const factory = new RecordingBackendFactory();
  let releaseSecondOpen!: () => void;
  let markSecondOpenStarted!: () => void;
  const secondOpenReleased = new Promise<void>((resolve) => {
    releaseSecondOpen = resolve;
  });
  const secondOpenStarted = new Promise<void>((resolve) => {
    markSecondOpenStarted = resolve;
  });
  registerTestCleanup(t, () => releaseSecondOpen());
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: async (options) => {
      if (options.projectDirectory === secondDirectory) {
        markSecondOpenStarted();
        await secondOpenReleased;
      }
      return factory.create(options);
    },
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);

  const switching = host.registerTrustedProject(secondDirectory);
  await secondOpenStarted;
  let closeSettled = false;
  const closing = host.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.deepEqual(
    await host.registerTrustedProject(secondDirectory),
    {
      ok: false,
      error: {
        category: "project-switch-unavailable",
        message:
          "The Project could not be opened. Keep the current Project and try again.",
      },
    },
  );
  assert.deepEqual(
    await host.selectProject({
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000000",
    }),
    {
      ok: false,
      error: {
        category: "project-switch-unavailable",
        message:
          "The Project could not be opened. Keep the current Project and try again.",
      },
    },
  );
  assert.deepEqual(await readFile(registryPath), committedBefore);

  releaseSecondOpen();
  assert.deepEqual(await switching, {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  await closing;
  assert.equal(closeSettled, true);
  assert.deepEqual(await readFile(registryPath), committedBefore);
  assert.equal(factory.active, 0);
  assert.equal(factory.maximumActive, 1);
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close:First Project",
    "open:Second Project",
    "close:Second Project",
  ]);
  observation.dispose();
});

test("target open failure restores the prior Project and preserves the durable selection", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  const initial = await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  if (!initial.ok) assert.fail("Expected the initial Project.");
  const originalSelectionKey =
    hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);
  factory.failOpenDirectories.add(secondDirectory);

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  const restored = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 1 &&
      result.view.projectSelection.projects[0]?.selectionKey !==
        originalSelectionKey,
  );
  assert.equal(restored.ok, true);
  assert.deepEqual(await readFile(registryPath), committedBefore);
  assert.equal(factory.maximumActive, 1);
  assert.equal(factory.active, 1);
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close:First Project",
    "open-failed:Second Project",
    "open:First Project",
  ]);
  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);
});

test("a prior backend close failure fails fixed without opening a second Project", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);
  factory.failNextCloseDirectories.add(firstDirectory);

  assert.deepEqual(await host.registerTrustedProject(secondDirectory), {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  await observation.waitFor((result) => !result.ok);
  assert.equal(host.readTurnActivity(), "unknown");
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close-failed:First Project",
  ]);
  assert.equal(factory.opened.length, 1);
  assert.equal(factory.active, 1);
  assert.equal(factory.maximumActive, 1);
  assert.deepEqual(await readFile(registryPath), committedBefore);
  assert.equal((await host.loadDirectSessionProfile({ kind: "catalog-default" })).ok, false);
  assert.equal(
    (
      await host.submitDirectInput(
        { input: "PRIVATE_INPUT" } as unknown as WorkbenchDirectInputRequest,
      )
    ).ok,
    false,
  );
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close-failed:First Project",
  ]);

  observation.dispose();
  await host.close();
  assert.equal(factory.active, 0);
  assert.deepEqual(factory.events, [
    "open:First Project",
    "close-failed:First Project",
    "close:First Project",
  ]);
});

test("rename-then-throw is reconciled as committed and restart cleans bounded replacement artifacts", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  let promotions = 0;
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
    atomicReplace: async (replacementPath, destinationPath) => {
      promotions += 1;
      await rename(replacementPath, destinationPath);
      throw new Error("PRIVATE_OUTCOME_UNKNOWN_AFTER_PROMOTION");
    },
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  assert.equal((await host.registerTrustedProject(secondDirectory)).ok, true);
  const selectedSecond = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true,
  );
  assert.equal(selectedSecond.ok, true);
  assert.equal(promotions, 2);
  observation.dispose();
  await host.close();

  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const replacementPath = join(
    dataDirectory,
    "project-registry-v1.replacement",
  );
  const backupPath = join(dataDirectory, "project-registry-v1.backup");
  const committed = await readFile(registryPath);
  await writeFile(replacementPath, "PRIVATE_INTERRUPTED_REPLACEMENT", "utf8");
  await writeFile(backupPath, "PRIVATE_REPLACE_BACKUP", "utf8");
  const restartedFactory = new RecordingBackendFactory();
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: restartedFactory.create,
  });
  const reopened = await observeFirst(restarted);
  if (!reopened.ok) assert.fail("Expected the committed selected Project.");
  assert.equal(hostedProjectView(reopened).project.label, "Second Project");
  assert.deepEqual(await readFile(registryPath), committed);
  await assert.rejects(readFile(replacementPath), { code: "ENOENT" });
  await assert.rejects(readFile(backupPath), { code: "ENOENT" });
  assert.equal(restartedFactory.opened.length, 1);
  await restarted.close();

  const emptyDataDirectory = join(root, "private-empty");
  await mkdir(emptyDataDirectory);
  const emptyReplacementPath = join(
    emptyDataDirectory,
    "project-registry-v1.replacement",
  );
  await writeFile(
    emptyReplacementPath,
    "PRIVATE_UNCOMMITTED_REPLACEMENT",
    "utf8",
  );
  const emptyFactory = new RecordingBackendFactory();
  const emptyHost = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory: emptyDataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: emptyFactory.create,
  });
  assert.equal((await observeFirst(emptyHost)).ok, true);
  await assert.rejects(readFile(emptyReplacementPath), { code: "ENOENT" });
  await emptyHost.close();
});

test("a failed explicit startup registration safely restores the previously selected Project", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const firstFactory = new RecordingBackendFactory();
  const firstHost = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: firstFactory.create,
  });
  await observeFirst(firstHost);
  await firstHost.close();
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const committedBefore = await readFile(registryPath);

  const restartedFactory = new RecordingBackendFactory();
  restartedFactory.failOpenDirectories.add(secondDirectory);
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    startupProjectDirectory: secondDirectory,
    backendFactory: restartedFactory.create,
  });
  const reopened = await observeFirst(restarted);
  if (!reopened.ok) assert.fail("Expected the prior selected Project.");
  assert.equal(hostedProjectView(reopened).project.label, "First Project");
  assert.equal(restartedFactory.active, 1);
  assert.equal(restartedFactory.maximumActive, 1);
  assert.deepEqual(restartedFactory.events, [
    "open-failed:Second Project",
    "open:First Project",
  ]);
  assert.deepEqual(await readFile(registryPath), committedBefore);
  await restarted.close();
});

test("an explicit trusted startup directory registers once and becomes the durable selected Project", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "first", "Shared Name");
  const secondDirectory = join(root, "second", "Shared Name");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });

  const firstFactory = new RecordingBackendFactory();
  const first = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: firstFactory.create,
  });
  await observeFirst(first);
  await first.close();

  const explicitFactory = new RecordingBackendFactory();
  const explicit = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    startupProjectDirectory: secondDirectory,
    backendFactory: explicitFactory.create,
  });
  const explicitView = await observeFirst(explicit);
  if (!explicitView.ok) assert.fail("Expected the explicit startup Project.");
  assert.deepEqual(
    hostedProjectView(explicitView).projectSelection.projects.map((project) => ({
      label: project.label,
      selected: project.selected,
    })),
    [
      { label: "Shared Name", selected: false },
      { label: "Shared Name", selected: true },
    ],
  );
  assert.equal(explicitFactory.opened.length, 1);
  assert.equal(
    explicitFactory.opened[0]?.projectDirectory,
    secondDirectory,
  );
  await explicit.close();

  const durableFactory = new RecordingBackendFactory();
  const durable = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: durableFactory.create,
  });
  const durableView = await observeFirst(durable);
  if (!durableView.ok) assert.fail("Expected the durable startup selection.");
  assert.equal(
    hostedProjectView(durableView).projectSelection.projects[1]?.selected,
    true,
  );
  assert.equal(durableFactory.opened[0]?.projectDirectory, secondDirectory);
  assert.equal(durableFactory.maximumActive, 1);
  await durable.close();
});

test("a replace-backup without committed state fails closed and preserves every artifact byte", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const projectDirectory = join(root, "Visible Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);
  await mkdir(dataDirectory);
  const backupPath = join(dataDirectory, "project-registry-v1.backup");
  const replacementPath = join(
    dataDirectory,
    "project-registry-v1.replacement",
  );
  await writeFile(backupPath, "PRIVATE_ORPHANED_BACKUP", "utf8");
  await writeFile(replacementPath, "PRIVATE_ORPHANED_REPLACEMENT", "utf8");
  const before = await Promise.all([
    readFile(backupPath),
    readFile(replacementPath),
  ]);
  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    backendFactory: factory.create,
  });
  assert.deepEqual(await observeFirst(host), {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.deepEqual(
    await Promise.all([readFile(backupPath), readFile(replacementPath)]),
    before,
  );
  assert.equal(factory.opened.length, 0);
  await host.close();
});

test("two same-basename Projects keep real ledgers, Sessions, timelines, capabilities, selection, and recovery barriers isolated", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-"));
  const firstDirectory = join(root, "first", "Shared Name");
  const secondDirectory = join(root, "second", "Shared Name");
  const dataDirectory = join(root, "private-data");
  const firstInstruction = "private first Project instruction";
  const secondRecoveryInstruction =
    "private second Project recovery instruction";
  const firstContinuation = "private first Project continuation";
  const firstRestartContinuation =
    "private first Project restart continuation";
  const firstTimeline = [
    { kind: "user-message", text: firstInstruction },
    ...isolatedTerminalEvents,
  ];
  const continuedFirstTimeline = [
    ...firstTimeline,
    { kind: "user-message", text: firstContinuation },
    ...isolatedTerminalEvents,
  ];
  const secondRecoveryTimeline = [
    { kind: "user-message", text: secondRecoveryInstruction },
  ];
  const finalFirstTimeline = [
    ...continuedFirstTimeline,
    { kind: "user-message", text: firstRestartContinuation },
    ...isolatedTerminalEvents,
  ];
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(secondDirectory, { recursive: true });
  const adapter = new IsolatedLedgerAdapter(secondDirectory);
  let activeBackends = 0;
  let maximumActiveBackends = 0;
  const opened: Array<{
    readonly projectDirectory: string;
    readonly databasePath: string;
  }> = [];
  const realBackendFactory: WorkbenchProjectBackendFactory = async (options) => {
    const backend = await createWorkbenchBackend(options);
    activeBackends += 1;
    maximumActiveBackends = Math.max(
      maximumActiveBackends,
      activeBackends,
    );
    opened.push({
      projectDirectory: options.projectDirectory,
      databasePath: options.databasePath,
    });
    let closed = false;
    return Object.freeze({
      observeProject: backend.observeProject,
      readTurnActivity: backend.readTurnActivity,
      loadDirectSessionProfile: backend.loadDirectSessionProfile,
      useDirectSessionProfileAsDefault:
        backend.useDirectSessionProfileAsDefault,
      submitDirectInput: backend.submitDirectInput,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await backend.close();
        } finally {
          activeBackends -= 1;
        }
      },
    } satisfies WorkbenchBackend);
  };
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: realBackendFactory,
    adapter,
  });
  const observation = observeHost(host);
  const emptyFirst = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.project.label === "Shared Name" &&
      result.view.projectSelection.projects.length === 1 &&
      result.view.commands.length === 0,
  );
  if (!emptyFirst.ok) assert.fail("Expected the first empty Project.");
  assert.deepEqual(runtimeCounts(adapter), {
    inspect: 0,
    start: 0,
    resume: 0,
    send: 0,
  });

  const firstProfile = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!firstProfile.ok) assert.fail("Expected the first Project profile.");
  const firstEndpoint = firstProfile.profile.endpoints[0]!;
  const firstModel = firstEndpoint.models[0]!;
  const firstIntensity = firstModel.workIntensities[0]!;
  assert.equal(
    (
      await host.submitDirectInput({
        kind: "start",
        input: firstInstruction,
        snapshotKey: firstProfile.profile.snapshotKey,
        endpointKey: firstEndpoint.key,
        modelKey: firstModel.key,
        workIntensityKey: firstIntensity.key,
        executionModeKey: firstEndpoint.executionModes[0]!.key,
        accessModeKey: firstEndpoint.accessModes[0]!.key,
      })
    ).ok,
    true,
  );
  const firstCompleted = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands.length === 1 &&
      result.view.commands[0]?.status === "completed",
  );
  if (!firstCompleted.ok) assert.fail("Expected the first completed Session.");
  assert.equal(hostedProjectView(firstCompleted).initialSelectionKey, "command-1");
  assert.deepEqual(
    hostedProjectView(firstCompleted).commands[0]?.session?.timeline,
    firstTimeline,
  );
  const firstCapability = adapter.starts[0]!.capability;

  const beforeRegisterSwitch = runtimeCounts(adapter);
  assert.equal((await host.registerTrustedProject(secondDirectory)).ok, true);
  const emptySecond = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true &&
      result.view.commands.length === 0,
  );
  if (!emptySecond.ok) assert.fail("Expected the second empty Project.");
  assert.deepEqual(runtimeCounts(adapter), beforeRegisterSwitch);
  assert.equal(maximumActiveBackends, 1);
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0]?.databasePath, opened[1]?.databasePath);
  assert.equal((await stat(opened[0]!.databasePath)).isFile(), true);
  assert.equal((await stat(opened[1]!.databasePath)).isFile(), true);

  const secondProfile = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!secondProfile.ok) assert.fail("Expected the second Project profile.");
  const secondEndpoint = secondProfile.profile.endpoints[0]!;
  const secondModel = secondEndpoint.models[0]!;
  const secondIntensity = secondModel.workIntensities[0]!;
  assert.equal(
    (
      await host.submitDirectInput({
        kind: "start",
        input: secondRecoveryInstruction,
        snapshotKey: secondProfile.profile.snapshotKey,
        endpointKey: secondEndpoint.key,
        modelKey: secondModel.key,
        workIntensityKey: secondIntensity.key,
        executionModeKey: secondEndpoint.executionModes[0]!.key,
        accessModeKey: secondEndpoint.accessModes[0]!.key,
      })
    ).ok,
    true,
  );
  const secondBarrier = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true &&
      result.view.commands[0]?.status === "recovery-required",
  );
  if (!secondBarrier.ok) assert.fail("Expected the isolated recovery barrier.");
  assert.equal(hostedProjectView(secondBarrier).initialSelectionKey, "command-1");
  assert.equal(hostedProjectView(secondBarrier).commands.length, 1);
  assert.deepEqual(
    hostedProjectView(secondBarrier).commands[0]?.session?.timeline,
    secondRecoveryTimeline,
  );
  assert.deepEqual(
    await host.removeProject({
      selectionKey:
        hostedProjectView(secondBarrier).projectSelection.projects[1]!.selectionKey,
    }),
    { status: "blocked", activity: "unknown" },
    "a recovery-required real ledger must make Project removal fail closed",
  );
  const selectFirstKey =
    hostedProjectView(secondBarrier).projectSelection.projects[0]!.selectionKey;

  const beforeFirstReturn = runtimeCounts(adapter);
  assert.equal(
    (await host.selectProject({ selectionKey: selectFirstKey })).ok,
    true,
  );
  const returnedFirst = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[0]?.selected === true &&
      result.view.commands[0]?.status === "completed",
  );
  if (!returnedFirst.ok) assert.fail("Expected the first Project ledger.");
  assert.deepEqual(runtimeCounts(adapter), beforeFirstReturn);
  assert.equal(hostedProjectView(returnedFirst).commands.length, 1);
  assert.equal(hostedProjectView(returnedFirst).initialSelectionKey, "command-1");
  assert.deepEqual(
    hostedProjectView(returnedFirst).commands[0]?.session?.timeline,
    firstTimeline,
  );
  const firstContinuationKey =
    hostedProjectView(returnedFirst).commands[0]?.session?.selectionKey;
  assert.match(firstContinuationKey ?? "", /^session-selection:/u);
  if (typeof firstContinuationKey !== "string") {
    assert.fail("Expected a resumable first Session.");
  }
  const firstContinuationProfile = await host.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey: firstContinuationKey,
  });
  if (!firstContinuationProfile.ok) {
    assert.fail("Expected a current continuation profile capability.");
  }
  const firstContinuationPrefill =
    firstContinuationProfile.profile.continuationPrefill;
  assert.equal(
    (
      await host.submitDirectInput({
        kind: "continue",
        input: firstContinuation,
        selectionKey: firstContinuationKey,
        snapshotKey: firstContinuationProfile.profile.snapshotKey,
        endpointKey: firstContinuationPrefill.endpointKey,
        modelKey: firstContinuationPrefill.modelKey,
        workIntensityKey: firstContinuationPrefill.workIntensityKey,
        executionModeKey: firstContinuationPrefill.executionModeKey,
        accessModeKey: firstContinuationPrefill.accessModeKey,
      })
    ).ok,
    true,
  );
  const continuedFirst = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[0]?.selected === true &&
      result.view.commands[0]?.session?.timeline.length ===
        continuedFirstTimeline.length,
  );
  if (!continuedFirst.ok) assert.fail("Expected the continued first Session.");
  assert.deepEqual(
    hostedProjectView(continuedFirst).commands[0]?.session?.timeline,
    continuedFirstTimeline,
  );
  assert.equal(adapter.resumes.length, 2);
  assert.equal(adapter.resumes[0]?.projectDirectory, secondDirectory, "only the second Project's unknown turn needed a resume check");
  assert.equal(adapter.resumes[0]?.opaqueSessionReference, adapter.starts[1]?.capability);
  assert.equal(adapter.resumes[1]?.projectDirectory, firstDirectory);
  assert.equal(adapter.resumes[1]?.opaqueSessionReference, firstCapability);
  assert.deepEqual(adapter.inputs.filter(input => input.projectDirectory === secondDirectory).map(input => input.text), [secondRecoveryInstruction],
    "checking the second Project must not send its input again");

  const firstDatabasePath = opened.find(
    (entry) => entry.projectDirectory === firstDirectory,
  )!.databasePath;
  const secondDatabasePath = opened.find(
    (entry) => entry.projectDirectory === secondDirectory,
  )!.databasePath;
  observation.dispose();
  const beforeClose = runtimeCounts(adapter);
  await host.close();
  assert.deepEqual(runtimeCounts(adapter), beforeClose);
  assert.equal(activeBackends, 0);

  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: secondDirectory,
    backendFactory: realBackendFactory,
    adapter,
  });
  const restartedObservation = observeHost(restarted);
  const restartedFirst = await restartedObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[0]?.selected === true &&
      result.view.commands[0]?.session?.timeline.length ===
        continuedFirstTimeline.length,
  );
  if (!restartedFirst.ok) assert.fail("Expected the durable first Project.");
  assert.deepEqual(
    hostedProjectView(restartedFirst).commands[0]?.session?.timeline,
    continuedFirstTimeline,
  );
  assert.deepEqual(runtimeCounts(adapter), beforeClose);
  assert.equal(opened.at(-1)?.databasePath, firstDatabasePath);
  const selectSecondKey =
    hostedProjectView(restartedFirst).projectSelection.projects[1]!.selectionKey;

  const beforeSecondReturn = runtimeCounts(adapter);
  assert.equal(
    (await restarted.selectProject({ selectionKey: selectSecondKey })).ok,
    true,
  );
  const restartedSecond = await restartedObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[1]?.selected === true &&
      result.view.commands[0]?.status === "recovery-required",
  );
  if (!restartedSecond.ok) assert.fail("Expected the durable second barrier.");
  assert.deepEqual(runtimeCounts(adapter), beforeSecondReturn);
  assert.equal(opened.at(-1)?.databasePath, secondDatabasePath);
  assert.equal(
    (await restarted.loadDirectSessionProfile({ kind: "catalog-default" })).ok,
    true,
    "the failed turn must survive restart without poisoning its Project profile picker",
  );
  assert.deepEqual(runtimeCounts(adapter), {
    ...beforeSecondReturn,
    inspect: beforeSecondReturn.inspect + 1,
  });
  assert.equal(hostedProjectView(restartedSecond).commands.length, 1);
  assert.deepEqual(
    hostedProjectView(restartedSecond).commands[0]?.session?.timeline,
    secondRecoveryTimeline,
  );

  const secondRestartCounts = runtimeCounts(adapter);
  const staleFirstProjectSelectionKey =
    hostedProjectView(restartedFirst).projectSelection.projects[0]!.selectionKey;
  const selectFirstAgainKey =
    hostedProjectView(restartedSecond).projectSelection.projects[0]!.selectionKey;
  assert.equal(
    (
      await restarted.selectProject({
        selectionKey: selectFirstAgainKey,
      })
    ).ok,
    true,
  );
  const finalFirst = await restartedObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects[0]?.selected === true &&
      result.view.projectSelection.projects[0]?.selectionKey !==
        staleFirstProjectSelectionKey &&
      result.view.commands[0]?.session?.timeline.length ===
        continuedFirstTimeline.length,
  );
  if (!finalFirst.ok) assert.fail("Expected the first Project after restart.");
  assert.deepEqual(
    hostedProjectView(finalFirst).commands[0]?.session?.timeline,
    continuedFirstTimeline,
  );
  assert.deepEqual(runtimeCounts(adapter), secondRestartCounts);
  assert.equal(opened.at(-1)?.databasePath, firstDatabasePath);
  const restartedContinuationKey =
    hostedProjectView(finalFirst).commands[0]?.session?.selectionKey;
  if (typeof restartedContinuationKey !== "string") {
    assert.fail("Expected a durable resumable first Session.");
  }
  const restartedContinuationProfile =
    await restarted.loadDirectSessionProfile({
      kind: "continuation-session",
      selectionKey: restartedContinuationKey,
    });
  if (!restartedContinuationProfile.ok) {
    assert.fail("Expected a restarted continuation profile capability.");
  }
  const restartedContinuationPrefill =
    restartedContinuationProfile.profile.continuationPrefill;
  assert.equal(
    (
      await restarted.submitDirectInput({
        kind: "continue",
        input: firstRestartContinuation,
        selectionKey: restartedContinuationKey,
        snapshotKey: restartedContinuationProfile.profile.snapshotKey,
        endpointKey: restartedContinuationPrefill.endpointKey,
        modelKey: restartedContinuationPrefill.modelKey,
        workIntensityKey: restartedContinuationPrefill.workIntensityKey,
        executionModeKey: restartedContinuationPrefill.executionModeKey,
        accessModeKey: restartedContinuationPrefill.accessModeKey,
      })
    ).ok,
    true,
  );
  const finalContinued = await restartedObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.session?.timeline.length ===
        finalFirstTimeline.length,
  );
  if (!finalContinued.ok) assert.fail("Expected durable continuation after restart.");
  assert.deepEqual(
    hostedProjectView(finalContinued).commands[0]?.session?.timeline,
    finalFirstTimeline,
  );
  assert.equal(adapter.resumes.length, 3);
  assert.equal(adapter.resumes[2]?.projectDirectory, firstDirectory);
  assert.equal(adapter.resumes[2]?.opaqueSessionReference, firstCapability);
  assert.equal(maximumActiveBackends, 1);
  assert.deepEqual(runtimeCounts(adapter), {
    inspect: 7,
    start: 2,
    resume: 3,
    send: 4,
  });

  const publicBoundary = JSON.stringify({
    emptyFirst,
    firstCompleted,
    emptySecond,
    secondBarrier,
    returnedFirst,
    continuedFirst,
    restartedFirst,
    restartedSecond,
    finalFirst,
    finalContinued,
  });
  for (const forbidden of [
    firstDirectory,
    secondDirectory,
    dataDirectory,
    firstDatabasePath,
    secondDatabasePath,
    firstCapability,
    "recordKey",
    "ledgerSlot",
    "canonicalDirectory",
    "databasePath",
    "commandId",
    "sessionId",
    "opaqueSessionReference",
  ]) {
    assert.equal(publicBoundary.includes(forbidden), false, forbidden);
  }
  restartedObservation.dispose();
  await restarted.close();
  assert.equal(activeBackends, 0);
});

test("removing a Project forgets only its registry reference and stays removed after restart", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-removal-"));
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const dataDirectory = join(root, "private-data");
  const sourceSentinel = join(firstDirectory, "owner-source-must-survive.txt");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await writeFile(sourceSentinel, "OWNER_SOURCE_SURVIVES_PROJECT_REMOVAL\n", "utf8");

  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: factory.create,
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  assert.equal((await host.registerTrustedProject(secondDirectory)).ok, true);
  const selectedSecond = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true,
  );
  if (!selectedSecond.ok) assert.fail("Expected the second Project selection.");
  const firstSelectionKey =
    hostedProjectView(selectedSecond).projectSelection.projects[0]!.selectionKey;

  assert.deepEqual(
    await host.removeProject({ selectionKey: firstSelectionKey }),
    { status: "removed" },
  );
  const oneRemaining = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.projectSelection.projects.length === 1 &&
      result.view.projectSelection.projects[0]?.label === "Second Project",
  );
  assert.equal(oneRemaining.ok, true);
  assert.equal((await stat(sourceSentinel)).isFile(), true);
  observation.dispose();
  await host.close();

  const restartedFactory = new RecordingBackendFactory();
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    backendFactory: restartedFactory.create,
  });
  const restartedView = await observeFirst(restarted);
  if (!restartedView.ok) assert.fail("Expected the remaining Project after restart.");
  assert.deepEqual(
    hostedProjectView(restartedView).projectSelection.projects.map((project) => project.label),
    ["Second Project"],
  );
  assert.equal((await stat(sourceSentinel)).isFile(), true);
  await restarted.close();
});

test("a real Session hard delete refreshes the already-attached host observation at the same cursor", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-host-session-removal-"));
  const projectDirectory = join(root, "Removal Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);

  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    adapter: new IsolatedLedgerAdapter(join(root, "never-recovery")),
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.commands.length === 0,
  );
  const loaded = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!loaded.ok) assert.fail("Expected one direct Session profile.");
  const endpoint = loaded.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const intensity = model.workIntensities[0]!;
  assert.equal(
    (
      await host.submitDirectInput({
        kind: "start",
        input: "Create one removable host Session.",
        snapshotKey: loaded.profile.snapshotKey,
        endpointKey: endpoint.key,
        modelKey: model.key,
        workIntensityKey: intensity.key,
        executionModeKey: endpoint.executionModes[0]!.key,
        accessModeKey: endpoint.accessModes[0]!.key,
      })
    ).ok,
    true,
  );
  const completed = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands.length === 1 &&
      result.view.commands[0]?.status === "completed",
  );
  if (!completed.ok) assert.fail("Expected one completed Session.");
  const removalKey = hostedProjectView(completed).commands[0]?.session?.removalKey;
  assert.ok(removalKey !== undefined);
  const terminalCursor = hostedProjectView(completed).observation.cursor;

  assert.deepEqual(await host.removeSession({ removalKey }), { status: "removed" });
  const refreshed = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands.length === 0 &&
      result.view.observation.cursor === terminalCursor,
  );
  assert.equal(refreshed.ok, true);

  const replayed = await observeFirst(host);
  assert.equal(replayed.ok && "view" in replayed && replayed.view.commands.length === 0, true);
  observation.dispose();
  await host.close();
});

test("real host rename, archive, restart, restore, and D16 delete use rotating opaque capabilities", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-host-session-metadata-"));
  const projectDirectory = join(root, "Metadata Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);

  const adapter = new IsolatedLedgerAdapter(join(root, "never-recovery"));
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    adapter,
  });
  const observation = observeHost(host);
  await observation.waitFor(
    (result) => result.ok && "view" in result && result.view.commands.length === 0,
  );
  const loaded = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!loaded.ok) assert.fail("Expected one synthetic Session profile.");
  const endpoint = loaded.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  assert.equal(
    (
      await host.submitDirectInput({
        kind: "start",
        input: "Create one synthetic metadata Session.",
        snapshotKey: loaded.profile.snapshotKey,
        endpointKey: endpoint.key,
        modelKey: model.key,
        workIntensityKey: model.workIntensities[0]!.key,
        executionModeKey: endpoint.executionModes[0]!.key,
        accessModeKey: endpoint.accessModes[0]!.key,
      })
    ).ok,
    true,
  );
  const completed = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.status === "completed",
  );
  if (!completed.ok) assert.fail("Expected one completed synthetic Session.");
  const initialCommand = hostedProjectView(completed).commands[0]!;
  assert.ok(initialCommand.session);
  const terminalCursor = hostedProjectView(completed).observation.cursor;
  const initialMetadataKey = initialCommand.session.metadataKey;
  const initialTimeline = structuredClone(initialCommand.session.timeline);

  assert.deepEqual(
    await host.mutateSessionMetadata({
      metadataKey: initialMetadataKey,
      operation: { kind: "rename", displayName: "  Cafe\u0301 工程  " },
    }),
    { status: "renamed" },
  );
  const renamed = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.observation.cursor === terminalCursor &&
      result.view.commands[0]?.label === "Café 工程",
  );
  if (!renamed.ok) assert.fail("Expected the renamed same-cursor projection.");
  const renamedSession = hostedProjectView(renamed).commands[0]!.session!;
  assert.notEqual(renamedSession.metadataKey, initialMetadataKey);
  assert.deepEqual(
    await host.mutateSessionMetadata({
      metadataKey: initialMetadataKey,
      operation: { kind: "archive" },
    }),
    { status: "not-found" },
    "a stale capability never targets durable identity",
  );

  assert.deepEqual(
    await host.mutateSessionMetadata({
      metadataKey: renamedSession.metadataKey,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  const archived = await observation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.session?.archived === true,
  );
  if (!archived.ok) assert.fail("Expected one archived same-cursor projection.");
  const archivedCommand = hostedProjectView(archived).commands[0]!;
  assert.equal(hostedProjectView(archived).initialSelectionKey, archivedCommand.key);
  assert.equal(archivedCommand.session?.resumable, false);
  assert.equal(archivedCommand.session?.selectionKey, null);
  assert.deepEqual(archivedCommand.session?.timeline, initialTimeline);
  observation.dispose();
  await host.close();

  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    adapter,
  });
  const restartObservation = observeHost(restarted);
  const hydrated = await restartObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.session?.archived === true,
  );
  if (!hydrated.ok) assert.fail("Expected durable archived hydration.");
  const hydratedCommand = hostedProjectView(hydrated).commands[0]!;
  assert.equal(hydratedCommand.label, "Café 工程");
  assert.deepEqual(hydratedCommand.session?.timeline, initialTimeline);

  assert.deepEqual(
    await restarted.mutateSessionMetadata({
      metadataKey: hydratedCommand.session!.metadataKey,
      operation: { kind: "restore" },
    }),
    { status: "restored" },
  );
  const restored = await restartObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.session?.archived === false,
  );
  if (!restored.ok) assert.fail("Expected the restored Session.");
  const restoredCommand = hostedProjectView(restored).commands[0]!;
  assert.equal(restoredCommand.label, "Café 工程");
  assert.equal(restoredCommand.session?.resumable, true);
  assert.deepEqual(restoredCommand.session?.timeline, initialTimeline);

  assert.deepEqual(
    await restarted.mutateSessionMetadata({
      metadataKey: restoredCommand.session!.metadataKey,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  const archivedAgain = await restartObservation.waitFor(
    (result) =>
      result.ok && "view" in result && result.view.commands[0]?.session?.archived === true &&
      result.view.commands[0]?.session?.metadataKey !==
        hydratedCommand.session?.metadataKey,
  );
  if (!archivedAgain.ok) assert.fail("Expected the re-archived Session.");
  const deleteKey = hostedProjectView(archivedAgain).commands[0]!.session!.removalKey;
  assert.deepEqual(await restarted.removeSession({ removalKey: deleteKey }), {
    status: "removed",
  });
  await restartObservation.waitFor(
    (result) => result.ok && "view" in result && result.view.commands.length === 0,
  );
  restartObservation.dispose();
  await restarted.close();
});

test("removing the selected Project is blocked while its turn is active and an empty registry stays empty", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-active-project-removal-"));
  const projectDirectory = join(root, "Only Project");
  const dataDirectory = join(root, "private-data");
  const sourceSentinel = join(projectDirectory, "source-remains.txt");
  await mkdir(projectDirectory);
  await writeFile(sourceSentinel, "SOURCE_REMAINS\n", "utf8");

  const factory = new RecordingBackendFactory();
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    backendFactory: factory.create,
  });
  const initial = await observeFirst(host);
  if (!initial.ok) assert.fail("Expected the fallback Project.");
  const selectionKey = hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;

  factory.turnActivity = "in-flight";
  assert.deepEqual(await host.removeProject({ selectionKey }), {
    status: "blocked",
    activity: "in-flight",
  });
  assert.equal(factory.active, 1);
  factory.turnActivity = "idle";
  assert.deepEqual(await host.removeProject({ selectionKey }), {
    status: "removed",
  });
  assert.equal(factory.active, 0);
  assert.equal((await stat(sourceSentinel)).isFile(), true);
  await host.close();

  const restartedFactory = new RecordingBackendFactory();
  const restarted = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    backendFactory: restartedFactory.create,
  });
  assert.equal(restartedFactory.opened.length, 0);
  assert.deepEqual(await observeFirst(restarted), { ok: true, empty: true });
  assert.equal((await stat(sourceSentinel)).isFile(), true);
  await restarted.close();
});

test("removing the selected Project supersedes a stalled prior projection before reporting success", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-removal-projection-"));
  const projectDirectory = join(root, "Only Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory);

  const factory = new RecordingBackendFactory();
  let backendListener: WorkbenchProjectListener | undefined;
  let holdNextProbe = false;
  let releaseHeldProbe!: () => void;
  let markHeldProbeStarted!: () => void;
  const heldProbe = new Promise<void>((resolve) => {
    releaseHeldProbe = resolve;
  });
  const heldProbeStarted = new Promise<void>((resolve) => {
    markHeldProbeStarted = resolve;
  });
  registerTestCleanup(t, () => releaseHeldProbe());

  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
    availabilityProbe: async () => {
      if (!holdNextProbe) return "available";
      holdNextProbe = false;
      markHeldProbeStarted();
      await heldProbe;
      return "available";
    },
    backendFactory: async (options) => {
      const backend = await factory.create(options);
      return Object.freeze({
        observeProject(listener: WorkbenchProjectListener) {
          backendListener = listener;
          return backend.observeProject(listener);
        },
        readTurnActivity: backend.readTurnActivity,
        loadDirectSessionProfile: backend.loadDirectSessionProfile,
        useDirectSessionProfileAsDefault:
          backend.useDirectSessionProfileAsDefault,
        submitDirectInput: backend.submitDirectInput,
        close: backend.close,
      } satisfies WorkbenchBackend);
    },
  });
  const initial = await observeFirst(host);
  if (!initial.ok) assert.fail("Expected the initial Project projection.");
  const selectionKey = hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;

  holdNextProbe = true;
  backendListener?.({
    ok: true,
    view: {
      project: { label: "Only Project" },
      observation: { cursor: 1, live: true },
      commands: [],
      initialSelectionKey: null,
    },
  });
  await heldProbeStarted;

  const removal = host.removeProject({ selectionKey });
  const removalBeforeStaleProbeRelease = await Promise.race([
    removal,
    new Promise<"timed-out">((resolve) =>
      setTimeout(() => resolve("timed-out"), 1_000),
    ),
  ]);
  assert.deepEqual(removalBeforeStaleProbeRelease, { status: "removed" });
  assert.deepEqual(await observeFirst(host), { ok: true, empty: true });

  releaseHeldProbe();
  await host.close();
});

test("Project removal rejects stale, malformed, and widened selection requests", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-removal-invalid-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory: join(root, "private-data"),
    fallbackProjectDirectory: projectDirectory,
    backendFactory: new RecordingBackendFactory().create,
  });
  const initial = await observeFirst(host);
  if (!initial.ok) assert.fail("Expected the initial Project selection.");
  const validSelectionKey =
    hostedProjectView(initial).projectSelection.projects[0]!.selectionKey;

  for (const request of [
    {},
    { selectionKey: "" },
    { selectionKey: "project-selection:00000000-0000-4000-8000-000000000000" },
    {
      selectionKey: "project-selection:00000000-0000-4000-8000-000000000000",
      extra: true,
    },
  ]) {
    assert.deepEqual(
      await host.removeProject(request as { readonly selectionKey: string }),
      { status: "invalid-selection" },
    );
  }
  const throwingSelection = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwingSelection, "selectionKey", {
    enumerable: true,
    get() {
      throw new Error("UNTRUSTED_PROJECT_REMOVAL_ACCESSOR");
    },
  });
  assert.deepEqual(
    await host.removeProject(
      throwingSelection as unknown as { readonly selectionKey: string },
    ),
    { status: "invalid-selection" },
  );
  const hiddenExtra = { selectionKey: validSelectionKey };
  Object.defineProperty(hiddenExtra, "privatePath", {
    value: "PRIVATE_PATH",
    enumerable: false,
  });
  const symbolExtra = { selectionKey: validSelectionKey } as Record<
    PropertyKey,
    unknown
  >;
  symbolExtra[Symbol("private")] = "PRIVATE_PATH";
  const inheritedExtra = Object.create({ privatePath: "PRIVATE_PATH" }) as {
    selectionKey: string;
  };
  inheritedExtra.selectionKey = validSelectionKey;
  const accessorSelection = {} as { selectionKey: string };
  Object.defineProperty(accessorSelection, "selectionKey", {
    enumerable: true,
    get: () => validSelectionKey,
  });
  const proxiedSelection = new Proxy(
    { selectionKey: validSelectionKey },
    {},
  );
  for (const hostile of [
    hiddenExtra,
    symbolExtra,
    inheritedExtra,
    accessorSelection,
    proxiedSelection,
  ]) {
    assert.deepEqual(
      await host.removeProject(
        hostile as unknown as { readonly selectionKey: string },
      ),
      { status: "invalid-selection" },
    );
  }
  await host.close();
});

// F-w187 / public issue #5. A drive root used to fail by accident: `basename`
// of `C:\` is empty, label derivation threw, and by then `openProject` had
// already created and opened a SQLite ledger for it. The reader saw "try
// again". The refusal is now deliberate, named, and happens before anything
// touches disk. The real backend factory is used here on purpose: the claim
// "no ledger on disk" has to be measured against the code that writes ledgers.
test("a drive root is refused by name before any ledger is created for it", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-project-host-drive-root-"));
  const projectDirectory = join(root, "Real Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(projectDirectory, { recursive: true });
  const host = await createRegisteredWorkbenchProjectHost(t, {
    dataDirectory,
    fallbackProjectDirectory: projectDirectory,
  });
  const observation = observeHost(host);
  await observation.waitFor((result) => result.ok && "view" in result);
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  const ledgersBefore = (await readdir(ledgerDirectory)).filter((name) => name.endsWith(".sqlite"));
  assert.equal(ledgersBefore.length, 1, "only the fallback Project's ledger exists");

  const driveRoot = parse(root).root;
  const refusal = await host.registerTrustedProject(driveRoot);

  assert.deepEqual(refusal, {
    ok: false,
    error: {
      category: "project-directory-is-drive-root",
      message: "A drive root cannot be a Project. Choose a folder inside the drive instead.",
    },
  });
  // Nothing on disk changed: no ledger was created for the refused root, and
  // the registry still lists exactly the one Project it listed before.
  const ledgersAfter = (await readdir(ledgerDirectory)).filter((name) => name.endsWith(".sqlite"));
  assert.deepEqual(ledgersAfter, ledgersBefore);
  const published = observation.results.at(-1);
  assert.equal(published?.ok, true);
  if (!published?.ok || !("view" in published)) assert.fail("Expected the prior Project view to stand.");
  assert.equal(published.view.projectSelection.projects.length, 1);
  observation.dispose();
  await host.close();
});
